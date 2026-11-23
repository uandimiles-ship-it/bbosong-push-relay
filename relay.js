// Bbosong push relay. Reads new notification docs from Firestore and sends FCM pushes.
// Credentials come ONLY from the FIREBASE_SA environment variable (GitHub Actions secret). Never logged.
'use strict';
const admin = require('firebase-admin');

const PROJECT_ID = 'bbosong-app';
const MAX_DOCS_PER_RUN = 200;        // free-tier guard: bounded reads per run
const LOOKBACK_MINUTES = 60;         // only consider recent docs
const LOUNGE_TYPES = new Set(['like', 'comment', 'follow']);

function initApp() {
  const raw = process.env.FIREBASE_SA;
  if (!raw) { console.log('FIREBASE_SA not set; nothing to do.'); process.exit(0); }
  let cred;
  try { cred = JSON.parse(raw); } catch { console.log('FIREBASE_SA is not valid JSON.'); process.exit(1); }
  if (cred.project_id !== PROJECT_ID) { console.log('Unexpected project; aborting.'); process.exit(1); }
  admin.initializeApp({ credential: admin.credential.cert(cred), projectId: PROJECT_ID });
}

function bodyFor(d) {
  const who = (d.fromName || '누군가').toString().slice(0, 40);
  switch (d.type) {
    case 'like': return { title: '뽀송이 라운지', body: `${who}님이 내 글에 하트를 눌렀어요 💗` };
    case 'comment': return { title: '뽀송이 라운지', body: `${who}님이 내 글에 댓글을 남겼어요 💬` };
    case 'follow': return { title: '뽀송이 라운지', body: `${who}님이 나를 팔로우했어요 🐾` };
    default: return null;
  }
}

async function tokensFor(db, uid) {
  const s = await db.doc(`user_push_tokens/${uid}`).get();
  if (!s.exists) return [];
  const d = s.data() || {};
  const list = [];
  if (typeof d.token === 'string' && d.token) list.push(d.token);
  if (Array.isArray(d.tokens)) for (const t of d.tokens) if (typeof t === 'string' && t) list.push(t);
  return [...new Set(list)].slice(0, 10);
}

async function sendTo(tokens, msg, data) {
  if (!tokens.length) return { ok: 0, fail: 0 };
  const r = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: msg,
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? '')])),
    android: { priority: 'high' },
  });
  return { ok: r.successCount, fail: r.failureCount };
}

async function relayLounge(db) {
  const since = admin.firestore.Timestamp.fromMillis(Date.now() - LOOKBACK_MINUTES * 60000);
  const snap = await db.collectionGroup('notifications')
    .where('createdAt', '>=', since).orderBy('createdAt').limit(MAX_DOCS_PER_RUN).get();
  let sent = 0, skipped = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.relayedAt || !LOUNGE_TYPES.has(d.type)) { skipped++; continue; }
    const uid = doc.ref.parent.parent && doc.ref.parent.parent.id;
    const msg = bodyFor(d);
    if (!uid || !msg) { skipped++; continue; }
    const tokens = await tokensFor(db, uid);
    const r = await sendTo(tokens, msg, { kind: 'lounge', type: d.type, postId: d.postId || '', notificationId: doc.id });
    await doc.ref.update({ relayedAt: admin.firestore.FieldValue.serverTimestamp(), relayOk: r.ok });
    sent += r.ok;
  }
  console.log(`lounge: docs=${snap.size} pushes_ok=${sent} skipped=${skipped}`);
}

async function relayBroadcasts(db) {
  const snap = await db.collection('push_broadcasts').orderBy('createdAt', 'desc').limit(5).get();
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.relayedAt) continue;
    const title = (d.title || '뽀송이').toString().slice(0, 100);
    const body = (d.body || '').toString().slice(0, 500);
    const toks = await db.collection('user_push_tokens').limit(2000).get();
    const all = [];
    toks.forEach((t) => { const x = t.data(); if (x && x.enabled !== false && typeof x.token === 'string') all.push(x.token); });
    let ok = 0;
    for (let i = 0; i < all.length; i += 500) ok += (await sendTo(all.slice(i, i + 500), { title, body }, { kind: 'broadcast', broadcastId: doc.id })).ok;
    await doc.ref.update({ relayedAt: admin.firestore.FieldValue.serverTimestamp(), relayOk: ok });
    console.log(`broadcast ${doc.id}: pushes_ok=${ok}`);
  }
}

(async () => {
  initApp();
  const db = admin.firestore();
  await relayLounge(db);
  await relayBroadcasts(db);
})().catch((e) => { console.log('relay error:', e && e.code ? e.code : (e && e.message ? e.message.slice(0, 200) : 'unknown')); process.exit(1); });
