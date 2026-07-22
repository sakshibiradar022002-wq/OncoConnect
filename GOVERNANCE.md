# OncoConnect — Governance, Privacy & Clinical Safety

This document is the reference a hospital data-protection officer, ethics
committee, or auditor would ask for. It states what data OncoConnect handles,
why, where it lives, how long it is kept, and how patient rights are honoured.
It is a living document; the app's **Clinic Management → 🛡 Governance** tab
shows the live figures (consent coverage, audit integrity, security events).

## 1. What data is collected and why

| Category | Examples | Lawful basis / purpose |
|---|---|---|
| Identifiers | Name, MRN, date of birth, phone, email | Deliver care; identify the patient across visits |
| Clinical | Diagnosis, staging, molecular markers, prescriptions, labs, imaging notes | Direct oncology care |
| Patient-reported | Symptom diary, CTCAE-graded scores, FACT-Br quality-of-life | Monitor toxicity between visits; safety triage |
| Operational | Appointments, invoices, clinic tasks, inventory | Run the clinic |
| Consent | Version accepted, timestamp, language, research opt-in, withdrawal | Prove and honour consent |
| Audit | Who changed what, when, from what IP | Security, accountability, tamper-evidence |

Collection is limited to what direct care and clinic operations require. The
research pathway uses **de-identified** data only (see §4).

## 2. Where data is stored and how it is protected

- **At rest:** every clinical/PHI field is encrypted with **AES-256-GCM**
  (per-record IV + auth tag). Only non-PHI index columns (internal ids,
  MRNs/emails as login identifiers, timestamps, roles, foreign keys) are
  plaintext. Master key comes from `PHI_ENCRYPTION_KEY` (env), never hard-coded.
- **Passwords:** PBKDF2-SHA512, 210k iterations, per-user salt, timing-safe
  comparison. Registration requires ≥10 chars with a letter and a digit.
  Optional TOTP 2FA for clinician accounts.
- **In transit:** HTTPS only in production; strict CSP and hardening headers
  via Helmet; CSRF origin check on all state-changing API calls.
- **Sessions:** JWT in an httpOnly, sameSite cookie backed by a server-side
  session row, so logout/revocation is real. Configurable idle timeout
  (`SESSION_TTL_MIN`).
- **Access control (RBAC):** doctors see only their own patients (ownership
  enforced per query); labs see only tasks assigned to them; patients see only
  their own keyspace. Enforcement is server-side, not just in the UI.

## 3. Retention, deletion, backup & disaster recovery

- **Retention:** clinical records are retained per the operating institution's
  medical-records policy (typically the statutory minimum for oncology). The
  app does not auto-purge clinical data.
- **Deletion:** clinicians can delete a patient record (audit-logged, with a
  short undo window). On a verified patient request, the clinic performs
  erasure subject to legal retention duties.
- **Consent withdrawal:** stops further collection immediately and signs the
  patient out; the existing medical record is retained as legally required and
  the withdrawal is recorded.
- **Backup:** JSON/DB export from Data & Backup; `scripts/backup.js` writes
  timestamped DB snapshots (keeps the last 30). Restore is a merge that never
  overwrites existing records.
- **Key management:** `PHI_ENCRYPTION_KEY` must be backed up separately — if
  lost, encrypted data is unrecoverable. `scripts/rotate-phi-key.js` supports
  key rotation.

## 4. Patient rights (DPDP Act 2023 / GDPR mapping)

| Right | How OncoConnect honours it |
|---|---|
| Notice / transparency | Versioned in-app consent screen (English + Hindi) explaining data, purpose, rights before any processing |
| Access / portability | Patient App → Data & Backup exports the patient's full data as JSON any time |
| Correction | Patient asks the clinic; clinicians edit the record (audit-logged) |
| Erasure | Withdraw consent + clinic-side deletion, subject to legal retention |
| Consent & withdrawal | Explicit opt-in; separate, off-by-default research opt-in; one-tap withdrawal in Profile → Privacy |
| Grievance / contact | Via the treating clinic (the data fiduciary) |

**Roles under the law:** the operating clinic/hospital is the **Data
Fiduciary** (GDPR: Controller); OncoConnect-the-software is the tool it
operates. When self-hosted, the clinic is also the processor.

## 5. Consent versioning

Consent text carries a `CONSENT_VERSION`. Each patient record stores the
version accepted, the timestamp, the language shown, and the research choice.
Raising the version re-prompts every patient at next login. Withdrawal is
timestamped and blocks further collection. The Governance tab shows live
consent coverage.

## 6. Audit & tamper-evidence

Every clinical change writes an append-only audit entry (actor, time, section,
before/after) that is **hash-chained** to the previous entry. Any edit or
deletion breaks the chain and is surfaced by the Governance tab's integrity
check. Server-side, every sync/login/logout is additionally logged with actor,
timestamp and IP in an append-only table.

## 7. Clinical safety & medical-device positioning

- **Decision support, not autonomous decision-making.** Dose caps, the
  carboplatin AUC calculator, stale-lab checks, duplicate-order and allergy
  warnings, and the drug-interaction list are **advisory**. A clinician
  confirms every order; overriding a warning requires a recorded reason.
- **Indicative risk classification.** As clinical decision-support software
  that informs (not replaces) a qualified oncologist, this is expected to fall
  in a **lower-moderate risk class** (indicative: EU MDR Class IIa / India CDSCO
  Class B–C). **This is not a regulatory determination.** Formal classification,
  clinical evaluation, and any certification must be completed with a qualified
  regulatory consultant before clinical deployment.
- **Reference content is illustrative.** Protocol templates, the drug-
  interaction list, and dose caps are curated examples for prototype use and
  must be reconciled with the institution's validated protocols and a
  maintained interaction database (e.g. DrugBank/Lexicomp) before clinical use.

## 8. Incident response

Suspected breach or data-integrity failure: (1) preserve the audit trail and
DB snapshot; (2) revoke affected sessions and rotate `JWT_SECRET`; (3) if PHI
exposure is suspected, rotate `PHI_ENCRYPTION_KEY` via the rotation script; (4)
notify the operating clinic's DPO, who handles regulator/data-principal
notification within statutory timelines.

## 9. Outstanding before clinical go-live

These require work outside the codebase and are **not** claimed as done:

- Formal DPIA and medical-device classification with a regulatory consultant.
- Independent security assessment / penetration test.
- Ethics-committee review for any research use of data.
- A signed data-processing agreement between the clinic and any hosting provider.
- Validation of all clinical reference content against institutional protocols.

---
*This document describes the software's design intent and controls. It does not
constitute legal or regulatory advice.*
