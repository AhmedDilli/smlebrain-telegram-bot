'use strict';

/**
 * SMLE Brain questions (Firebase project "smlebrain", collection
 * bankQuestions). Posts this month's questions on Riyadh's calendar, falling
 * back a month at a time when a month is not uploaded yet or is used up.
 * Plain text: the month and year (e.g. "November 2026"), the case, then the
 * options. No answer. Some posts include image questions: the pictures first,
 * then the same text.
 */

const BANK_COLLECTION = 'bankQuestions';
const IMAGE_COLLECTION = 'imageQuestions'; // same fields, plus ImageUrls (1-6 public links)
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

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** 'Nov-26' -> 'November 2026' ('' if the label is not a month). */
function monthTitle(label) {
  const ordinal = monthOrdinal(label);
  return ordinal === null ? '' : `${MONTH_NAMES[ordinal % 12]} ${Math.floor(ordinal / 12)}`;
}

/** The month and year, the case, then the four options. No answer. */
function formatQuestion(data, month) {
  const options = ['A', 'B', 'C', 'D'].map((letter) => `${letter}) ${text(data[letter])}`).join('\n');
  const title = monthTitle(month);
  return `${title ? `${title}\n\n` : ''}${text(data.Question)}\n\n${options}`;
}

/** Image questions: the same text fields, and at least one image link. */
function imageLinks(data) {
  return (Array.isArray(data.ImageUrls) ? data.ImageUrls : []).map(text).filter((url) => /^https?:\/\//i.test(url));
}

function isPostableImage(data) {
  return imageLinks(data).length > 0 && ['Question', 'A', 'B', 'C', 'D'].every((key) => text(data[key]));
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
  /** [imageCount] of each post's questions come from the image collection. */
  constructor(db, { month = '', imageCount = 0, log = console.log } = {}) {
    this.db = db;
    this.month = month;
    this.imageCount = imageCount;
    this.log = log;
  }

  /**
   * [count] unposted questions. Image questions come first, then text ones
   * from the current month. If there are too few image questions left, the
   * post is made up with text questions instead.
   */
  async pick(count, posted) {
    const images = this.imageCount > 0 ? await this.pickImages(Math.min(this.imageCount, count), posted) : [];
    const texts = await this.pickText(count - images.length, posted);
    return [...images, ...texts];
  }

  /**
   * Unposted image questions from the current month only. When the month has
   * none (or too few) left, the post is made up with text questions instead:
   * image questions never come from other months.
   */
  async pickImages(count, posted) {
    const current = this.month || currentMonthLabel();
    const snapshot = await this.db.collection(IMAGE_COLLECTION).get();
    const available = snapshot.docs
      .map((doc) => ({ id: text(doc.get('itemID')) || doc.id, data: doc.data() }))
      .filter(({ id, data }) => !posted.has(id) && isPostableImage(data)
        && (Array.isArray(data.Month) ? data.Month : []).map(text).includes(current));
    const picked = shuffle(available).slice(0, count).map((q) => ({ ...q, month: current, kind: 'image' }));
    if (picked.length < count) this.log(`SMLE: ${picked.length} unposted image question(s) in ${current}; filling the rest with text questions.`);
    return picked;
  }

  /** [count] unposted text questions, all from the same month. */
  async pickText(count, posted) {
    if (count <= 0) return [];
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

  /** Returns false if the question could not be sent and was skipped. */
  async send(telegram, chat, { data, month, kind }) {
    if (kind === 'image') {
      try {
        await telegram.sendPhotos(chat, imageLinks(data));
      } catch (error) {
        // Nothing has been posted for this question yet, so skip it cleanly.
        this.log(`::warning::SMLE image question skipped (${String(error.message).replace(/\r?\n/g, ' ')})`);
        return false;
      }
    }
    await telegram.sendText(chat, formatQuestion(data, month));
    return true;
  }
}

module.exports = { SmleSource, formatQuestion, monthTitle, isPostableImage, imageLinks, isPostable, currentMonthLabel, monthsBackFrom, monthOrdinal };
