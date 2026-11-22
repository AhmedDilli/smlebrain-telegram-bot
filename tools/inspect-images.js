'use strict';
// Read-only look at image questions in bankQuestions. Posts nothing.
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const note = (m) => console.log(`::notice::${String(m).replace(/\r?\n/g, ' ')}`);
const redact = (u) => String(u).replace(/([?&](token|X-Goog-Signature|key)=)[^&]+/gi, '$1…');
const urls = (d) => (Array.isArray(d.get('ImageUrls')) ? d.get('ImageUrls') : []).filter((u) => String(u || '').trim());

(async () => {
  const snap = await db.collection('bankQuestions').get();
  const fieldNames = new Set();
  snap.docs.forEach((d) => Object.keys(d.data()).forEach((k) => fieldNames.add(k)));
  note(`total docs ${snap.size}; fields: ${[...fieldNames].join(',')}`);
  const withImg = snap.docs.filter((d) => urls(d).length);
  const perMonth = {};
  withImg.forEach((d) => (d.get('Month') || []).forEach((m) => { perMonth[m] = (perMonth[m] || 0) + 1; }));
  const nImgs = {};
  withImg.forEach((d) => { const n = String(urls(d).length); nImgs[`n${n}`] = (nImgs[`n${n}`] || 0) + 1; });
  note(`with ImageUrls: ${withImg.length}; images per question: ${JSON.stringify(nImgs)}`);
  note(`image questions per month: ${JSON.stringify(perMonth)}`);
  const complete = withImg.filter((d) => ['Question', 'A', 'B', 'C', 'D'].every((k) => String(d.get(k) || '').trim())).length;
  note(`image questions with stem + 4 options: ${complete}`);
  const lens = withImg.map((d) => String(d.get('Question') || '').length).sort((a, b) => a - b);
  note(`stem length of image questions: min ${lens[0]}, median ${lens[Math.floor(lens.length / 2)]}, max ${lens[lens.length - 1]}`);
  // other image-ish fields on any doc
  const imgish = [...fieldNames].filter((k) => /image|img|photo|pic|url/i.test(k));
  note(`image-ish field names: ${imgish.join(',')}`);
  for (const d of withImg.slice(0, 4)) {
    note(`sample ${d.id}: Month=${JSON.stringify(d.get('Month'))} urls=${JSON.stringify(urls(d).map(redact)).slice(0, 300)}`);
    for (const url of urls(d).slice(0, 1)) {
      try {
        const res = await fetch(url);
        const buf = Buffer.from(await res.arrayBuffer());
        note(`sample ${d.id}: GET -> ${res.status} ${res.headers.get('content-type')} ${buf.length} bytes (no login sent)`);
      } catch (e) { note(`sample ${d.id}: fetch failed: ${e.message}`); }
    }
  }
})().catch((e) => { console.log(`::error::${e.message}`); process.exit(1); });
