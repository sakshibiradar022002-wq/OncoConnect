# Incident Response Runbook

Respond to production incidents affecting OncoConnect.

## Severity levels

OncoConnect carries clinical data. Severity is set by **patient-safety impact**,
not by how technically interesting the failure is.

| Level | Definition | Response | Examples |
|---|---|---|---|
| **P0** | Clinicians cannot access patient data, or data loss is in progress | Immediate, page on-call | Service down, database unreachable, PHI exposure, doctor login broken |
| **P1** | A clinical workflow is broken but data is safe | Within 1 hour | Patient diary sync failing, lab results not ingesting, OTP not sending |
| **P2** | Degraded but usable; workaround exists | Within 4 hours | Slow sync, push notifications down, one UI panel broken |
| **P3** | Cosmetic or documentation | Best effort | Typos, minor layout issues |

**Escalate to P0 without hesitation if you are unsure.** A doctor unable to see
a patient's allergy list during an infusion is a safety event, not an
inconvenience.

## Response phases

### 1. Acknowledge (first 5 minutes)

- Claim the incident so work is not duplicated.
- Post an initial note in the incident channel: what is broken, who is affected,
  that you are investigating.
- **Do not start changing things yet.** The most common way a P1 becomes a P0 is
  an untested fix pushed under pressure.

### 2. Assess (5–15 minutes)

