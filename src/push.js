// Web push notifications. VAPID keys come from env (VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY); if absent, a pair is generated once and persisted in
// kv_store under a system owner so subscriptions survive restarts.

import webpush from 'web-push';
import { db } from './db/index.js';
import { encryptPHI, decryptPHI } from './crypto.js';

let vapidPublicKey = null;
let ready = false;

export async function initPush() {
  let pub = process.env.VAPID_PUBLIC_KEY;
  let priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const row = await db.prepare("SELECT v_enc FROM kv_store WHERE owner_id = 'system' AND k = 'vapid_keys'").get();
    if (row) {
      const saved = decryptPHI(row.v_enc);
      if (saved) { pub = saved.pub; priv = saved.priv; }
    }
    if (!pub || !priv) {
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey; priv = keys.privateKey;
      await db.prepare(`
        INSERT INTO kv_store (owner_id, k, v_enc, updated_at) VALUES ('system', 'vapid_keys', ?, ?)
        ON CONFLICT(owner_id, k) DO UPDATE SET v_enc = excluded.v_enc, updated_at = excluded.updated_at
      `).run(encryptPHI({ pub, priv }), new Date().toISOString());
      console.log('[push] generated + persisted VAPID keys');
    }
  }
  webpush.setVapidDetails('mailto:admin@oncoconnect.local', pub, priv);
  vapidPublicKey = pub;
  ready = true;
}

export function getVapidPublicKey() { return vapidPublicKey; }

export async function saveSubscription(subjectId, subscription) {
  await db.prepare(`
    INSERT INTO push_subs (endpoint, subject_id, sub_enc, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET subject_id = excluded.subject_id, sub_enc = excluded.sub_enc
  `).run(subscription.endpoint, subjectId, encryptPHI(subscription), new Date().toISOString());
}

export async function removeSubscription(endpoint) {
  await db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
}

// Send to every device subscribed for a subject. `match` may be an exact
// subject_id or a LIKE pattern (e.g. '%::MRN-123' for a kv patient).
export async function notifySubject(match, payload) {
  if (!ready) return;
  const rows = match.includes('%')
    ? await db.prepare('SELECT endpoint, sub_enc FROM push_subs WHERE subject_id LIKE ?').all(match)
    : await db.prepare('SELECT endpoint, sub_enc FROM push_subs WHERE subject_id = ?').all(match);
  for (const r of rows) {
    const sub = decryptPHI(r.sub_enc);
    if (!sub) continue;
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600 });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) await removeSubscription(r.endpoint); // expired
    }
  }
}

// ── Appointment reminders: hourly scan, push to patients the day before ──
const reminded = new Set(); // mrn|date, per process
export function startAppointmentReminders() {
  const tick = async () => {
    try {
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const rows = await db.prepare("SELECT owner_id, k, v_enc FROM kv_store WHERE k LIKE 'appts_%' AND k NOT LIKE '%_doc'").all();
      for (const r of rows) {
        const mrn = r.k.slice('appts_'.length);
        const appts = decryptPHI(r.v_enc);
        if (!Array.isArray(appts)) continue;
        for (const a of appts) {
          if (a.date !== tomorrow || a.status === 'Cancelled') continue;
          const mark = mrn + '|' + a.date;
          if (reminded.has(mark)) continue;
          reminded.add(mark);
          await notifySubject('%::' + mrn, {
            title: 'Appointment tomorrow',
            body: `${a.type || 'Visit'} on ${a.date}${a.time ? ' at ' + a.time : ''}. Tap to review.`,
            url: '/patient.html',
          });
        }
      }
    } catch (err) { console.error('[push] reminder scan failed:', err.message); }
  };
  setInterval(tick, 60 * 60 * 1000);
  setTimeout(tick, 15000); // first scan shortly after boot
}
