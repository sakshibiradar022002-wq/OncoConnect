# OncoConnect — Data Protection Impact Assessment (DPIA)

A DPIA template pre-filled for OncoConnect. The operating clinic (the Data
Fiduciary / Controller) should review, adapt to its jurisdiction and hosting,
and sign off before processing real patient data. Review at least annually and
whenever a new data flow is added (e.g. a new export or integration).

## 1. Processing description

- **What:** neuro-oncology symptom tracking, chemotherapy workflow support,
  triage, and (opt-in) de-identified research data.
- **Data subjects:** cancer patients; clinicians and lab staff (as users).
- **Personal data:** identifiers (name, MRN, DOB, phone, email); special-
  category health data (diagnosis, staging, molecular markers, prescriptions,
  labs, symptom diaries, quality-of-life scores).
- **Purposes & lawful basis:** direct medical care (provision of health care /
  legitimate interest of the treating clinic); research only on explicit,
  separate opt-in consent using de-identified data.
- **Recipients:** the treating clinic's authorised staff; the patient
  themselves; assigned labs (task-scoped). No third-party sharing by default.
- **Storage & transfers:** self-hosted by the clinic or on its chosen managed
  host; data location follows that host. No cross-border transfer is built in.
- **Retention:** per the clinic's medical-records policy; no automatic purge.

## 2. Necessity & proportionality

Collection is limited to what direct oncology care requires. Research uses
de-identified data only (pseudonymous IDs, relative dates, age bands, free-text
excluded). Access is least-privilege: clinicians see only their own patients,
labs only their tasks, patients only their own record.

## 3. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | Residual |
|---|---|---|---|---|
| Unauthorised access to PHI | Low | High | AES-256-GCM at rest; PBKDF2 passwords; httpOnly revocable sessions; RBAC per-query ownership; optional 2FA | Low |
| Data leak across clinics (multi-tenant) | Low | High | Every query scoped by owner/tenant id; automated cross-tenant isolation test in CI | Low |
| Account takeover | Low | High | Password policy (≥10, letter+digit); rate-limited auth; optional TOTP; server-side session revocation | Low |
| Re-identification of research data | Low | Medium | Pseudonymous IDs (salted hash, salt stays local), relative dates, age bands, no free text | Low |
| Consent not honoured / stale | Low | Medium | Versioned consent, per-patient consent record + append-only history, one-tap withdrawal that stops collection | Low |
| Tampering with clinical records | Low | High | Hash-chained tamper-evident audit trail; integrity check in Governance tab | Low |
| Loss of encryption key | Low | High | Key held only in env; documented backup + rotation script; loss = unrecoverable (documented) | Medium |
| Availability / outage during care | Medium | Medium | Health checks + auto-restart; offline-capable PWA; graceful degradation (core flows survive analytics/export failure); email/push retry with backoff | Low |
| Sending OTP/reminder to wrong address | Low | Medium | Email validated; OTP hashed, single-use, expiring, rate-limited | Low |

## 4. Residual risk & sign-off

Residual risk is assessed **low-to-moderate**, the main open item being
encryption-key custody (operational, not technical). The clinic's DPO signs off
after completing §5.

## 5. Outstanding actions before go-live (owner: clinic)

- Independent security assessment / penetration test.
- Confirm hosting region and any data-transfer safeguards.
- Ethics-committee / IRB approval for any research use.
- Signed data-processing agreement with the hosting provider.
- Validate all clinical reference content against institutional protocols.
- Document the key-backup custody procedure and test key rotation.

## 6. Review

| Date | Reviewer | Change | Next review |
|---|---|---|---|
| _(to complete)_ | _(clinic DPO)_ | Initial adoption | +12 months or on new data flow |
