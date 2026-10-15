'use strict';

/**
 * Posts questions to every channel in channels.json.
 *
 * Normally runs as the day's poster (DAEMON=true): stays awake through the
 * posting window and sends every post at its minute (see daemon() below).
 * A run started by hand (MANUAL_CHANNEL) instead sends MANUAL_COUNT posts to
 * that channel straight away; those use up questions but not the day's
 * post times.
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN                    the bot's token
 *   TELEGRAM_CHANNEL                      the SMLE channel (chatEnv in channels.json)
 *   FIREBASE_SERVICE_ACCOUNT              key for the smlebrain project
 *   RESIDENCY_FIREBASE_SERVICE_ACCOUNT    key for the residency-brain project
 *   DAEMON                                "true" for the day's poster
 *   GITHUB_TOKEN, GITHUB_REPOSITORY       to start the next run (set by Actions)
 *   MANUAL_CHANNEL, MANUAL_COUNT          for runs started by hand
 *   SMLE_MONTH                            optional, e.g. 'Sep-26'
 *   DRY_RUN                               "true" prints instead of sending
 */

const path = require('path');
const fs = require('fs');

const { postTimes, clock, localNow, minutesOf, MAX_LATE } = require('./lib/schedule');
const { commitState, dispatchContinuation } = require('./lib/github');
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

async function run(env = process.env, { now = () => new Date(), log = console.log, wait = sleep, ...overrides } = {}) {
  const deps = { commit: (m) => commitState(m, log), dispatch: () => dispatchContinuation(env, log), ...overrides };
  const telegram = new Telegram(env.TELEGRAM_BOT_TOKEN, { dryRun: env.DRY_RUN === 'true', log });
  if (!telegram.dryRun && !env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set.');
  const state = new StateStore();
  const sourceFor = makeSources(env, firestoreFactory(env));
  if (env.MANUAL_CHANNEL && env.DAEMON !== 'true') {
    const key = env.MANUAL_CHANNEL;
    if (!config.channels[key]) throw new Error(`No channel "${key}" in channels.json.`);
    const count = Math.max(1, Number.parseInt(env.MANUAL_COUNT || '1', 10) || 1);
    for (let i = 0; i < count; i += 1) {
      await postOnce({ key, env, telegram, state, sourceFor, log });
    }
    return;
  }

  await daemon({ env, telegram, state, sourceFor, log, now, wait, ...deps });
}

/**
 * Stays awake through the posting window and sends each post at its minute.
 *
 * GitHub skips many scheduled runs on busy days, so the schedule only has to
 * start this once a day. A run may last at most 6 hours, so before that this
 * one starts its own replacement through the API (runs started that way are
 * not skipped) and exits. State is committed after every post, so whichever
 * run comes next picks up exactly where this one stopped.
 */
async function daemon({ env, telegram, state, sourceFor, log, now, wait, commit, dispatch }) {
  const { timeZone, to } = config.window;
  const budgetMinutes = Number(env.DAEMON_BUDGET_MINUTES || 330);
  const startedAt = now().getTime();
  const failures = new Map(); // "key#slot" -> { count, retryAt }
  const MAX_TRIES = 3;
  let gaveUp = 0;

  const isDone = (key, date, slot) => state.isDone(key, date, slot);
  const blocked = (p, at) => {
    const f = failures.get(`${p.key}#${p.slot}`);
    return f && (f.count >= MAX_TRIES || at < f.retryAt);
  };

  for (;;) {
    const current = now();
    const { date, minutes } = localNow(timeZone, current);

    // Everything still to come today (or overdue by less than MAX_LATE).
    const open = [];
    for (const [key, channel] of Object.entries(config.channels)) {
      postTimes(key, date, channel.postsPerDay, config.window).forEach((at, slot) => {
        if (isDone(key, date, slot) || minutes - at > MAX_LATE) return;
        const f = failures.get(`${key}#${slot}`);
        if (f && f.count >= MAX_TRIES) return;
        open.push({ key, slot, at, date });
      });
    }
    open.sort((x, y) => x.at - y.at);

    for (const post of open.filter((p) => p.at <= minutes && !blocked(p, current.getTime()))) {
      try {
        await postOnce({ key: post.key, env, telegram, state, sourceFor, log });
        if (!telegram.dryRun) state.markDone(post.key, post.date, post.slot);
        commit(`Posted ${post.key} #${post.slot + 1}`);
      } catch (error) {
        const f = failures.get(`${post.key}#${post.slot}`) ?? { count: 0, retryAt: 0 };
        f.count += 1;
        f.retryAt = now().getTime() + 5 * 60 * 1000;
        failures.set(`${post.key}#${post.slot}`, f);
        if (f.count >= MAX_TRIES) gaveUp += 1;
        commit(`Record posted questions (${post.key})`);
        log(`::error::${post.key} #${post.slot + 1} (try ${f.count}/${MAX_TRIES}): ${String(error.message).replace(/\r?\n/g, ' ')}`);
      }
    }

    const left = open.filter((p) => !isDone(p.key, p.date, p.slot)
      && !(failures.get(`${p.key}#${p.slot}`)?.count >= MAX_TRIES));
    if (left.length === 0 || minutes > minutesOf(to) + MAX_LATE) {
      log(`${date}: nothing more to post today.`);
      break;
    }
    if ((now().getTime() - startedAt) / 60000 >= budgetMinutes) {
      log(`Run time limit near; handing over to a new run (${left.length} post(s) left today, next at ${clock(left[0].at)}).`);
      await dispatch();
      break;
    }
    if (current.getTime() === startedAt || left[0].at - minutes > 30) {
      log(`Waiting. Next: ${left[0].key} #${left[0].slot + 1} at ${clock(left[0].at)}.`);
    }
    await wait(30 * 1000);
  }
  if (gaveUp) throw new Error(`${gaveUp} post(s) failed ${MAX_TRIES} times and were skipped today.`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`::error::${String(error.message).replace(/\r?\n/g, ' ')}`);
    process.exit(1);
  });
}

module.exports = { run, daemon, config };
