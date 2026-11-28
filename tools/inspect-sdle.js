'use strict';
// Read-only look at the SDLE Brain Firestore. Posts nothing.
const admin = require('firebase-admin');
const key = JSON.parse(process.env.SDLE_FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();
const plain = (s) => String(s).replace(/[{}]/g, '(').replace(/\r?\n/g, ' ');
const note = (m) => console.log(`::notice::${plain(m)}`);
const redact = (u) => String(u).replace(/([?&](token|X-Goog-Signature|key)=)[^&]+/gi, '$1…');
const kind = (v) => (v == null ? 'null' : Array.isArray(v) ? `array(${v.length ? typeof v[0] : 0})` : v && v.toDate ? 'timestamp' : typeof v);
const clip = (v) => (typeof v === 'string' ? redact(v).slice(0, 110) : Array.isArray(v) ? v.slice(0, 3).map(clip) : v && typeof v === 'object' && !v.toDate ? Object.fromEntries(Object.entries(v).slice(0, 6).map(([k, x]) => [k, clip(x)])) : v);

(async () => {
  note(`project_id: ${key.project_id}`);
  const cols = await db.listCollections();
  note(`collections: ${cols.map((c) => c.id).join(', ')}`);
  for (const col of cols) {
    const snap = await col.get();
    const fields = {};
    snap.docs.forEach((d) => Object.entries(d.data()).forEach(([k, v]) => { const f = `${k}:${kind(v)}`; fields[f] = (fields[f] || 0) + 1; }));
    note(`[${col.id}] ${snap.size} docs; fields: ${plain(JSON.stringify(fields))}`);
    const months = {};
    snap.docs.forEach((d) => { const m = d.get('Month') ?? d.get('month'); (Array.isArray(m) ? m : [m]).forEach((x) => { months[`m_${x}`] = (months[`m_${x}`] || 0) + 1; }); });
    note(`[${col.id}] Month values (counts): ${plain(JSON.stringify(months)).slice(0, 700)}`);
    for (const d of snap.docs.slice(0, 2)) note(`[${col.id}] sample ${d.id}: ${plain(JSON.stringify(Object.fromEntries(Object.entries(d.data()).map(([k, v]) => [k, clip(v)])))).slice(0, 1100)}`);
    // an example that has any image-ish field filled
    const withImg = snap.docs.find((d) => Object.entries(d.data()).some(([k, v]) => /image|img|photo|pic/i.test(k) && (Array.isArray(v) ? v.length : v)));
    if (withImg) {
      note(`[${col.id}] image example ${withImg.id}: ${plain(JSON.stringify(Object.fromEntries(Object.entries(withImg.data()).filter(([k]) => /image|img|photo|pic|url|question|month/i.test(k)).map(([k, v]) => [k, clip(v)])))).slice(0, 900)}`);
      const m = JSON.stringify(withImg.data()).match(/https?:\/\/[^"\s]+/);
      if (m) { try { const r = await fetch(m[0]); const b = Buffer.from(await r.arrayBuffer()); note(`[${col.id}] image GET (no login) -> ${r.status} ${r.headers.get('content-type')} ${b.length} bytes; host ${new URL(m[0]).host}`); } catch (e) { note(`image fetch failed: ${e.message}`); } }
    }
  }
})().catch((e) => { console.log(`::error::${plain(e.message)}`); process.exit(1); });
