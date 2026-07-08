# ChemoCure — Security Posture

This document describes how patient data (PHI) is protected. It reflects what is
**actually implemented and tested**, not aspirations.

## Threat model

The system defends against:
- **Database theft / disk access** — an attacker who copies the SQLite file.
- **Cross-tenant access** — one doctor trying to read another doctor's patients; a lab
  tech trying to read clinical data; a patient trying to read another patient's records.
- **Session hijacking** — stolen or replayed session tokens.
- **XSS / CSRF** — script injection and cross-site request forgery.
- **Brute-force** — password guessing and credential stuffing.
- **Tampering** — silent modification of encrypted records.

It does **not** by itself provide: network-layer protection (rely on the host's HTTPS),
formal HIPAA/GDPR certification (a legal/organizational process), or protection against a
fully compromised server host with the live encryption key in memory.

## Encryption at rest (PHI)

- **Algorithm:** AES-256-GCM (authenticated encryption).
- **Scope:** every clinical field — patient names, diagnoses, molecular results, lab
  values, messages, appointment notes, symptom logs, and audit diffs.
- **Per-record IV:** each blob gets a fresh 12-byte random IV, so identical plaintext
  never produces identical ciphertext.
- **Integrity:** the GCM auth tag means any tampering with the ciphertext is detected —
  `decryptPHI` returns `null` rather than trusting altered data.
- **Format:** `v1.<iv_b64>.<tag_b64>.<ciphertext_b64>` (versioned for future key rotation).
- **Verified:** automated tests read the raw DB file and confirm no plaintext PHI
  (diagnoses, names, message bodies, appointment notes, symptom notes) is ever present.

**What is intentionally plaintext:** only non-PHI columns needed for indexing/sorting —
internal ids, MRNs and emails (login identifiers), dates, statuses, priorities, roles,
and foreign keys. No clinical content is among these.

## The master key

- Comes only from the `PHI_ENCRYPTION_KEY` env var (64 hex chars = 32 bytes). Never
  hard-coded, never written to the database, never logged.
- Format is validated at boot; the server refuses to start in production without it.
- **Single point of failure by design:** if lost, encrypted data is unrecoverable; if
  leaked, rotate it (decrypt-all → re-encrypt with new key → swap). The `v1.` version
  prefix exists to support this rotation.
- **Operational requirement:** back the key up separately from the database, in a secrets
  manager (host dashboard, Vault, etc.).

## Passwords

- **PBKDF2-SHA512**, **210,000 iterations** (meets current OWASP guidance), 16-byte
  per-user random salt.
- Stored as `pbkdf2$iterations$salt$hash` — never reversible.
- Verification uses `crypto.timingSafeEqual` to prevent timing attacks.
- Generated patient/lab passwords use a CSPRNG (`crypto.randomBytes`), not `Math.random`.

## Sessions & authentication

- JWT stored in an **httpOnly** cookie (JavaScript cannot read it → XSS can't steal it).
- **`secure`** flag on in production (HTTPS-only), **`sameSite=lax`** (CSRF mitigation).
- Backed by a **server-side `sessions` table** — logout and revocation are real, not just
  waiting for token expiry. Every session has a unique `jti`.
- Configurable TTL (default 120 min).

## Access control (RBAC)

Enforced per query, not just per route:
- **Doctors** can only touch patients where `patients.doctor_id === their id`. A second
  doctor gets `403` on another's patient — tested.
- **Patients** are scoped to `req.auth.subjectId`; any `patientId` they send is ignored
  and replaced with their own id. They cannot address another patient's records.
- **Lab techs** are blocked from all clinical routes (messages/appointments/symptoms)
  entirely — tested `403`.
- **Unauthenticated** requests get `401` — tested.

## Transport & headers

- **Helmet** sets a strict Content-Security-Policy (self + explicit CDN/font origins),
  plus HSTS, no-sniff, frame-guard, and related hardening headers.
- **Rate limiting:** 30 auth attempts / 15 min and 300 API calls / min per IP.
- **Zod** validates and bounds every request body before it reaches the database
  (also prevents oversized-payload abuse).

## Input / injection safety

- All database access uses **parameterized prepared statements** — no string-built SQL,
  so SQL injection is structurally prevented.
- Request bodies are schema-validated (types, lengths, enums) before use.

## Auditability

- Every mutating action writes to an append-only `audit_log`: **who** (actor id + role),
  **what** (action), **which record** (target id), **from where** (IP), **when**, and an
  **encrypted** field-level diff. This is the "who changed what" trail.

## Known gaps / honest scope

- **Server memory:** while running, the key and decrypted PHI live in process memory. A
  fully compromised host is out of scope for app-level crypto (true of all such systems).
- **File uploads** (lab result PDFs) are still base64 — moving to object storage (S3-style)
  with server-side encryption is a recommended next step for large files.
- **MFA** for clinicians is not yet implemented — a strong addition before real clinical use.
- **Key rotation script** is documented but not yet automated.
- **HIPAA/GDPR:** the technical controls support compliance but formal certification is a
  separate legal/organizational process. Do not use with real patient data until reviewed.
