'use strict';

/**
 * Decides whether this scheduled run is today's posting time.
 *
 * The workflow wakes up at every time in SLOTS. Each day one of them is
 * picked at random (seeded by the date, so all of that day's runs agree on
 * the pick), and only that run posts. The others stop before installing
 * anything.
 *
 * Writes `post=true` or `post=false` to $GITHUB_OUTPUT. Runs started by hand
 * (no SCHEDULE) always post.
 *
 * Keep SLOTS in step with the `cron` lines in .github/workflows/post.yml.
 */

const fs = require('fs');

// Riyadh time -> the matching cron line (UTC, Riyadh is UTC+3 all year).
const SLOTS = {
  '10:00 AM': '0 7 * * *',
  '1:00 PM': '0 10 * * *',
  '3:30 PM': '30 12 * * *',
  '4:00 PM': '0 13 * * *',
  '5:15 PM': '15 14 * * *',
};

/** Today's date in Riyadh, 'YYYY-MM-DD'. */
function riyadhDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(now);
}

/** A stable pseudo-random pick for a date: same date, same slot. */
function slotFor(date) {
  let hash = 2166136261;
  for (const char of `smlebrain:${date}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const names = Object.keys(SLOTS);
  return names[hash % names.length];
}

function decide(schedule, now = new Date()) {
  if (!schedule) return { post: true, reason: 'Started by hand: posting now.' };
  const date = riyadhDate(now);
  const today = slotFor(date);
  const post = SLOTS[today] === schedule.trim();
  return {
    post,
    reason: post
      ? `${date}: ${today} is today's time. Posting.`
      : `${date}: today's time is ${today}, not this run (${schedule}). Skipping.`,
  };
}

if (require.main === module) {
  const { post, reason } = decide(process.env.SCHEDULE || '');
  console.log(reason);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `post=${post}\n`);
  }
}

module.exports = { SLOTS, slotFor, decide, riyadhDate };
