'use strict';

/**
 * Picks a random posting time each day between 10:00 AM and 5:00 PM Riyadh
 * time, and decides whether this run is the one that posts.
 *
 * GitHub can only start a workflow on a fixed schedule, so the workflow wakes
 * every 30 minutes through the day. Each run works out today's posting
 * time (seeded by the date, so every run that day agrees on it):
 *   - more than WINDOW minutes away: a later run will post, so stop here
 *   - within WINDOW minutes: wait until that minute, then post
 *   - already passed (GitHub started this run late): post now
 * and never posts twice in a day, using last-post.txt.
 *
 * Writes `post` (true/false) and `date` to $GITHUB_OUTPUT. A run started by
 * hand (no SCHEDULE) always posts straight away and does not count as the
 * day's post.
 */

const fs = require('fs');
const path = require('path');

const FIRST = 10 * 60; // 10:00 AM, in minutes after midnight
const LAST = 17 * 60; // 5:00 PM; the time is picked from FIRST up to LAST
const WINDOW = 35; // runs are 30 minutes apart; a little slack for late starts
const LAST_POST_FILE = path.join(__dirname, 'last-post.txt');

/** Riyadh date ('YYYY-MM-DD') and minutes after midnight. */
function riyadhNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** Today's posting time in minutes after midnight: same date, same time. */
function targetFor(date) {
  let hash = 2166136261;
  for (const char of `smlebrain:${date}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return FIRST + (hash % (LAST - FIRST)); // 10:00 AM to 4:59 PM
}

function clock(minutes) {
  const h = Math.floor(minutes / 60);
  const m = String(minutes % 60).padStart(2, '0');
  return `${((h + 11) % 12) + 1}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

function lastPostDate() {
  try {
    return fs.readFileSync(LAST_POST_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

/** { post, waitMinutes, date, reason } for a run at [now]. */
function decide({ scheduled, now = new Date(), lastPost = lastPostDate() }) {
  const { date, minutes } = riyadhNow(now);
  if (!scheduled) {
    return { post: true, waitMinutes: 0, date: '', reason: 'Started by hand: posting now.' };
  }
  if (lastPost === date) {
    return { post: false, waitMinutes: 0, date, reason: `${date}: already posted today. Skipping.` };
  }
  const target = targetFor(date);
  const wait = target - minutes;
  if (wait >= WINDOW) {
    return {
      post: false,
      waitMinutes: 0,
      date,
      reason: `${date}: today's time is ${clock(target)}; a later run will post. Skipping.`,
    };
  }
  return {
    post: true,
    waitMinutes: Math.max(0, wait),
    date,
    reason: wait > 0
      ? `${date}: today's time is ${clock(target)}. Waiting ${wait} min, then posting.`
      : `${date}: today's time was ${clock(target)}; this run started late. Posting now.`,
  };
}

async function main() {
  const decision = decide({ scheduled: Boolean(process.env.SCHEDULE) });
  console.log(decision.reason);
  if (decision.waitMinutes > 0) {
    await new Promise((resolve) => setTimeout(resolve, decision.waitMinutes * 60 * 1000));
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `post=${decision.post}\ndate=${decision.date}\n`);
  }
}

if (require.main === module) main();

module.exports = { decide, targetFor, riyadhNow, clock, FIRST, LAST, WINDOW };
