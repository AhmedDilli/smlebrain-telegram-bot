'use strict';
// Read-only look at the imageQuestions collection. Posts nothing.
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const note = (m) => console.log(`::notice::${String(m).replace(/\r?\n/g, ' ')}`);
const redact = (u) => String(u).replace(/([?&](token|X-Goog-Signature|key)=)[^&]+/gi, '$1…');
const kind = (v) => (v == null ? 'null' : Array.isArray(v) ? `array(${v.length})` : typeof v);
const plain = (s) => String(s).replace(/[{}]/g, '(').replace(/\r?\n/g, ' ');

(async () => {
  const snap = await db.collection('imageQuestions').get();
  const fields = {};
  snap.docs.forEach((d) => Object.entries(d.data()).forEach(([k, v]) => { const key = `${k}:${kind(v)}`; fields[key] = (fields[key] || 0) + 1; }));
  note(`imageQuestions: ${snap.size} docs`);
  note(`fields (name:type -> count): ${plain(JSON.stringify(fields))}`);
  const perMonth = {};
  snap.docs.forEach((d) => (Array.isArray(d.get('Month')) ? d.get('Month') : [d.get('Month')]).forEach((m) => { perMonth[`m_${m}`] = (perMonth[`m_${m}`] || 0) + 1; }));
  note(`per month: ${plain(JSON.stringify(perMonth))}`);
  const complete = snap.docs.filter((d) => ['Question', 'A', 'B', 'C', 'D', 'Answer'].every((k) => String(d.get(k) || '').trim())).length;
  note(`with Question + A-D + Answer: ${complete}`);
  const lens = snap.docs.map((d) => String(d.get('Question') || '').length).sort((a, b) => a - b);
  note(`stem length min ${lens[0]} median ${lens[lens.length >> 1]} max ${lens[lens.length - 1]}`);
  for (const d of snap.docs.slice(0, 3)) {
    const data = d.data();
    const shown = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? redact(v).slice(0, 140) : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? redact(x).slice(0, 160) : x)) : v]));
    note(`sample ${d.id}: ${plain(JSON.stringify(shown)).slice(0, 900)}`);
  }
  const first = JSON.stringify(snap.docs.map((d) => d.data()).slice(0, 20)).match(/https?:\/\/[^"\s]+/);
  if (first) {
    try { const res = await fetch(first[0]); const buf = Buffer.from(await res.arrayBuffer()); note(`first image: GET -> ${res.status} ${res.headers.get('content-type')} ${buf.length} bytes (no login sent); host ${new URL(first[0]).host}`); }
    catch (e) { note(`first image fetch failed: ${e.message}`); }
  }
})().catch((e) => { console.log(`::error::${e.message}`); process.exit(1); });
