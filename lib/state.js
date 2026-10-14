'use strict';

/**
 * What each channel has already posted, one file per channel in state/:
 *   { "posted": ["id", ...], "today": { "date": "2026-10-14", "slots": [0, 2] } }
 * `posted` keeps questions from repeating; `today` keeps a day's post times
 * from going out twice. The workflow commits the folder after every run.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'state');

function file(key) {
  return path.join(DIR, `${key}.json`);
}

function load(key) {
  try {
    const raw = JSON.parse(fs.readFileSync(file(key), 'utf8'));
    return {
      posted: Array.isArray(raw.posted) ? raw.posted.map(String) : [],
      today: raw.today && typeof raw.today.date === 'string'
        ? { date: raw.today.date, slots: Array.isArray(raw.today.slots) ? raw.today.slots : [] }
        : { date: '', slots: [] },
    };
  } catch {
    return { posted: [], today: { date: '', slots: [] } };
  }
}

function save(key, state) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(key), `${JSON.stringify(state, null, 2)}\n`);
}

class StateStore {
  constructor() {
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) this.cache.set(key, load(key));
    return this.cache.get(key);
  }

  postedSet(key) {
    return new Set(this.get(key).posted);
  }

  addPosted(key, id) {
    const state = this.get(key);
    if (!state.posted.includes(id)) state.posted.push(id);
    save(key, state);
  }

  isDone(key, date, slot) {
    const { today } = this.get(key);
    return today.date === date && today.slots.includes(slot);
  }

  markDone(key, date, slot) {
    const state = this.get(key);
    if (state.today.date !== date) state.today = { date, slots: [] };
    if (!state.today.slots.includes(slot)) state.today.slots.push(slot);
    save(key, state);
  }
}

module.exports = { StateStore };
