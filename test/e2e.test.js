// End-to-end API tests. Boots the real server on a random port with a
// throwaway database, then exercises every route group through real HTTP.
//
//   npm test                       — run against the default local backend
//   TURSO_DATABASE_URL=file:/tmp/t.db npm test   — run against the libsql backend
//
// No test framework needed — plain node:test (built into Node 20+).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'chemocure-test-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.PORT = '0'; // pick a free port
process.env.NODE_ENV = 'test';

let server;
let base;

// Cookie jars: tiny manual implementation so we can act as several users.
function jar() {
  const cookies = new Map();
  return {
    headers(extra = {}) {
      const cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      return cookie ? { ...extra, cookie } : extra;
    },
    absorb(res) {
      for (const line of res.headers.getSetCookie?.() || []) {
        const [pair] = line.split(';');
        const idx = pair.indexOf('=');
        cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
    },
  };
}

async function call(j, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: j.headers(body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  j.absorb(res);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON responses */ }
  return { status: res.status, data };
}

before(async () => {
  const { app } = await import('../src/app.js');
  const http = await import('node:http');
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const doctor = jar();
const stranger = jar();

test('health check responds', async () => {
  const r = await call(stranger, 'GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test('doctor registration', async () => {
  const r = await call(doctor, 'POST', '/api/auth/register', {
    name: 'Dr. Test Suite', email: 'suite@onco.test', password: 'SuitePass!2026',
    specialty: 'Neuro-Oncology',
  });
  assert.equal(r.status, 201);
});

test('duplicate email is rejected', async () => {
  const r = await call(stranger, 'POST', '/api/auth/register', {
    name: 'Dr. Dup', email: 'suite@onco.test', password: 'SuitePass!2026',
  });
  assert.equal(r.status, 409);
});

test('wrong password is rejected', async () => {
  const r = await call(stranger, 'POST', '/api/auth/login', {
    email: 'suite@onco.test', password: 'wrong-password',
  });
  assert.equal(r.status, 401);
});

test('doctor login sets a working session', async () => {
  const r = await call(doctor, 'POST', '/api/auth/login', {
    email: 'suite@onco.test', password: 'SuitePass!2026',
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.name, 'Dr. Test Suite');
});

test('unauthenticated requests are rejected', async () => {
  const r = await call(stranger, 'GET', '/api/sync');
  assert.equal(r.status, 401);
});

test('kv sync: doctor push/pull, patient login, scope enforcement', async () => {
  const push = await call(doctor, 'PUT', '/api/sync', {
    changes: {
      'pat_KV-42': { name: 'KV Patient', diag: 'Glioblastoma', pass: 'kv-plain-pw', docId: 'DOC-9' },
      'doc_DOC-9': { name: 'Dr. Test Suite', pass: 'doctor-secret-hash' },
    },
  });
  assert.equal(push.data.count, 2);

  const pull = await call(doctor, 'GET', '/api/sync');
  assert.equal(pull.data.keys['pat_KV-42'].v.name, 'KV Patient');

  const kvPatient = jar();
  const login = await call(kvPatient, 'POST', '/api/sync/patient-login', {
    mrn: 'KV-42', password: 'kv-plain-pw',
  });
  assert.equal(login.status, 200);
  // The doctor's profile comes back with credentials stripped.
  assert.equal(login.data.keys['doc_DOC-9'].v.pass, undefined);

  const ownWrite = await call(kvPatient, 'PUT', '/api/sync/patient', {
    changes: { 'log_KV-42_today': { fatigue: 1 } },
  });
  assert.equal(ownWrite.data.count, 1);

  const foreignWrite = await call(kvPatient, 'PUT', '/api/sync/patient', {
    changes: { 'doc_DOC-9': { pwned: true }, 'pat_OTHER': { x: 1 } },
  });
  assert.equal(foreignWrite.data.count, 0);
});

test('patient scope: exact key matching blocks arbitrary and foreign keys', async () => {
  await call(doctor, 'PUT', '/api/sync', { changes: {
    'pat_KV-99': { name: 'Other Pt', pass: 'other-pw', docId: 'DOC-9' },
    'msgs_KV-42': [{ from: 'doctor', text: 'hi' }],
    'invoices_KV-42': [{ id: 'i1', total: 100 }],
  }});
  const pt = jar();
  await call(pt, 'POST', '/api/sync/patient-login', { mrn: 'KV-42', password: 'kv-plain-pw' });
  const pull = await call(pt, 'GET', '/api/sync/patient');
  assert.ok(pull.data.keys['msgs_KV-42'], 'own message thread visible');
  assert.ok(pull.data.keys['invoices_KV-42'], 'own invoices visible');
  assert.ok(!pull.data.keys['pat_KV-99'], 'must not see another patient record');

  const w = await call(pt, 'PUT', '/api/sync/patient', { changes: {
    'log_KV-42_d2': { pain: 2 },       // own key family → allowed
    'evilkey_KV-42': { x: 1 },         // contains MRN but not an allowed pattern → rejected
    'pat_KV-99': { hijacked: true },   // foreign patient → rejected
  }});
  assert.equal(w.data.count, 1, 'only the own log should be written');
  const dpull = await call(doctor, 'GET', '/api/sync');
  assert.ok(!dpull.data.keys['evilkey_KV-42'], 'arbitrary key not injected');
  assert.ok(dpull.data.keys['log_KV-42_d2'], 'own log persisted');
  assert.ok(!dpull.data.keys['pat_KV-99'].v.hijacked, 'foreign record untouched');
});

test('patient scope: a prefix MRN cannot reach a longer MRN\'s keys (substring-collision fix)', async () => {
  // 'KV-4' is a substring of 'KV-42' — the old includes()-based match leaked here.
  await call(doctor, 'PUT', '/api/sync', { changes: {
    'pat_KV-4': { name: 'Short Mrn', pass: 'shortpw', docId: 'DOC-9' },
  }});
  const shortPt = jar();
  const login = await call(shortPt, 'POST', '/api/sync/patient-login', { mrn: 'KV-4', password: 'shortpw' });
  assert.equal(login.status, 200);
  const pull = await call(shortPt, 'GET', '/api/sync/patient');
  assert.ok(!pull.data.keys['pat_KV-42'], 'prefix MRN must not read the longer MRN record');
  assert.ok(!pull.data.keys['msgs_KV-42'], 'prefix MRN must not read the longer MRN messages');
  const w = await call(shortPt, 'PUT', '/api/sync/patient', { changes: {
    'pat_KV-42': { hijacked: true }, 'log_KV-42_x': { p: 1 },
  }});
  assert.equal(w.data.count, 0, 'prefix MRN cannot write the longer MRN keys');
});

test('patient scope: triage alerts sync for own MRN only', async () => {
  const pt = jar();
  await call(pt, 'POST', '/api/sync/patient-login', { mrn: 'KV-42', password: 'kv-plain-pw' });
  const w = await call(pt, 'PUT', '/api/sync/patient', { changes: {
    'alerts_DOC-9_KV-42': [{ type: 'triage', urgent: true, text: 'Red flag: fever 39.1°C' }], // own → allowed
    'alerts_DOC-9_KV-99': [{ type: 'triage', urgent: true, text: 'spoofed' }],               // foreign → rejected
  }});
  assert.equal(w.data.count, 1, 'only the own alerts key should be written');
  const dpull = await call(doctor, 'GET', '/api/sync');
  assert.ok(dpull.data.keys['alerts_DOC-9_KV-42'], 'doctor receives the patient red-flag alert');
  assert.ok(!dpull.data.keys['alerts_DOC-9_KV-99'], 'spoofed alert for another patient not written');
  // and the patient can pull their own alert history back
  const ppull = await call(pt, 'GET', '/api/sync/patient');
  assert.ok(ppull.data.keys['alerts_DOC-9_KV-42'], 'patient sees own alerts');
});

test('email: status reports unconfigured, OTP dev-mode round-trips, send is auth-gated', async () => {
  // No GMAIL_/SMTP_ vars in the test env → unconfigured mode.
  const status = await call(jar(), 'GET', '/api/email/status');
  assert.equal(status.status, 200);
  assert.equal(status.data.configured, false);

  // OTP request returns a devCode instead of sending mail.
  const otp = await call(jar(), 'POST', '/api/email/otp', { email: 'newdoc@test.dev', name: 'Dr New' });
  assert.equal(otp.status, 200);
  assert.equal(otp.data.sent, false);
  assert.match(otp.data.devCode, /^\d{6}$/);

  // Wrong code rejected, attempts counted; right code verifies and is single-use.
  const bad = await call(jar(), 'POST', '/api/email/otp/verify', { email: 'newdoc@test.dev', code: '000000' });
  assert.equal(bad.status, 400);
  const good = await call(jar(), 'POST', '/api/email/otp/verify', { email: 'newdoc@test.dev', code: otp.data.devCode });
  assert.equal(good.status, 200);
  assert.equal(good.data.ok, true);
  const replay = await call(jar(), 'POST', '/api/email/otp/verify', { email: 'newdoc@test.dev', code: otp.data.devCode });
  assert.equal(replay.status, 400, 'OTP must be single-use');

  // Outbound send requires authentication…
  const anon = await call(jar(), 'POST', '/api/email/send', { to: 'x@test.dev', subject: 'hi', text: 'hi' });
  assert.equal(anon.status, 401);
  // …and with auth but no mail config, reports 503 (clear config message).
  const authed = await call(doctor, 'POST', '/api/email/send', { to: 'x@test.dev', subject: 'hi', text: 'hi' });
  assert.equal(authed.status, 503);
});

test('cross-origin writes are rejected (CSRF guard)', async () => {
  const res = await fetch(base + '/api/sync', {
    method: 'PUT',
    headers: { ...doctor.headers({ 'content-type': 'application/json' }), origin: 'https://evil.example' },
    body: JSON.stringify({ changes: { hacked: 1 } }),
  });
  assert.equal(res.status, 403);
});

test('plaintext patient password is upgraded to a v2 hash on login', async () => {
  const probe = jar();
  await call(probe, 'POST', '/api/sync/patient-login', { mrn: 'KV-42', password: 'kv-plain-pw' });
  const pull = await call(doctor, 'GET', '/api/sync');
  const stored = pull.data.keys['pat_KV-42'].v.pass;
  assert.ok(String(stored).startsWith('pbkdf2v2:'), `expected v2 hash, got: ${stored}`);
  // and the upgraded hash still verifies
  const again = await call(jar(), 'POST', '/api/sync/patient-login', { mrn: 'KV-42', password: 'kv-plain-pw' });
  assert.equal(again.status, 200);
});

test('logout revokes the session server-side', async () => {
  const out = await call(doctor, 'POST', '/api/auth/logout');
  assert.equal(out.status, 200);
  const after_ = await call(doctor, 'GET', '/api/sync');
  assert.equal(after_.status, 401);
});

test('no plaintext PHI in the database file', () => {
  if (process.env.TURSO_DATABASE_URL && !process.env.TURSO_DATABASE_URL.startsWith('file:')) return;
  const path = process.env.TURSO_DATABASE_URL
    ? process.env.TURSO_DATABASE_URL.slice(5)
    : process.env.DB_PATH;
  const raw = readFileSync(path, 'latin1');
  for (const phi of ['KV Patient', 'Glioblastoma', 'kv-plain-pw', 'doctor-secret-hash']) {
    assert.ok(!raw.includes(phi), `plaintext PHI found in db: ${phi}`);
  }
});
