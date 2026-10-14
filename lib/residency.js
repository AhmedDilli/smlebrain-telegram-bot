'use strict';

/**
 * Residency Brain questions (Firebase project "residency-brain").
 *
 * A bank is not a Firestore collection: the `banks` collection holds one
 * catalog document per bank (fm_p1, im_p1, ...) whose `bundleUrl` points at
 * the whole bank as one gzipped JSON file in Storage. The bot downloads that
 * file once per run and picks from it.
 *
 * Each question goes out as:
 *   - a quiz poll, with "Part 1 year 2024 question ⭐" and the case as the
 *     poll question, when both fit Telegram's 300 characters;
 *   - otherwise the header and case as a message, then a quiz poll of the
 *     options right under it;
 *   - otherwise (an option over 100 characters) the whole question as text;
 * followed by the explanation as a message, hidden behind a spoiler so
 * members answer before they see it.
 */

const zlib = require('zlib');
const { LIMITS, escapeHtml } = require('./telegram');

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(textValue, max) {
  return textValue.length <= max ? textValue : `${textValue.slice(0, max - 1).trimEnd()}…`;
}

/** 2024 -> '2024'; [2023, 2024] -> '2023 & 2024'; three -> '2019, 2022 & 2024'. */
function yearsLabel(years) {
  const list = [...new Set(years)].sort((a, b) => a - b).map(String);
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} & ${list[list.length - 1]}`;
}

function header(part, years) {
  const label = yearsLabel(years);
  return label ? `Part ${part} year ${label} question ⭐` : `Part ${part} question ⭐`;
}

/** Options in letter order, the index of the right one, or null if unusable. */
function readOptions(question) {
  const options = question.options ?? {};
  const letters = LETTERS.filter((l) => clean(options[l]));
  const answer = clean(question.answer).charAt(0).toUpperCase();
  const correct = letters.indexOf(answer);
  if (letters.length < 2 || correct < 0) return null;
  return {
    letters,
    texts: letters.map((l) => `${l}. ${clean(options[l])}`),
    correct,
  };
}

/**
 * Worth posting as a quiz: no images (the bot posts text), an answer that
 * was recalled and is not disputed, and at least two options.
 */
function isPostable(question) {
  const flags = question.flags ?? {};
  if ((question.images ?? []).length > 0) return false;
  if (flags.imageMissing || flags.answerNotRecalled || flags.disputed) return false;
  if (!clean(question.stem)) return false;
  return readOptions(question) !== null;
}

/** How a question will be laid out on Telegram. Pure, for testing. */
function layout(question, part) {
  const head = header(part, question.years ?? []);
  const stem = String(question.stem).trim();
  const { letters, texts, correct } = readOptions(question);
  const optionsFit = texts.every((t) => t.length <= LIMITS.pollOption);
  const singlePoll = `${head}\n\n${stem}`;
  const answerLine = texts[correct];

  const explanationText = clean(question.explanation?.text) ? String(question.explanation.text).trim() : '';
  const reveal = `Answer: ${answerLine}${explanationText ? `\n\n${explanationText}` : ''}`;
  // Lengths are capped before escaping, so a cut never lands inside a tag.
  const explanationHtml = `💡 <b>Explanation</b>\n<tg-spoiler>${escapeHtml(truncate(reveal, 3500))}</tg-spoiler>`;
  const pollExplanation = truncate(
    `Answer: ${answerLine}`,
    LIMITS.pollExplanation - '\nFull explanation in the next message.'.length,
  ) + (explanationText ? '\nFull explanation in the next message.' : '');

  if (optionsFit && singlePoll.length <= LIMITS.pollQuestion) {
    return {
      kind: 'quiz',
      poll: { question: singlePoll, options: texts, correct, explanation: pollExplanation },
      explanationHtml: explanationText ? explanationHtml : null,
    };
  }
  if (optionsFit) {
    return {
      kind: 'case+quiz',
      caseHtml: `<b>${escapeHtml(head)}</b>\n\n${escapeHtml(truncate(stem, 3500))}`,
      poll: { question: 'Choose the best answer for the case above.', options: texts, correct, explanation: pollExplanation },
      explanationHtml: explanationText ? explanationHtml : null,
    };
  }
  const optionLines = texts.map((t) => escapeHtml(t)).join('\n');
  return {
    kind: 'text',
    caseHtml: `<b>${escapeHtml(head)}</b>\n\n${escapeHtml(truncate(stem, 2800))}\n\n${optionLines}`,
    poll: null,
    explanationHtml,
  };
}

function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function gunzipIfNeeded(buffer) {
  return buffer[0] === 0x1f && buffer[1] === 0x8b ? zlib.gunzipSync(buffer) : buffer;
}

class ResidencySource {
  /**
   * [db] is the residency-brain Firestore; [loadBundle] can be swapped in
   * tests to read a bundle from disk.
   */
  constructor(db, bankId, { loadBundle } = {}) {
    this.db = db;
    this.bankId = bankId;
    this.loadBundle = loadBundle ?? (() => this.download());
    this.bundle = null;
  }

  async download() {
    const snapshot = await this.db.collection('banks').where('id', '==', this.bankId).limit(1).get();
    if (snapshot.empty) throw new Error(`Residency Brain has no published bank "${this.bankId}".`);
    const { bundleUrl } = snapshot.docs[0].data();
    if (!bundleUrl) throw new Error(`Bank "${this.bankId}" has no bundleUrl.`);
    const response = await fetch(bundleUrl);
    if (!response.ok) throw new Error(`Could not download bank "${this.bankId}" (HTTP ${response.status}).`);
    const body = gunzipIfNeeded(Buffer.from(await response.arrayBuffer()));
    return JSON.parse(body.toString('utf8'));
  }

  async load() {
    if (!this.bundle) this.bundle = await this.loadBundle();
    return this.bundle;
  }

  async pick(count, posted) {
    const bundle = await this.load();
    const available = (bundle.questions ?? []).filter((q) => !posted.has(String(q.id)) && isPostable(q));
    if (available.length < count) {
      throw new Error(`${this.bankId}: only ${available.length} unposted questions left.`);
    }
    return shuffle(available).slice(0, count).map((q) => ({ id: String(q.id), question: q }));
  }

  async send(telegram, chat, { question }) {
    const bundle = await this.load();
    const part = bundle.bank?.part ?? 1;
    const plan = layout(question, part);
    if (plan.caseHtml) await telegram.sendHtml(chat, plan.caseHtml);
    if (plan.poll) await telegram.sendQuiz(chat, plan.poll);
    if (plan.explanationHtml) await telegram.sendHtml(chat, plan.explanationHtml);
  }
}

module.exports = { ResidencySource, layout, isPostable, header, yearsLabel, readOptions };
