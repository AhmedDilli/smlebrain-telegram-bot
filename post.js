'use strict';

/**
 * Posts SMLE questions from one month to a Telegram channel as plain text.
 *
 * Each run:
 *   1. Reads bankMeta/smle_filters, the month -> itemIDs index the app already
 *      keeps (one document read).
 *   2. Takes the current month on Riyadh's calendar ('Oct-26'). If that month
 *      is not in the bank yet, or has nothing unposted left, it falls back to
 *      the newest month that does.
 *   3. Fetches questions from that month that have not been posted before and
 *      have no images, and keeps QUESTIONS_PER_POST of them.
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
const FILTER_INDEX_DOC = ['bankMeta', 'smle_filters'];
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

/** Index of month label -> itemIDs, from the document the app maintains. */
async function readMonthIndex(db) {
  const [collection, doc] = FILTER_INDEX_DOC;
  const snapshot = await db.collection(collection).doc(doc).get();
  if (!snapshot.exists) {
    throw new Error(`${collection}/${doc} does not exist. Rebuild the filter index from the app.`);
  }
  const payload = snapshot.get('payload');
  if (typeof payload !== 'string' || !payload) {
    throw new Error(`${collection}/${doc} has no payload.`);
  }
  const byAxis = JSON.parse(payload).byAxis ?? {};
  const index = new Map();
  for (const [label, ids] of Object.entries(byAxis)) {
    if (monthOrdinal(label) === null || !Array.isArray(ids)) continue;
    index.set(label, ids.map(String));
  }
  return index;
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

/**
 * The order months are tried in: this month first, then the rest newest
 * first. The fallback only matters early in a month, before its questions
 * are uploaded, or if this month runs out of unposted questions.
 */
function monthsToTry(index, current) {
  const newestFirst = [...index.keys()]
    .sort((a, b) => monthOrdinal(b) - monthOrdinal(a))
    .filter((label) => label !== current);
  return index.has(current) ? [current, ...newestFirst] : newestFirst;
}

/** Up to [count] postable questions from [ids], in random order. */
async function pickQuestions(db, ids, count) {
  const picked = [];
  const candidates = shuffle(ids);
  // Each document fetched is a billed read, so ask for a few more than needed
  // (to cover image questions) rather than Firestore's maximum of 30.
  const batch = Math.min(30, count * 2);
  for (let start = 0; start < candidates.length && picked.length < count; start += batch) {
    const chunk = candidates.slice(start, start + batch);
    const snapshot = await db.collection(BANK_COLLECTION).where('itemID', 'in', chunk).get();
    const byId = new Map(snapshot.docs.map((doc) => [text(doc.get('itemID')), doc.data()]));
    for (const id of chunk) {
      const data = byId.get(id);
      if (data && isPostable(data)) picked.push({ id, data });
      if (picked.length === count) break;
    }
  }
  return picked;
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
  const index = await readMonthIndex(db);
  const current = config.month || currentMonthLabel();

  // Image questions are only discovered on fetch, so a month with enough ids
  // can still come up short; the next month is tried then.
  for (const month of monthsToTry(index, current)) {
    const unposted = index.get(month).filter((id) => !posted.has(id));
    if (unposted.length < config.perPost) continue;
    const picked = await pickQuestions(db, unposted, config.perPost);
    if (picked.length < config.perPost) continue;

    if (month !== current) {
      console.log(`${current} ${index.has(current) ? 'has no unposted questions left' : 'is not in the bank yet'}; using ${month}.`);
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

  throw new Error('No month has enough unposted text questions left.');
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
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { run, formatQuestion, monthOrdinal, currentMonthLabel, monthsToTry, isPostable, config };
