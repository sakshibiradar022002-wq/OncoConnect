-- ChemoCure database schema.
-- PHI columns store AES-256-GCM encrypted blobs (see crypto.js).
-- Non-PHI columns (ids, timestamps, roles) stay plaintext for indexing.

PRAGMA journal_mode = WAL;      -- concurrent reads, safer writes
PRAGMA foreign_keys = ON;

-- ── Users: doctor accounts (patients and labs authenticate via kv_store) ──
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- uuid
  email         TEXT UNIQUE NOT NULL,      -- lowercased; not PHI (login identifier)
  password_hash TEXT NOT NULL,             -- pbkdf2$...
  role          TEXT NOT NULL CHECK (role IN ('doctor','lab','admin')),
  name_enc      TEXT,                      -- encrypted display name
  meta_enc      TEXT,                      -- encrypted JSON: specialty, institution, etc.
  lab_id        TEXT,                      -- if role='lab', which lab they belong to
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_login    TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role  ON users(role);

-- ── Audit trail: every write, who did it, when (append-only) ──
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,                        -- user or patient id
  actor_role  TEXT,
  action      TEXT NOT NULL,               -- e.g. 'sync.push', 'user.login'
  target_id   TEXT,                        -- affected record id
  detail_enc  TEXT,                        -- encrypted field-level diff
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log(actor_id);

-- ── Sessions (server-side, revocable) ──
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,            -- session token id (jti)
  subject_id  TEXT NOT NULL,               -- user or patient id
  subject_type TEXT NOT NULL,              -- 'user' | 'kv-patient' | 'kv-lab'
  role        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_subject ON sessions(subject_id);

-- ── Synced key-value store: encrypted server mirror of the app UIs' data ──
-- The doctor/patient UIs keep working data in localStorage (cc_* keys).
-- Each account's keyspace is mirrored here so data follows the account
-- across devices. Values are whole JSON blobs, encrypted like all PHI.
CREATE TABLE IF NOT EXISTS kv_store (
  owner_id   TEXT NOT NULL,               -- doctor user id
  k          TEXT NOT NULL,               -- localStorage key without the cc_ prefix
  v_enc      TEXT NOT NULL,               -- encrypted JSON value
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, k)
);
CREATE INDEX IF NOT EXISTS idx_kv_key ON kv_store(k);
