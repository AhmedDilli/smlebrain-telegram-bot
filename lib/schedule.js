'use strict';

/**
 * When each channel posts.
 *
 * Each day the posting window (10:00 AM to 5:00 PM) is cut into one equal
 * slice per post, and each post gets a random minute inside its slice. So
 * five posts land at five random times across the day, never bunched
 * together. The randomness is seeded by channel and date: every run that day
 * computes the same times without having to store them.
 *
 * GitHub only starts workflows on a fixed schedule, so the workflow wakes
 * every 30 minutes. Each run handles the posts due within the next WINDOW
 * minutes (waiting until each one's minute) and any it finds overdue because
 * GitHub started it late.
 */

const WINDOW = 35; // runs are 30 minutes apart, plus slack for late starts
// A post more overdue than this is dropped for the day rather than sent in a
// burst with others (say after GitHub skipped several runs, or on the day the
// bot is first switched on in the afternoon).
const MAX_LATE = 60;

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Local date ('YYYY-MM-DD') and minutes after midnight in [timeZone]. */
function localNow(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
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

function hash(text) {
  let h = 2166136261;
  for (const char of text) {
    h ^= char.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // One more mixing round, so neighbouring dates do not give neighbouring times.
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** The minute of each of the day's posts for a channel, in order. */
function postTimes(channelKey, date, postsPerDay, window) {
  const from = minutesOf(window.from);
  const to = minutesOf(window.to);
  const slice = (to - from) / postsPerDay;
  // Keep clear of the slice edges, so neighbouring posts are never minutes
  // apart (with 5 posts a day, at least 20 minutes).
  const margin = postsPerDay > 1 ? Math.min(10, Math.floor(slice / 4)) : 0;
  return Array.from({ length: postsPerDay }, (_, i) => {
    const start = Math.ceil(from + i * slice) + margin;
    const end = Math.floor(from + (i + 1) * slice) - margin; // exclusive
    return start + (hash(`${channelKey}|${date}|${i}`) % Math.max(1, end - start));
  });
}

function clock(minutes) {
  const h = Math.floor(minutes / 60);
  const m = String(minutes % 60).padStart(2, '0');
  return `${((h + 11) % 12) + 1}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * Posts this run should send: not done yet today, and due before the next
 * run comes along. Sorted by time. `wait` is minutes from now (0 if late).
 */
function duePosts({ channels, window, now, isDone }) {
  const { date, minutes } = localNow(window.timeZone, now);
  const due = [];
  for (const [key, channel] of Object.entries(channels)) {
    postTimes(key, date, channel.postsPerDay, window).forEach((at, slot) => {
      if (isDone(key, date, slot)) return;
      if (at - minutes >= WINDOW) return;
      if (minutes - at > MAX_LATE) return;
      due.push({ key, slot, at, date, wait: Math.max(0, at - minutes) });
    });
  }
  return due.sort((a, b) => a.at - b.at);
}

module.exports = { WINDOW, MAX_LATE, localNow, postTimes, duePosts, clock, minutesOf };
