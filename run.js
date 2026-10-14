'use strict';

/**
 * Posts questions to every channel in channels.json.
 *
 * Scheduled runs (SCHEDULE set by the workflow) send whatever posts are due
 * now, waiting for each one's minute. A run started by hand (MANUAL_CHANNEL)
 * sends MANUAL_COUNT posts to that channel straight away; those use up
 * questions but not the day's post times.
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN                    the bot's token
 *   TELEGRAM_CHANNEL                      the SMLE channel (chatEnv in channels.json)
 *   FIREBASE_SERVICE_ACCOUNT              key for the smlebrain project
 *   RESIDENCY_FIREBASE_SERVICE_ACCOUNT    key for the residency-brain project
 *   SCHEDULE                              set on scheduled runs
 *   MANUAL_CHANNEL, MANUAL_COUNT          for runs started by hand
 *   SMLE_MONTH                            optional, e.g. 'Sep-26'
 *   DRY_RUN                               "true" prints instead of sending
 */

const path = require('path');
const fs = require('fs');

const { duePosts, clock, localNow } = require('./lib/schedule');
const { StateStore } = require('./lib/state');
const { Telegram } = require('./lib/telegram');
const { SmleSource } = require('./lib/smle');
const { ResidencySource } = require('./lib/residency');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'channels.json'), 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Firestore for each Firebase project, created only when a channel needs it. */
function firestoreFactory(env) {
  const apps = {};
  return (name, envName) => {
    if (!apps[name]) {
      const raw = env[envName];
      if (!raw) throw new Error(`${envName} is not set, so ${name} questions cannot be read.`);
      const admin = require('firebase-admin');
      const app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) }, name);
      apps[name] = app.firestore();
    }
    return apps[name];
  };
}

function makeSources(env, firestore) {
  const sources = {};
  return (key) => {
    if (!sources[key]) {
      const channel = config.channels[key];
      if (channel.source === 'smle') {
        sources[key] = new SmleSource(firestore('smlebrain', 'FIREBASE_SERVICE_ACCOUNT'), { month: env.SMLE_MONTH || '' });
      } else if (channel.source === 'residency') {
        // Channels on the same bank share one download.
        const shared = Object.entries(sources).find(([k]) => config.channels[k].bank === channel.bank);
        sources[key] = new ResidencySource(firestore('residency-brain', 'RESIDENCY_FIREBASE_SERVICE_ACCOUNT'), channel.bank,
          shared ? { loadBundle: () => shared[1].load() } : {});
      } else {
        throw new Error(`Channel ${key}: unknown source "${channel.source}".`);
      }
    }
    return sources[key];
  };
}

function chatFor(key, env) {
  const channel = config.channels[key];
  const chat = channel.chat || env[channel.chatEnv];
  if (!chat) throw new Error(`Channel ${key}: no chat (set "chat" or ${channel.chatEnv}).`);
  return chat;
}

/** Sends one post (questionsPerPost questions) to a channel. */
async function postOnce({ key, env, telegram, state, sourceFor, log }) {
  const channel = config.channels[key];
  const source = sourceFor(key);
  const chat = chatFor(key, env);
  const picked = await source.pick(channel.questionsPerPost, state.postedSet(key));
  for (const [i, item] of picked.entries()) {
    await source.send(telegram, chat, item);
    if (!telegram.dryRun) state.addPosted(key, item.id); // saved per question
    if (i < picked.length - 1) await sleep(1500);
  }
  log(`${key}: posted ${picked.map((q) => q.id).join(', ')}`);
}

async function run(env = process.env, { now = () => new Date(), log = console.log, wait = sleep } = {}) {
  const telegram = new Telegram(env.TELEGRAM_BOT_TOKEN, { dryRun: env.DRY_RUN === 'true', log });
  if (!telegram.dryRun && !env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set.');
  const state = new StateStore();
  const sourceFor = makeSources(env, firestoreFactory(env));
  const failures = [];

  if (env.MANUAL_CHANNEL) {
    const key = env.MANUAL_CHANNEL;
    if (!config.channels[key]) throw new Error(`No channel "${key}" in channels.json.`);
    const count = Math.max(1, Number.parseInt(env.MANUAL_COUNT || '1', 10) || 1);
    for (let i = 0; i < count; i += 1) {
      await postOnce({ key, env, telegram, state, sourceFor, log });
    }
    return;
  }

  const due = duePosts({
    channels: config.channels,
    window: config.window,
    now: now(),
    isDone: (key, date, slot) => state.isDone(key, date, slot),
  });
  if (due.length === 0) {
    log(`${localNow(config.window.timeZone, now()).date}: nothing due in this run.`);
    return;
  }
  log(`Due: ${due.map((p) => `${p.key} #${p.slot + 1} at ${clock(p.at)}`).join('; ')}`);

  for (const post of due) {
    const { minutes } = localNow(config.window.timeZone, now());
    if (post.at > minutes) await wait((post.at - minutes) * 60 * 1000);
    try {
      await postOnce({ key: post.key, env, telegram, state, sourceFor, log });
      if (!telegram.dryRun) state.markDone(post.key, post.date, post.slot);
    } catch (error) {
      // One channel failing must not stop the others. The post stays due, so
      // the next run retries it.
      failures.push(`${post.key} #${post.slot + 1}: ${error.message}`);
      log(`::error::${post.key} #${post.slot + 1}: ${String(error.message).replace(/\r?\n/g, ' ')}`);
    }
  }
  if (failures.length) throw new Error(`${failures.length} post(s) failed.`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`::error::${String(error.message).replace(/\r?\n/g, ' ')}`);
    process.exit(1);
  });
}

module.exports = { run, config };