Run the 60-second triage from
[Troubleshooting](TROUBLESHOOTING.md#first-triage-in-60-seconds):

```bash
BASE=https://oncoconnect-server.onrender.com
curl -s $BASE/health
curl -s "$BASE/health?deep=1"
```

Establish:

- **Scope** — one user, one clinic, or everyone? Check `actor` fields in logs.
- **Onset** — when did the first failure appear? Correlate against the deploy
  history in Render → Events.
- **Trajectory** — is `errorRate` in `/api/metrics` rising, flat, or recovering?
- **Data at risk** — is anything being written incorrectly, or only failing to
  be written? Failed writes are recoverable; corrupt writes are much worse.

Write these four answers down before proceeding. They determine everything after.

### 3. Mitigate (restore service first)

**Restoring service takes priority over understanding the cause.** Diagnosis
continues after users are working again.

Mitigation options in order of preference:

1. **Roll back the deploy** — if onset correlates with a release, this is almost
   always right and almost always fastest.
   Render → Events → **Rollback to this deploy**
   ([Deployment → Rollback](DEPLOYMENT.md#rollback))

2. **Fix configuration** — expired Turso token, missing env var, wrong secret.
   Correct it and redeploy.

3. **Restart the service** — clears exhausted connections, stuck locks, or a
   memory-pressured process. Cheap and safe; try it before anything invasive.

4. **Restore from backup** — only when data is corrupt, and only after taking a
   snapshot of the current (bad) state first.
   ([Backup & Recovery](BACKUP_RECOVERY.md#restoring))

Never mitigate by disabling a safety control — CSP, rate limits, lab-value
validation, or the patient key-scoping check. Those failing closed is the system
working as designed.

### 4. Verify

Confirm recovery with evidence, not optimism:

```bash
curl -s "$BASE/health?deep=1"      # → {"ok":true,"db":true}
```

- [ ] Affected flow's `errorRate` in `/api/metrics` back to baseline
- [ ] A real login succeeds for each affected role
- [ ] No new Sentry issues in the last 10 minutes
- [ ] The user who reported it confirms it works

### 5. Communicate

Update the incident channel at each phase change, and at least every 30 minutes
during a P0 even if there is nothing new — silence reads as "nobody is working
on it".

For incidents affecting clinical users, notify them directly:

```
OncoConnect: [resolved/investigating] — [what was affected]
Impact:  [who could not do what, and for how long]
Status:  [current state]
Action:  [what users should do, if anything — e.g. re-enter data from HH:MM–HH:MM]
```

Tell users explicitly if data they entered during the window was lost. They may
have written it on paper and can re-enter it — but only if they know to.

### 6. Post-incident review

Within 48 hours for P0/P1. Blameless: the goal is a system that fails less, not
a person to hold responsible.

Cover:
- **Timeline** — onset, detection, mitigation, resolution (with timestamps)
- **Detection gap** — how long between onset and someone noticing? If a user
  reported it before monitoring did, that is the primary finding
- **Root cause** — the actual mechanism, not "a bug was deployed"
- **Data impact** — what was lost or corrupted, and the recovery window from the
  audit log ([Backup & Recovery](BACKUP_RECOVERY.md#verifying-a-restore))
- **Actions** — each with an owner and a date

## Specific incident types

### Suspected PHI exposure

Treat as **P0** and escalate to the security and compliance owners immediately.

1. **Contain** — revoke affected sessions, rotate credentials if leaked.
2. **Preserve evidence** — snapshot logs and the audit table before anything is
   cleaned up. Do not delete the exposure vector until it has been captured.
3. **Scope** — query the audit log for what was accessed, by whom, and when:
   ```
   GET /api/admin/audit?limit=500
   ```
4. **Do not** publish details in a shared channel. PHI incidents have legal
   notification requirements under DPDP — see `docs/HIPAA_COMPLIANCE_GUIDE.md`
   and `DPIA.md`, and involve the compliance owner before external communication.

### Suspected credential compromise

1. Deactivate the account immediately:
   ```
   POST /api/admin/users/<id>/active   { "active": false }
   ```
   This blocks login (the query filters on `active = 1`) but preserves the
   account and its audit history.
2. Review that actor's audit entries for what was accessed.
3. Rotate `JWT_SECRET` if session tokens may have been stolen — this logs
   everyone out, which is acceptable in this situation.
4. Re-enable only after the credential is changed and 2FA is enrolled.

### Data corruption

1. **Stop writes** if corruption is ongoing — take the service down rather than
   let bad data accumulate. A short outage beats a large corrupt dataset.
2. Snapshot the current state before touching anything:
   ```bash
   cp /var/data/chemocure.db /var/data/chemocure.db.corrupt-$(date +%s)
   ```
3. Assess with `PRAGMA integrity_check`.
4. Restore per [Backup & Recovery](BACKUP_RECOVERY.md#database-corruption).
5. Quantify the loss window from the newest audit entry in the restored database
   and communicate it to clinical users specifically.

### Encryption key incident

If `PHI_ENCRYPTION_KEY` is suspected leaked, rotate it
([Security → Key rotation](SECURITY.md)) — the data stays readable throughout
because rotation re-encrypts rather than replacing the key blind.

If the key is **lost**, PHI is unrecoverable. Escalate to leadership and
compliance immediately; this is a reportable data-loss event, not just an
outage.

## On-call quick reference

```bash
BASE=https://oncoconnect-server.onrender.com

# Health
curl -s $BASE/health
curl -s "$BASE/health?deep=1"

# Recent server errors
docker logs oncoconnect 2>&1 | grep '"status":5' | tail -20

# Trace one request
docker logs oncoconnect 2>&1 | grep '"rid":"<request-id>"'

# Everything one actor did
docker logs oncoconnect 2>&1 | grep '"actor":"<subject-id>"'

# Emergency backup before any risky action
npm run backup -- /data/backups

# Deactivate a compromised account (admin session required)
# POST /api/admin/users/<id>/active  {"active": false}
```

Metrics (`/api/metrics`) require an authenticated admin session — keep a working
admin login available offline, not only in a password manager that depends on
the same infrastructure.

## Related runbooks

- [Troubleshooting](TROUBLESHOOTING.md)
- [Monitoring](MONITORING.md)
- [Backup & Recovery](BACKUP_RECOVERY.md)
- [Security](SECURITY.md)
- [Deployment](DEPLOYMENT.md)
