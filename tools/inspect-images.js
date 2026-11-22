'use strict';
// Read-only look at image questions in bankQuestions. Posts nothing.
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const note = (m) => console.log(`::notice::${String(m).replace(/\r?\n/g, ' ')}`);
const redact = (u) => String(u).replace(/([?&](token|X-Goog-Signature|key)=)[^&]+/gi, '$1…');

(async () => {
  for (const month of ['Nov-26', 'Oct-26', 'Sep-26', 'Aug-26']) {
    const snap = await db.collection('bankQuestions').where('Month', 'array-contains', month).get();
    const withImg = snap.docs.filter((d) => (d.get('ImageUrls') || []).some((u) => String(u || '').trim()));
    const textOk = snap.docs.length - withImg.length;
    const counts = {};
    withImg.forEach((d) => { const n = d.get('ImageUrls').filter((u) => String(u || '').trim()).length; counts[n] = (counts[n] || 0) + 1; });
    note(`${month}: ${snap.docs.length} questions, ${withImg.length} with images (images per question: ${JSON.stringify(counts)}), ${textOk} text-only`);
  }
  const snap = await db.collection('bankQuestions').where('Month', 'array-contains', 'Oct-26').get();
  const samples = snap.docs.filter((d) => (d.get('ImageUrls') || []).some((u) => String(u || '').trim())).slice(0, 3);
  for (const d of samples) {
    const data = d.data();
    note(`sample ${d.id}: keys=${Object.keys(data).join(',')}`);
    note(`sample ${d.id}: Question length=${String(data.Question || '').length}; image-ish fields: ${JSON.stringify(Object.fromEntries(Object.entries(data).filter(([k]) => /image|img|url|photo/i.test(k)).map(([k, v]) => [k, Array.isArray(v) ? v.map(redact) : redact(v)])))}`);
    for (const url of data.ImageUrls.filter((u) => String(u || '').trim()).slice(0, 2)) {
      try {
        const res = await fetch(url, { method: 'GET' });
        const buf = Buffer.from(await res.arrayBuffer());
        note(`sample ${d.id}: GET ${redact(url).slice(0, 140)} -> ${res.status} ${res.headers.get('content-type')} ${buf.length} bytes (no login sent)`);
      } catch (e) { note(`sample ${d.id}: fetch failed: ${e.message}`); }
    }
  }
})().catch((e) => { console.log(`::error::${e.message}`); process.exit(1); });
