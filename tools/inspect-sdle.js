'use strict';
// Read-only look at SDLE image questions. Posts nothing.
const admin = require('firebase-admin');
const key = JSON.parse(process.env.SDLE_FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();
const out = [];
const note = (m) => out.push(String(m).replace(/[{}]/g, '(').replace(/\r?\n/g, ' '));
const redact = (u) => String(u).replace(/([?&](token|X-Goog-Signature|key)=)[^&]+/gi, '$1…');
const urls = (d) => (Array.isArray(d.get('ImageUrls')) ? d.get('ImageUrls') : []);
const hist = (arr) => arr.reduce((h, v) => { h[`n${v}`] = (h[`n${v}`] || 0) + 1; return h; }, {});

(async () => {
  const snap = await db.collection('bankQuestions').get();
  const img = snap.docs.filter((d) => urls(d).some((u) => String(u || '').trim()));
  note(`image questions: ${img.length} of ${snap.size}; images per question ${JSON.stringify(hist(img.map((d) => urls(d).filter(Boolean).length)))}`);
  const valid = img.filter((d) => urls(d).every((u) => /^https?:\/\//.test(u)));
  note(`all links http(s): ${valid.length}; hosts: ${JSON.stringify(hist(img.flatMap((d) => urls(d)).map((u) => { try { return new URL(u).host; } catch { return 'bad'; } })))}`);
  const months = {};
  img.forEach((d) => (d.get('Month') || []).forEach((m) => { months[m] = (months[m] || 0) + 1; }));
  note(`image questions per month: ${JSON.stringify(months)}`);
  note(`image questions with E: ${img.filter((d) => d.get('E')).length}, with F: ${img.filter((d) => d.get('F')).length}, missing D: ${img.filter((d) => !String(d.get('D') || '').trim()).length}`);
  const lens = img.map((d) => String(d.get('Question') || '').length).sort((a, b) => a - b);
  note(`stem length of image questions: min ${lens[0]} median ${lens[lens.length >> 1]} max ${lens[lens.length - 1]}`);
  const nov = img.filter((d) => (d.get('Month') || []).includes('Nov-26'));
  note(`Nov-26: ${snap.docs.filter((d) => (d.get('Month') || []).includes('Nov-26')).length} total, ${nov.length} with images`);
  const ex = img.find((d) => urls(d).length >= 2) || img[0];
  note(`example ${ex.id}: Question=${String(ex.get('Question')).slice(0, 200)} | urls=${JSON.stringify(urls(ex).map((u) => redact(u).slice(0, 170)))}`);
  const fails = [];
  for (const d of img.slice(0, 6)) {
    for (const u of urls(d).slice(0, 1)) {
      try { const r = await fetch(u); const b = Buffer.from(await r.arrayBuffer()); fails.push(`${d.id}:${r.status} ${r.headers.get('content-type')} ${b.length}B`); } catch (e) { fails.push(`${d.id}:ERR ${e.message}`); }
    }
  }
  note(`image GET (no login): ${fails.join(' | ')}`);
  const wrongAnswers = snap.docs.filter((d) => !/^[A-F]$/.test(String(d.get('Answer') || '').trim())).length;
  note(`Answer not a single letter A-F: ${wrongAnswers}`);
  out.forEach((m, i) => console.log(`::notice title=SDLE ${i + 1}::${m}`));
})().catch((e) => { console.log(`::error::${String(e.message).slice(0, 300)}`); process.exit(1); });
