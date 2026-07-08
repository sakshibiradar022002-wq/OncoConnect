-- ChemoCure database schema.
-- PHI columns store AES-256-GCM encrypted blobs (see crypto.js).
-- Non-PHI columns (ids, timestamps, roles, foreign keys) stay plaintext for indexing.

PRAGMA journal_mode = WAL;      -- concurrent reads, safer writes
PRAGMA foreign_keys = ON;

-- ── Users: doctors, lab technicians, (patients handled separately) ──
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
  last_login    TEXT,
  FOREIGN KEY (lab_id) REFERENCES labs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role  ON users(role);

-- ── Patients ──
CREATE TABLE IF NOT EXISTS patients (
  id            TEXT PRIMARY KEY,          -- uuid
  mrn           TEXT UNIQUE NOT NULL,      -- login identifier, not PHI
  password_hash TEXT NOT NULL,
  doctor_id     TEXT NOT NULL,             -- owning clinician
  record_enc    TEXT,                      -- the entire clinical record, encrypted JSON
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_login    TEXT,
  FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_patients_mrn    ON patients(mrn);
CREATE INDEX IF NOT EXISTS idx_patients_doctor ON patients(doctor_id);

-- ── Labs ──
CREATE TABLE IF NOT EXISTS labs (
  id          TEXT PRIMARY KEY,
  doctor_id   TEXT NOT NULL,               -- lab is registered under a doctor
  name_enc    TEXT,                        -- encrypted lab name
  meta_enc    TEXT,                        -- encrypted contact/address
  created_at  TEXT NOT NULL,
  FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_labs_doctor ON labs(doctor_id);

-- ── Lab tasks (doctor assigns test → lab uploads result) ──
CREATE TABLE IF NOT EXISTS lab_tasks (
  id          TEXT PRIMARY KEY,
  doctor_id   TEXT NOT NULL,
  lab_id      TEXT NOT NULL,
  patient_id  TEXT NOT NULL,
  payload_enc TEXT,                        -- encrypted: description, priority, patient name
  due_date    TEXT,                        -- plaintext date for sorting
  priority    TEXT DEFAULT 'Routine',      -- plaintext for sorting
  status      TEXT NOT NULL DEFAULT 'Pending Upload',
  created_at  TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (doctor_id)  REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (lab_id)     REFERENCES labs(id)      ON DELETE CASCADE,
  FOREIGN KEY (patient_id) REFERENCES patients(id)  ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tasks_lab     ON lab_tasks(lab_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_doctor  ON lab_tasks(doctor_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_patient ON lab_tasks(patient_id);

-- ── Lab submissions (uploaded results) ──
CREATE TABLE IF NOT EXISTS lab_submissions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  lab_id      TEXT NOT NULL,
  patient_id  TEXT NOT NULL,
  data_enc    TEXT,                        -- encrypted: results, filenames, notes
  created_at  TEXT NOT NULL,
  FOREIGN KEY (task_id)    REFERENCES lab_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (lab_id)     REFERENCES labs(id)      ON DELETE CASCADE,
  FOREIGN KEY (patient_id) REFERENCES patients(id)  ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subs_patient ON lab_submissions(patient_id);

-- ── Messages (doctor ↔ patient) ──
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('doctor','patient')),
  body_enc    TEXT,                        -- encrypted message text
  created_at  TEXT NOT NULL,
  read_at     TEXT,
  FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_msgs_patient ON messages(patient_id, created_at);

-- ── Appointments ──
CREATE TABLE IF NOT EXISTS appointments (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL,
  data_enc    TEXT,                        -- encrypted: type, notes
  date        TEXT NOT NULL,               -- plaintext for sorting
  time        TEXT,
  status      TEXT DEFAULT 'Scheduled',
  created_at  TEXT NOT NULL,
  FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_appts_patient ON appointments(patient_id, date);

-- ── Daily symptom logs ──
CREATE TABLE IF NOT EXISTS symptom_logs (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL,
  log_date    TEXT NOT NULL,               -- plaintext date for querying
  data_enc    TEXT,                        -- encrypted: all symptom scores
  created_at  TEXT NOT NULL,
  UNIQUE(patient_id, log_date),
  FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_logs_patient ON symptom_logs(patient_id, log_date);

-- ── Audit trail: every write, who did it, when (append-only) ──
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,                        -- user or patient id
  actor_role  TEXT,
  action      TEXT NOT NULL,               -- e.g. 'patient.update', 'lab_task.create'
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
  subject_type TEXT NOT NULL,              -- 'user' | 'patient'
  role        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_subject ON sessions(subject_id);
