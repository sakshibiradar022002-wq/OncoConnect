# Security Operations Runbook

Operational security procedures: key rotation, access control, and hardening.

> This is the **operational** runbook. For security policy, threat model, and
> vulnerability disclosure, see the root [`SECURITY.md`](../../SECURITY.md).
> For scanning and CI security gates, see [`SECURITY_SCANNING.md`](../../SECURITY_SCANNING.md).

## Secrets inventory

| Secret | Purpose | Rotatable | Consequence of loss |
|---|---|---|---|
| `PHI_ENCRYPTION_KEY` | AES-256-GCM master key for PHI at rest | Yes — via `npm run rotate-key` | **Total, permanent loss of all clinical data** |
| `JWT_SECRET` | Signs session JWTs | Yes — just change it | All users logged out; no data loss |
| `TURSO_AUTH_TOKEN` | Database access | Yes — `turso db tokens create` | Service outage until replaced |
| `GMAIL_APP_PASSWORD` | SMTP sender | Yes | OTP email stops; falls back to `devCode` |
| `VAPID_PRIVATE_KEY` | Web push signing | Yes | All push subscriptions invalidated |

Store all of these in a secret manager. `PHI_ENCRYPTION_KEY` must be recorded
**at the moment Render generates it** during first deploy — it is not
recoverable afterwards.

Store the key separately from database backups. A backup and its key in the same
place is a single point of total disclosure; either one alone is useless to an
attacker.

## Rotating the PHI encryption key

`scripts/rotate-phi-key.js` re-encrypts every PHI column under a new key. The
data stays readable throughout — this is a re-encryption, not a key swap.

Rotate when: the key may have been exposed, on a scheduled cadence (annually is
typical), or when someone with key access leaves.

### Procedure

1. **Generate the new key** — must be exactly 64 hex characters:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. **Back up first.** Rotation rewrites every encrypted column; a failure
   part-way leaves a mixed-key database.
   ```bash
   npm run backup -- /data/backups
   ```

3. **Schedule a maintenance window.** On local SQLite the rotation runs in a
   single transaction. On libsql/Turso it applies **row by row**, so a
   concurrent write during rotation can be encrypted under the old key and then
   missed. Stop writes for the duration.

4. **Run the rotation** with both keys present:
   ```bash
   PHI_ENCRYPTION_KEY=<current-64-hex> \
   NEW_PHI_ENCRYPTION_KEY=<new-64-hex> \
     npm run rotate-key
   ```
   The script refuses to run if the new key is malformed or identical to the current one.

5. **Switch the environment** to the new key everywhere it is set (Render
   dashboard, `.env`, secret manager) and restart the service.

6. **Verify reads before retiring the old key** — log into the doctor app and
   confirm patient names render as readable text. That proves the ciphertext
   decrypts under the new key.

7. **Keep the old key** in the secret manager for at least one backup retention
   cycle. Backups taken before rotation are still encrypted under it and are
   unrecoverable without it.

### If rotation fails part-way

Restore the pre-rotation backup and keep using the **old** key. Do not attempt
to re-run rotation against a partially rotated database — some columns are under
each key, and a second pass would double-encrypt the already-rotated ones.

### Adding new encrypted columns

