'use strict';
// Read-only look at where images live in bankQuestions. Posts nothing.
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const note = (m) => console.log(`::notice::${String(m).replace(/\r?\n/g, ' ')}`);
const redact = (u) => String(u).replace(/([?&](token|X-Goog-Signature|key)=)[^&]+/gi, '$1…');
const kind = (v) => (v == null ? 'null' : Array.isArray(v) ? `array(${v.length})` : typeof v);

(async () => {
  const snap = await db.collection('bankQuestions').get();
  const ei = snap.docs.filter((d) => { const v = d.get('ExplanationImages'); return Array.isArray(v) ? v.length : v; });
  const kinds = {};
  snap.docs.forEach((d) => { const k = kind(d.get('ExplanationImages')); kinds[`t_${k}`] = (kinds[`t_${k}`] || 0) + 1; });
  note(`ExplanationImages types: ${JSON.stringify(kinds)}; non-empty: ${ei.length}`);
  const perMonth = {};
  ei.forEach((d) => (d.get('Month') || []).forEach((m) => { perMonth[`m_${m}`] = (perMonth[`m_${m}`] || 0) + 1; }));
  note(`non-empty ExplanationImages per month: ${JSON.stringify(perMonth)}`);
  for (const d of ei.slice(0, 3)) {
    note(`sample ${d.id}: ${JSON.stringify(d.get('ExplanationImages')).replace(/\{/g, '(').replace(/\}/g, ')').slice(0, 350)}`);
  }
  const urlInStem = snap.docs.filter((d) => /https?:\/\//i.test(['Question', 'A', 'B', 'C', 'D'].map((k) => String(d.get(k) || '')).join(' ')));
  note(`questions with a link in the stem/options: ${urlInStem.length}`);
  const imgWords = snap.docs.filter((d) => /\b(image|picture|photo|figure|shown|pictured|photograph|x-ray|ecg|ekg|ct scan|mri)\b/i.test(String(d.get('Question') || '')));
  note(`stems mentioning image-like words: ${imgWords.length}`);
  const flags = {};
  snap.docs.forEach((d) => { const f = d.get('Flags'); const k = kind(f); flags[`t_${k}`] = (flags[`t_${k}`] || 0) + 1; });
  note(`Flags types: ${JSON.stringify(flags)}`);
  if (ei[0]) {
    const first = JSON.stringify(ei[0].get('ExplanationImages'));
    const m = first.match(/https?:\/\/[^"\s]+/);
    if (m) {
      try { const res = await fetch(m[0]); const buf = Buffer.from(await res.arrayBuffer()); note(`first explanation image: GET -> ${res.status} ${res.headers.get('content-type')} ${buf.length} bytes (no login sent); host ${new URL(m[0]).host}`); }
      catch (e) { note(`first explanation image fetch failed: ${e.message}`); }
    }
  }
})().catch((e) => { console.log(`::error::${e.message}`); process.exit(1); });
