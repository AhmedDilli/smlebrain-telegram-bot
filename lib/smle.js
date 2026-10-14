'use strict';

/**
 * SMLE Brain questions (Firebase project "smlebrain", collection
 * bankQuestions). Posts this month's questions on Riyadh's calendar, falling
 * back a month at a time when a month is not uploaded yet or is used up.
 * Plain text: the case, then the options. No header, no answer.
 */

const BANK_COLLECTION = 'bankQuestions';
const MONTH_FIELD = 'Month'; // a list such as ['Sep-26', 'Oct-26']
const LOOKBACK_MONTHS = 24;

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function text(value) {
  if (typeof value === 'string') return value.trim();
  return value == null ? '' : String(value).trim();
}

/** 'Mar-25' -> a sortable month number, or null. */
function monthOrdinal(label) {
  const match = /^([A-Za-z]{3})-(\d{2})$/.exec(String(label).trim());
  if (!match) return null;
  const month = MONTH_ABBR.findIndex((m) => m.toLowerCase() === match[1].toLowerCase());
  if (month < 0) return null;
  return (2000 + Number(match[2])) * 12 + month;
}

function monthLabel(ordinal) {
  const year = String(Math.floor(ordinal / 12) % 100).padStart(2, '0');
  return `${MONTH_ABBR[ordinal % 12]}-${year}`;
}

/** This month on Riyadh's calendar: 'Oct-26'. */
function currentMonthLabel(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Riyadh',
    month: 'short',
    year: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('month')}-${get('year')}`;
}

function monthsBackFrom(start, count) {
  const first = monthOrdinal(start);
  if (first === null) throw new Error(`SMLE month must look like 'Oct-26', not '${start}'.`);
  return Array.from({ length: count }, (_, i) => monthLabel(first - i));
}

/** Text questions only: a stem, four options, and no images. */
function isPostable(data) {
  const images = Array.isArray(data.ImageUrls) ? data.ImageUrls.filter((url) => text(url)) : [];
  if (images.length > 0) return false;
  return ['Question', 'A', 'B', 'C', 'D'].every((key) => text(data[key]));
}

/** The case, a blank line, then the four options. Nothing else. */
function formatQuestion(data) {
  const options = ['A', 'B', 'C', 'D'].map((letter) => `${letter}) ${text(data[letter])}`).join('\n');
  return `${text(data.Question)}\n\n${options}`;
}

function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

class SmleSource {
  constructor(db, { month = '', log = console.log } = {}) {
    this.db = db;
    this.month = month;
    this.log = log;
  }

  /** [count] unposted questions, all from the same month. */
  async pick(count, posted) {
    const current = this.month || currentMonthLabel();
    for (const month of monthsBackFrom(current, LOOKBACK_MONTHS)) {
      const snapshot = await this.db.collection(BANK_COLLECTION)
        .where(MONTH_FIELD, 'array-contains', month)
        .get();
      const available = snapshot.docs
        .map((doc) => ({ id: text(doc.get('itemID')) || doc.id, data: doc.data() }))
        .filter(({ id, data }) => !posted.has(id) && isPostable(data));
      if (available.length < count) continue;
      if (month !== current) this.log(`SMLE: ${current} has no unposted text questions; using ${month}.`);
      return shuffle(available).slice(0, count).map((q) => ({ ...q, month }));
    }
    throw new Error(`SMLE: fewer than ${count} unposted text questions in every month from ${current} back ${LOOKBACK_MONTHS} months.`);
  }

  async send(telegram, chat, { data }) {
    await telegram.sendText(chat, formatQuestion(data));
  }
}

module.exports = { SmleSource, formatQuestion, isPostable, currentMonthLabel, monthsBackFrom, monthOrdinal };
