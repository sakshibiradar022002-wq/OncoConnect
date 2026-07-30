-- OncoConnect database schema.
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
-- Indexes optimized for common query patterns
CREATE INDEX IF NOT EXISTS idx_kv_key ON kv_store(k);
CREATE INDEX IF NOT EXISTS idx_kv_owner_key ON kv_store(owner_id, k);
CREATE INDEX IF NOT EXISTS idx_kv_owner_updated ON kv_store(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kv_pattern ON kv_store(k COLLATE NOCASE);  -- for LIKE queries

-- ── Web push subscriptions (one row per device) ──
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,            -- push service URL, unique per device
  subject_id TEXT NOT NULL,               -- who receives: user id or owner::mrn
  sub_enc    TEXT NOT NULL,               -- encrypted subscription JSON
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subject ON push_subs(subject_id);

-- ── Email OTPs: server-generated registration codes (hashed, single-use) ──
CREATE TABLE IF NOT EXISTS email_otps (
  email      TEXT PRIMARY KEY,             -- lowercased address being verified
  code_hash  TEXT NOT NULL,                -- sha256(email|code) — never plaintext
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

-- ── Team members: doctors can invite colleagues to share patients ──
CREATE TABLE IF NOT EXISTS team_members (
  id         TEXT PRIMARY KEY,             -- uuid
  team_id    TEXT NOT NULL,                -- clinic/practice identifier
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'doctor', 'specialist')),
  specialty  TEXT,                         -- e.g., 'Neuro-oncology', 'Oncology Nurse'
  joined_at  TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

-- ── Team invitations: email invites sent but not yet accepted ──
CREATE TABLE IF NOT EXISTS team_invites (
  id         TEXT PRIMARY KEY,             -- uuid
  team_id    TEXT NOT NULL,
  email      TEXT NOT NULL,                -- invitee email
  role       TEXT NOT NULL CHECK (role IN ('doctor', 'specialist')),
  invite_code TEXT NOT NULL,               -- unique code for accepting invite
  invited_by TEXT NOT NULL,                -- inviter user id
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,                        -- null if not yet accepted
  FOREIGN KEY (invited_by) REFERENCES users(id),
  UNIQUE(team_id, email)
);
CREATE INDEX IF NOT EXISTS idx_invites_code ON team_invites(invite_code);
CREATE INDEX IF NOT EXISTS idx_invites_team ON team_invites(team_id);

-- ── Patient access permissions: who can see which patients ──
-- By default, patient owner can see their own patients.
-- This table grants explicit access to other doctors.
CREATE TABLE IF NOT EXISTS patient_access (
  patient_mrn TEXT NOT NULL,              -- patient MRN key
  owner_id    TEXT NOT NULL,              -- original patient owner
  doctor_id   TEXT NOT NULL,              -- doctor who can access
  access_type TEXT NOT NULL CHECK (access_type IN ('view', 'edit', 'manage')),
  granted_at  TEXT NOT NULL,
  PRIMARY KEY (patient_mrn, owner_id, doctor_id),
  FOREIGN KEY (owner_id) REFERENCES users(id),
  FOREIGN KEY (doctor_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_access_doctor ON patient_access(doctor_id);
CREATE INDEX IF NOT EXISTS idx_access_owner ON patient_access(owner_id);
