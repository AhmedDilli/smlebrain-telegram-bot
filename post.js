'use strict';

/**
 * Posts SMLE questions from one month to a Telegram channel as plain text.
 *
 * Each run:
 *   1. Takes the current month on Riyadh's calendar ('Oct-26').
 *   2. Fetches that month's questions from bankQuestions, leaving out ones
 *      already posted and ones with images. If fewer than QUESTIONS_PER_POST
 *      are left (month not uploaded yet, or used up), tries the month before,
 *      and so on back.
 *   3. Picks QUESTIONS_PER_POST of them at random.
 *   4. Sends each as one plain-text message: the case, then the four options.
 *      No header, no month, no answer.
 *   5. Records the posted itemIDs in posted.json so nothing repeats.
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN        from @BotFather
 *   TELEGRAM_CHANNEL          @yourchannel or the numeric -100... chat id
 *   FIREBASE_SERVICE_ACCOUNT  the service-account JSON, as one string
 *   QUESTIONS_PER_POST        default 3
 *   MONTH                     optional override, e.g. 'Sep-26'; empty = this month
 *   DRY_RUN                   "true" prints the messages instead of sending
 */

const fs = require('fs');
const path = require('path');

const BANK_COLLECTION = 'bankQuestions';
const MONTH_FIELD = 'Month'; // a list such as ['Sep-26', 'Oct-26']
const LOOKBACK_MONTHS = 24; // how far back to look for unposted questions
const STATE_FILE = path.join(__dirname, 'posted.json');
const TELEGRAM_LIMIT = 4096;

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const config = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  channel: process.env.TELEGRAM_CHANNEL,
  serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT,
  perPost: Math.max(1, intEnv('QUESTIONS_PER_POST', 3)),
  month: (process.env.MONTH ?? '').trim(), // e.g. 'Sep-26'; empty = this month
  dryRun: process.env.DRY_RUN === 'true',
};

/** 'Mar-25' -> a sortable month number, or null for anything else. */
function monthOrdinal(label) {
  const match = /^([A-Za-z]{3})-(\d{2})$/.exec(String(label).trim());
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (month === undefined) return null;
  return (2000 + Number(match[2])) * 12 + month;
}

function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function text(value) {
  if (typeof value === 'string') return value.trim();
  return value == null ? '' : String(value).trim();
}

function readPosted() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

function writePosted(posted) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify([...posted], null, 2)}\n`);
}

/** Text questions only: a stem, four options, and no images. */
function isPostable(data) {
  const images = Array.isArray(data.ImageUrls)
    ? data.ImageUrls.filter((url) => text(url))
    : [];
  if (images.length > 0) return false;
  return ['Question', 'A', 'B', 'C', 'D'].every((key) => text(data[key]));
}

/** The case, a blank line, then the four options. Nothing else. */
function formatQuestion(data) {
  const options = ['A', 'B', 'C', 'D']
    .map((letter) => `${letter}) ${text(data[letter])}`)
    .join('\n');
  return `${text(data.Question)}\n\n${options}`;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A month number from monthOrdinal() -> the bank's label, 'Oct-26'. */
function monthLabel(ordinal) {
  const year = String(Math.floor(ordinal / 12) % 100).padStart(2, '0');
  return `${MONTH_ABBR[ordinal % 12]}-${year}`;
}

/** This month as the bank labels it, on Riyadh's calendar: 'Oct-26'. */
function currentMonthLabel(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Riyadh',
    month: 'short',
    year: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('month')}-${get('year')}`;
}

/** [start, the month before, the one before that, ...], [count] in all. */
function monthsBackFrom(start, count) {
  const first = monthOrdinal(start);
  if (first === null) throw new Error(`MONTH must look like 'Oct-26', not '${start}'.`);
  return Array.from({ length: count }, (_, i) => monthLabel(first - i));
}

/**
 * Every question tagged with [month] that has not been posted and has no
 * images. Queries the bank directly, so a month is visible the moment it is
 * uploaded. A month holds a few hundred questions at most, which is a few
 * hundred reads a day against a free allowance of 50,000.
 */
async function postableIn(db, month, posted) {
  const snapshot = await db.collection(BANK_COLLECTION)
    .where(MONTH_FIELD, 'array-contains', month)
    .get();
  return snapshot.docs
    .map((doc) => ({ id: text(doc.get('itemID')) || doc.id, data: doc.data() }))
    .filter(({ id, data }) => !posted.has(id) && isPostable(data));
}

async function sendMessage(message) {
  if (message.length > TELEGRAM_LIMIT) {
    throw new Error(`Message is ${message.length} characters; Telegram allows ${TELEGRAM_LIMIT}.`);
  }
  if (config.dryRun) {
    console.log(`----\n${message}\n`);
    return;
  }
  const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.channel,
      text: message, // plain text, sent exactly as stored
      link_preview_options: { is_disabled: true },
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(`Telegram refused the message: ${body.description ?? response.status}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(db) {
  const posted = readPosted();
  const current = config.month || currentMonthLabel();

  // This month first; if it is not uploaded yet or is used up, the month
  // before, and so on back.
  for (const month of monthsBackFrom(current, LOOKBACK_MONTHS)) {
    const available = await postableIn(db, month, posted);
    if (available.length < config.perPost) continue;
    const picked = shuffle(available).slice(0, config.perPost);

    if (month !== current) {
      console.log(`${current} has no unposted text questions; using ${month}.`);
    }

    for (const [i, { id, data }] of picked.entries()) {
      await sendMessage(formatQuestion(data));
      if (!config.dryRun) {
        posted.add(id);
        writePosted(posted); // saved per message, so a failure mid-run never reposts
      }
      if (i < picked.length - 1) await sleep(1500);
    }
    console.log(`Posted ${picked.length} questions from ${month}: ${picked.map((q) => q.id).join(', ')}`);
    return;
  }

  throw new Error(
    `Fewer than ${config.perPost} unposted text questions in every month between ${current} and `
    + `${monthsBackFrom(current, LOOKBACK_MONTHS).pop()}. ${await describeBank(db)}`,
  );
}

/** What the bank looks like, for the error message: no question text. */
async function describeBank(db) {
  try {
    const projectId = JSON.parse(config.serviceAccount || '{}').project_id || 'unknown';
    const collection = db.collection(BANK_COLLECTION);
    const count = (await collection.count().get()).data().count;
    const sample = await collection.limit(3).get();
    const months = sample.docs.map((doc) => JSON.stringify(doc.get(MONTH_FIELD)));
    const fields = sample.docs[0] ? Object.keys(sample.docs[0].data()).sort().join(', ') : 'none';
    return `Project: ${projectId}. ${BANK_COLLECTION} holds ${count} documents. `
      + `Sample ${MONTH_FIELD} values: ${months.join(' | ') || 'none'}. Fields: ${fields}.`;
  } catch (error) {
    return `Could not inspect the bank: ${error.message}`;
  }
}

async function main() {
  const missing = ['FIREBASE_SERVICE_ACCOUNT']
    .concat(config.dryRun ? [] : ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL'])
    .filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing environment: ${missing.join(', ')}`);

  const admin = require('firebase-admin');
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(config.serviceAccount)),
  });
  await run(admin.firestore());
}

if (require.main === module) {
  main().catch((error) => {
    // '::error::' makes GitHub show the message on the run's summary page.
    console.error(`::error::${String(error.message).replace(/\r?\n/g, ' ')}`);
    process.exit(1);
  });
}

module.exports = { run, formatQuestion, monthOrdinal, monthLabel, currentMonthLabel, monthsBackFrom, isPostable, config };
