# Troubleshooting Runbook

Diagnose and fix common OncoConnect production problems.

## First: triage in 60 seconds

Run these before diving into any specific symptom. They separate "everything is
down" from "one feature is broken", which changes what you do next.

```bash
BASE=https://oncoconnect-server.onrender.com

curl -s $BASE/health                  # process up?
curl -s "$BASE/health?deep=1"         # database reachable?
curl -s -o /dev/null -w '%{http_code}\n' $BASE/   # frontend served?
```

| Result | Meaning | Go to |
|---|---|---|
| No response at all | Service down | [Service down](#service-down) |
| `/health` ok, `?deep=1` 503 | App up, DB unreachable | [Database issues](#database-issues) |
| Both ok, feature broken | Application-level bug | Symptom sections below |

Then check the structured logs and metrics — they usually name the problem:

```bash
docker logs oncoconnect 2>&1 | grep '"status":5' | tail -20
# Render: dashboard → Service → Logs, filter on "status":5
```

## Service down

### Symptom: no HTTP response, or Render shows the service as failed

**1. Read the startup logs.** The app hard-fails fast and says why.

| Log line | Cause | Fix |
|---|---|---|
| `[FATAL] Missing required environment variable: JWT_SECRET` | Secret not set in production | Set it in Render → Environment, redeploy |
| `[FATAL] Missing required environment variable: PHI_ENCRYPTION_KEY` | Same | Set the **original** key value, not a new one |
| `[FATAL] PHI_ENCRYPTION_KEY is too short` | Key under 16 chars | Use 64 hex chars |
| `EADDRINUSE` | Port already bound | Another process on `PORT`; kill it or change `PORT` |

**2. If the process starts then exits**, an unhandled error during
`initSchema()` or `initPush()` is the usual cause. The stack trace is in the
logs — look for the first stderr line after startup.

**3. If nothing is obviously wrong**, roll back to the last known-good deploy
([Deployment → Rollback](DEPLOYMENT.md#rollback)) and investigate with traffic
restored. Do not debug a total outage in production while users wait.

## Database issues

### Symptom: `/health?deep=1` returns 503 `database unreachable`

The process is healthy; `SELECT 1` failed.

**Turso backend:**
```bash
turso db show oncoconnect          # is the database alive?
turso db tokens create oncoconnect # mint a fresh token if expired
```
Expired `TURSO_AUTH_TOKEN` is the most frequent cause. Update the env var and
redeploy.

**File backend:**
```bash
ls -l /var/data/chemocure.db       # file present?
df -h /var/data                    # disk full?
sqlite3 /var/data/chemocure.db "PRAGMA integrity_check;"
```
A full disk presents as write failures while reads still work — check `df`
before assuming corruption. `integrity_check` returning anything other than
`ok` means restore from backup ([Backup & Recovery](BACKUP_RECOVERY.md#database-corruption)).

### Symptom: `database is locked` errors under load

SQLite allows one writer at a time. Concurrent `PUT /api/sync` from several
doctors can contend.

1. Confirm from logs: `grep 'SQLITE_BUSY\|database is locked'`.
2. Short term: this resolves itself as load drops — the writes are queued, not lost.
3. Long term: move to Turso, which handles concurrency properly, or reduce sync
   frequency in the client. See [Scaling](SCALING.md).

### Symptom: data disappears after every deploy

`DB_EPHEMERAL=true` is set. The database is in-memory and resets on restart.
Remove the variable and configure Turso or a mounted disk. Data written while
ephemeral is unrecoverable.

## Authentication issues

### Symptom: all doctors suddenly logged out

`JWT_SECRET` changed — existing session tokens no longer verify. This is
harmless: users log in again and sessions re-issue. If unintentional, restore
the previous value to avoid a second round of forced logouts.

### Symptom: correct password rejected

Check in this order:

1. **Account deactivated.** The login query filters on `active = 1`. With
   `REQUIRE_DOCTOR_APPROVAL=true`, every account after the first starts
   inactive. Approve it:
   ```bash
   npm run make-admin -- doctor@example.com doctor
   ```
   (This sets `active = 1` as well as the role.)

2. **Rate limited.** 30 auth attempts per 15 min per IP. The response is
   429 with `Too many attempts`. A whole clinic behind one NAT can hit this
   collectively — check whether several users are affected from the same site.

3. **2FA enabled but no code sent.** Response is 401 with
   `{"totpRequired":true}`. The client must prompt for the TOTP code.

### Symptom: `TOTP code required` but the user's codes never work

Almost always clock drift on the user's device — TOTP is time-based. Have them
enable automatic time sync. If they are locked out, an admin can clear the
second factor directly:
```bash
sqlite3 /var/data/chemocure.db \
  "UPDATE users SET totp_enc = NULL WHERE email = 'doctor@example.com';"
```
Record this in the incident log — disabling someone's 2FA is a security-relevant
action and belongs in the audit trail.

### Symptom: patient cannot log in with correct MRN

1. MRN is uppercased and trimmed server-side, so case is not the issue.
2. The patient record must exist as `pat_<MRN>` in the owning doctor's keyspace.
   If the doctor never synced after creating the patient, the server has no record:
   have the doctor open the app and let it sync.
3. Legacy patient records may hold plaintext passwords; these are upgraded to
   PBKDF2 on first successful login. A failure here means the password itself is wrong.

## Sync issues

### Symptom: doctor's changes are not appearing on other devices

1. **Confirm the push actually reached the server** — look for
   `"flow":"sync.doctor_push"` with `"status":200` in the logs for that actor.
2. **No 200s at all** → the client is offline or its session expired. Session
   TTL defaults to 120 minutes (`SESSION_TTL_MIN`); an idle tab silently stops
   syncing until the user reloads and logs in.
3. **200s present but data missing** → check the response `count`. A `count` of
   0 means every key was filtered out. For patient and lab sessions this is
   expected behaviour when keys fall outside their scope (see below).

### Symptom: patient's diary entries are rejected or silently dropped

Patient pushes are scoped by `patientOwnsKey()` — only keys belonging to that
MRN are accepted, everything else is silently skipped. This is deliberate
isolation, not a bug. Accepted key families:

`pat_<mrn>`, `msgs_<mrn>`, `appts_<mrn>`, `lab_subs_<mrn>`, `pat_tokens_<mrn>`,
`reminders_<mrn>`, `invoices_<mrn>`, `checkin_<mrn>`, `travel_<mrn>`,
`alerts_<docId>_<mrn>`, `log_<mrn>_<date>`, `medlog_<mrn>_<date>`, `factbr_<mrn>*`

If a legitimate new key family is being dropped, it must be added to
`patientOwnsKey()` in `src/routes/sync.js` — do not loosen the check to a
substring match, which would let one patient write into another's records.

### Symptom: lab submissions rejected with 400

Lab results are validated against physiological ranges by
`validateLabSubmission()` (`src/validators/labResults.js`). A 400 carries the
specific failures:
```
Lab result validation failed: <reason>; <reason>
```
Warnings (implausible but possible values) do **not** block the write — they are
returned in the `warnings` array and recorded in the audit detail. If a
clinically valid value is being rejected, the range in the validator is wrong
and needs widening; do not disable validation.

### Symptom: `Too many keys in one push` (400)

A single sync exceeded 500 keys (`MAX_KEYS_PER_PUSH`). Usually a client that
accumulated a large offline backlog. The client should chunk its flush; as an
immediate workaround the user can sync, wait, and sync again to drain in batches.

## Email issues

### Symptom: OTP codes never arrive

1. Check configuration:
   ```bash
   curl -s $BASE/api/email/status
   # {"configured":false,...} → SMTP not set up
   ```
2. If `configured` is false, the endpoint returns the code as `devCode` in the
   response instead of emailing it. That is the intended dev fallback — but in
   production it means `GMAIL_USER` / `GMAIL_APP_PASSWORD` are missing.
3. If `configured` is true, verify the transport:
   ```bash
   curl -s "$BASE/api/email/status?verify=1"
   ```
4. Gmail requires an **app-specific password**, not the account password, and
   the sending account must have 2FA enabled to mint one.

### Symptom: `Incorrect code` on a code the user can see

- Codes expire after 10 minutes.
- 5 wrong attempts deletes the pending code entirely — the user must request a
  new one (response is 429).
- Codes are single-use; a code already verified is gone.

## Push notification issues

### Symptom: `/api/push/*` returns 503 `Push not configured`

`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` are unset. Generate a pair and set both:
```bash
node -e "console.log(require('web-push').generateVAPIDKeys())"
```
Changing VAPID keys invalidates all existing subscriptions — every client must
re-subscribe.

### Symptom: subscriptions succeed but notifications never arrive

Push delivery is fire-and-forget (`.catch(() => {})`) by design, so failures do
not surface as request errors. Check for stale subscriptions — browsers expire
endpoints, and the push service returns 410 Gone. These should be pruned from
the subscriptions table.

## Frontend issues

### Symptom: page loads but buttons do nothing

Content Security Policy. The prototype UIs use inline `onclick=` handlers, which
require `scriptSrcAttr: ["'unsafe-inline'"]` in the helmet config
(`src/app.js`). If someone tightened CSP, every button breaks silently — the
browser console shows CSP violation errors. Check the console before assuming a
JavaScript bug.

### Symptom: EmailJS fallback blocked

`connectSrc` must include `https://api.emailjs.com`. Without it the browser
blocks the XHR with no visible error beyond the console.

### Symptom: service worker serving stale assets

```javascript
// In the browser console:
navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
```
Then hard-reload. `sw.js` is served with `Cache-Control: no-cache`, so the
worker script itself updates, but cached assets may persist until the worker
version changes.

## Performance issues

### Symptom: sync is slow for one doctor

`GET /api/sync` returns and decrypts that doctor's **entire** keyspace. A doctor
with many patients and long histories accumulates thousands of keys, and every
value is individually decrypted.

1. Check `flows["sync.doctor_pull"].maxMs` in `/api/metrics`.
2. Count their keys:
   ```bash
   sqlite3 /var/data/chemocure.db \
     "SELECT COUNT(*) FROM kv_store WHERE owner_id = '<doctor-id>';"
   ```
3. Mitigation is architectural — incremental sync by `updated_at` rather than
   full-keyspace pulls. See [Scaling](SCALING.md).

### Symptom: memory grows steadily

Flow metrics are in-memory and unbounded in flow count, but the flow label set
is fixed and small, so metrics are not the leak. Check for a growing number of
open database handles or push subscriptions. A restart is a safe immediate
mitigation; capture a heap snapshot first if you want to diagnose properly.

## Escalation

If none of the above applies, or the fix requires a schema or architectural
change, escalate per [Incident Response](INCIDENT_RESPONSE.md) with:

- The correlation ID(s) of failing requests
- Relevant structured log lines
- `/api/metrics` output
- What you have already ruled out

## Related runbooks

- [Incident Response](INCIDENT_RESPONSE.md)
- [Monitoring](MONITORING.md)
- [Backup & Recovery](BACKUP_RECOVERY.md)
- [Database Management](DATABASE.md)
- [Deployment](DEPLOYMENT.md)