Any new `_enc` column must be added to `TARGETS` in
`scripts/rotate-phi-key.js`, or rotation silently skips it and that column
becomes unreadable once the old key is retired. See
[Database → Changing the schema](DATABASE.md#changing-the-schema).

## Rotating `JWT_SECRET`

Low risk — the only effect is that every active session becomes invalid.

1. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Set it in the environment and restart.
3. Users log in again. No data is affected.

Do this immediately if session tokens may have been captured.

## Access control

### Admin privileges

Admin is held by role `admin`, **or** implicitly by the first registered account
(by `created_at`) — see `requireAdmin` in `src/routes/admin.js` and the
`/api/metrics` guard in `src/app.js`. This bootstrap rule exists so the instance
owner cannot lock themselves out.

Grant or revoke:
```bash
npm run make-admin -- doctor@example.com admin    # promote
npm run make-admin -- doctor@example.com doctor   # demote
```
Note this also sets `active = 1`. Valid roles: `admin`, `doctor`, `lab`.

Keep the admin set small and review it quarterly. Admins can read the full user
list and the entire audit log.

### Doctor approval gate

With `REQUIRE_DOCTOR_APPROVAL=true`, every account after the first starts
`active = 0` and cannot log in until an admin approves it:
```
POST /api/admin/users/<id>/active   { "active": true }
```

**Enable this in any production deployment.** Without it, anyone who can reach
the registration endpoint gets a working clinical account.

### Deactivating an account

```
POST /api/admin/users/<id>/active   { "active": false }
```
Login is blocked (the query filters `active = 1`) while the account and its
audit history are preserved. Prefer this to deletion — removing the user
orphans their audit trail.

Admins cannot deactivate themselves; the endpoint returns 400.

### Session revocation

Sessions are stored server-side in the `sessions` table, so revocation is real
rather than advisory. Logout revokes the current session by `jti`. To force a
global logout, rotate `JWT_SECRET`.

## Two-factor authentication

TOTP (RFC 6238) is available for doctor and admin accounts:
`/api/auth/totp/setup` → `/api/auth/totp/enable` (proves possession with a valid
code) → `/api/auth/totp/disable` (also requires a valid code).

Require 2FA for all admin accounts. The secret is stored encrypted in
`totp_enc`.

If a user is locked out by device loss, an admin can clear the second factor
directly — this is a security-relevant action and must be recorded in the
incident log:
```bash
sqlite3 $DB "UPDATE users SET totp_enc = NULL WHERE email = 'doctor@example.com';"
```

## Audit log review

The audit log is append-only and covers authentication, team access grants,
admin actions, and sync operations. `detail_enc` is encrypted.

```
GET /api/admin/audit?limit=500
```

Review weekly for:
- `admin.user_approve` / `admin.user_deactivate` you cannot account for
- `team.grant_access` to unexpected recipients
- `totp.disable` events
- Logins from unusual IPs, or bursts of failures against one account

Never delete audit rows — see [Database](DATABASE.md#do-not-prune-audit_log).

## Built-in protections

These are active by default. Removing any of them to work around a bug is not
an acceptable mitigation.

| Control | Implementation |
|---|---|
| PHI encryption at rest | AES-256-GCM on all `_enc` columns |
| Password hashing | PBKDF2, 210,000 iterations |
| Password policy | >= 10 chars, letter + digit, enforced server-side |
| Rate limiting | 30 auth attempts/15 min; 300 API req/min; 8 OTP/15 min; 30 emails/hour |
| CSRF | Origin check on all state-changing `/api` requests |
| Security headers | helmet, with CSP |
| Session TTL | 120 min default (`SESSION_TTL_MIN`) |
| Patient data isolation | Exact-pattern key scoping in `patientOwnsKey()` |
| Timing-safe comparison | `timingSafeEqual` for credential checks |
| No PHI in logs | Request bodies are never logged |

### CSP and inline handlers

The UIs use inline `onclick=` handlers, which require
`scriptSrcAttr: ["'unsafe-inline'"]`. Tightening this breaks every button
silently. Migrating to attached event listeners would let this be removed — a
worthwhile hardening task, but it is a code change, not a config change.

## Dependency security

```bash
npm run audit         # production dependencies only
npm run audit:fix     # apply non-breaking fixes
npm run test:security # audit + test suite
```

Run before every production deploy. Treat high and critical advisories in
production dependencies as release blockers.

## Pre-production hardening checklist

- [ ] `NODE_ENV=production` (enables hard-fail on missing secrets)
- [ ] `JWT_SECRET` and `PHI_ENCRYPTION_KEY` set, recorded in a secret manager
- [ ] `PHI_ENCRYPTION_KEY` stored separately from backups
- [ ] `REQUIRE_DOCTOR_APPROVAL=true`
- [ ] HTTPS enforced (Render provisions this automatically)
- [ ] 2FA enabled on all admin accounts
- [ ] Admin set reviewed and minimal
- [ ] `npm run audit` clean for production dependencies
- [ ] Backups running, with a verified test restore ([Backup & Recovery](BACKUP_RECOVERY.md))
- [ ] `DB_EPHEMERAL` **not** set
- [ ] Alerting configured ([Monitoring](MONITORING.md))
- [ ] Audit log review scheduled

## Related documentation

- [Root SECURITY.md](../../SECURITY.md) — policy and disclosure
- [SECURITY_SCANNING.md](../../SECURITY_SCANNING.md) — CI scanning
- [HIPAA_COMPLIANCE_GUIDE.md](../HIPAA_COMPLIANCE_GUIDE.md)
- [DPIA.md](../../DPIA.md) / [GOVERNANCE.md](../../GOVERNANCE.md)
- [Incident Response](INCIDENT_RESPONSE.md)
- [Backup & Recovery](BACKUP_RECOVERY.md)
