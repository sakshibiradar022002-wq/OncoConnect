# OncoConnect — Clinic Implementation Kit

Everything a clinic needs to run a pilot. Pair this with GOVERNANCE.md
(data handling) and DPIA.md (risk sign-off).

## What OncoConnect does (one line each)

- **Patients** log symptoms and quality-of-life, see clear "when to call now"
  triage, and message their team — in English or Hindi, with accessibility modes.
- **Doctors** get structured toxicity data (CTCAE-graded), a protocol library
  with schedule generation, dose guardrails, smart low-noise alerts, saved
  high-risk views, and impact analytics.
- **Labs** work a prioritised worklist and upload results against assigned tasks.
- **Clinic** gets encrypted cross-device sync, a tamper-evident audit trail, a
  governance dashboard, and consent-gated de-identified research export.

## Who uses what

| Role | App | Signs in with |
|---|---|---|
| Doctor | `/` (doctor app) | email + password (optional 2FA) |
| Patient | `/patient.html` | MRN + password (issued by the doctor) |
| Lab technician | `/patient.html` → Lab tab | username + password (issued by the doctor) |
| Clinic admin | `/` (first-registered account) | email + password; sees admin + metrics |

## Sample pilot: brain-tumour clinic

- **Scope:** 20 patients on chemotherapy, 3 months.
- **Setup (week 0):** deploy; register the clinic admin/doctor; set the clinic
  emergency number (Clinic Management → emergency number); pick protocols to use.
- **Onboarding (week 1):** register each patient (auto-generates MRN + password),
  share credentials, walk them through the consent screen and daily diary.
- **Run (weeks 2–12):** patients log daily; doctor reviews smart alerts and the
  high-risk view; labs upload results against tasks.
- **Readout (week 12):** export the **Pilot summary** (Impact tab) and the
  Governance figures for the review meeting.

## Data flow (where data goes)

1. Patient logs a symptom → stored encrypted on the server, scoped to that
   patient → visible only to their doctor.
2. A CTCAE ≥3 entry → raises a smart alert **and** creates a clinic recall task.
3. Doctor prescribes → dose guardrails + interaction checks run → order recorded
   with a tamper-evident audit entry.
4. Lab uploads a result against a task → doctor is notified.
5. Research export → only consented patients, de-identified, audit-logged.

Consent is captured up front (versioned, bilingual) with a **separate** research
opt-in; patients can view their consent history and withdraw at any time.

## Support & tiers (indicative)

| Tier | For | Includes |
|---|---|---|
| **Pilot** | first clinics | core features, self-hosted, community support, free/low-cost |
| **Standard clinic** | ongoing use | full features, email support, defined response time |
| **Research partner** | study sites | extra exports/analytics, research collaboration support |

Support channel and response-time expectations are set per engagement; outages
follow the incident process in GOVERNANCE.md §8.

## Deploy in 5 minutes (self-host)

```bash
git clone https://github.com/sakshibiradar022002-wq/OncoConnect
cd OncoConnect && npm install
cp .env.example .env
node -e "console.log('JWT_SECRET='+require('crypto').randomBytes(32).toString('hex'))" >> .env
node -e "console.log('PHI_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex'))" >> .env
npm run init-db && npm start
```

For Gmail verification codes + reminders, add `GMAIL_USER` and
`GMAIL_APP_PASSWORD` (see README). Managed hosting (Render/Fly) and the
deployment/rollback runbook are in GOVERNANCE.md §10.
