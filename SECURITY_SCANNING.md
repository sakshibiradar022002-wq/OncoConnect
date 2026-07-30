# OncoConnect Security Scanning Guide

**Last Updated:** July 30, 2026  
**Purpose:** Automated security scanning to detect vulnerabilities in dependencies  
**SLA:** Zero high-severity vulnerabilities in production

---

## Quick Start

### Local Security Checks
```bash
# Run all security checks (npm audit + unit tests)
npm run test:security

# Check production dependencies only (ignore dev)
npm audit --production

# Auto-fix vulnerabilities where possible
npm audit fix --production

# See full vulnerability details
npm audit --production --detailed
```

### Automated CI/CD
GitHub Actions runs security scanning automatically on:
- Every push to `main` or feature branches
- Every pull request
- Weekly schedule (Sundays at 2 AM UTC)

Results appear in GitHub Security tab → Code scanning alerts

---

## Security Scanning Components

### 1. NPM Audit (Dependency Vulnerabilities)

**What it does:**  
Checks all npm packages against known security vulnerabilities database

**Configuration:**
```bash
# Check production dependencies only (ignore dev dependencies)
npm audit --production --audit-level=moderate

# Levels: low, moderate, high, critical
# We enforce: audit-level=moderate (block on moderate+)
```

**Common Vulnerabilities:**
- Outdated cryptographic libraries
- Authentication bypass
- Data exposure
- Denial of Service (DoS)
- Code injection

**Fix:**
```bash
npm audit fix --production
git add package-lock.json
git commit -m "Security: update vulnerable dependencies"
```

### 2. Secrets Detection (TruffleHog)

**What it does:**  
Scans code for accidentally committed credentials:
- API keys, JWT tokens
- Database passwords
- AWS keys, SSH keys
- Private certificates

**Configuration:**  
Runs automatically on all code changes. Only verified secrets trigger alerts.

**Common False Positives:**
- Placeholder strings like `password: "..."`
- Example credentials in comments
- Symmetric encryption keys in tests

**Fix:**
```bash
# Remove credential from code
git rm --cached file_with_secret.txt
echo "file_with_secret.txt" >> .gitignore

# Re-write git history (DANGEROUS — use carefully)
git filter-branch --tree-filter 'rm -f path/to/secret' HEAD

# Rotate credential in production immediately
# Update .env with new credential
```

### 3. Code Quality Checks

**What it does:**
- Runs full test suite (regression check)
- Detects `console.log()` (potential info leaks)
- Finds hardcoded passwords

**Why:**
- Tests verify security features (encryption, auth) still work
- `console.log()` can expose PHI in logs
- Hardcoded credentials bypass environment variable protection

**Fix:**
```bash
# Replace console.log with console.error
console.log('debug') → console.error('error')

# Use environment variables
const secret = process.env.SECRET_KEY;
```

### 4. OWASP Dependency Check

**What it does:**  
Scans dependencies against OWASP vulnerability database. More comprehensive than npm audit, includes:
- Transitive dependency vulnerabilities
- License compliance issues
- End-of-life library detection

**Results:**  
Uploaded as SARIF report to GitHub Security → Code scanning

**Fix:**
Same as npm audit — update vulnerable packages

---

## GitHub Actions Workflow

**File:** `.github/workflows/security.yml`

**Triggers:**
- Push to main or feature branches
- Pull requests
- Weekly scheduled scan (Sunday 2 AM UTC)

**Jobs:**
1. **NPM Audit** — Check production dependencies
2. **Secrets Check** — Detect hardcoded credentials
3. **Code Quality** — Run tests + lint checks
4. **Dependency Check** — OWASP vulnerability scan
5. **Security Summary** — Report overall status

**Access Results:**
- GitHub repo → Security tab → Code scanning alerts
- View vulnerability details, severity, remediation advice

---

## What Gets Scanned

### ✅ Included

- All npm packages (dependencies)
- Production code (src/)
- Configuration files
- Environment setup

### ❌ Excluded

- Dev dependencies (test libraries, build tools)
- Node modules/.git (too large)
- Binary files

---

## Vulnerability Severity Levels

### 🔴 CRITICAL
**Action:** Fix immediately, don't deploy  
**Example:** Remote code execution, authentication bypass  
**Timeline:** <24 hours

### 🔴 HIGH
**Action:** Fix before next release  
**Example:** Privilege escalation, data exposure  
**Timeline:** <1 week

### 🟡 MODERATE
**Action:** Plan fix in next cycle  
**Example:** Denial of service, weak encryption  
**Timeline:** <2 weeks

### 🟢 LOW
**Action:** Update when convenient  
**Example:** Minor information disclosure  
**Timeline:** <1 month

---

## Common Vulnerabilities in OncoConnect

### Dependency-Related
- **better-sqlite3:** Native module security updates
- **express:** DoS mitigation in latest versions
- **crypto:** Node.js built-in, kept current with Node version
- **jsonwebtoken:** JWT algorithm validation

### Code-Related
- ✅ **PHI encryption:** AES-256-GCM (cryptographically secure)
- ✅ **Password hashing:** PBKDF2-SHA512, 210k iterations
- ✅ **Authentication:** Session-based with revocation
- ✅ **Rate limiting:** Enabled on auth and API endpoints
- ✅ **SQL injection:** Prepared statements (zero risk)
- ✅ **XSS:** Helmet CSP headers, no inline scripts
- ⚠️ **Secrets:** Environment variables (good), but document clearly

---

## Remediation Workflow

### 1. Identify Vulnerability
GitHub Actions finds a moderate+ vulnerability in npm audit

### 2. Understand Impact
```bash
npm audit --detailed
# Shows: package name, severity, affected versions, fix available
```

### 3. Plan Fix
- If npm audit suggests fix: `npm audit fix --production`
- If manual required: update package.json to minimum safe version
- If no fix available: evaluate risk vs. benefit of keeping

### 4. Test Locally
```bash
npm install
npm test  # Verify app still works
npm audit --production  # Confirm fix applied
```

### 5. Commit & Push
```bash
git add package-lock.json package.json
git commit -m "Security: update [package] to [version]

Fixes [vulnerability]: [description]
https://github.com/advisories/GHSA-xxxx-xxxx-xxxx"

git push
```

### 6. CI/CD Validation
GitHub Actions re-runs security scanning. PR shows green ✅ when fixed.

### 7. Merge & Deploy
After human review and CI passing, merge to main and deploy.

---

## Best Practices

### Dependencies
- ✅ Keep Node.js updated (LTS versions)
- ✅ Update dependencies monthly (security patches)
- ✅ Use `npm audit` before every deployment
- ✅ Minimize dependencies (every package = attack surface)
- ❌ Don't ignore vulnerabilities
- ❌ Don't use `npm audit --force` (hides problems)

### Secrets Management
- ✅ Use .env for all credentials
- ✅ Add .env to .gitignore
- ✅ Document required env vars in .env.example
- ✅ Rotate secrets if accidentally committed
- ❌ Never commit .env files
- ❌ Never paste credentials in code comments

### Code
- ✅ Use parameterized queries (already done)
- ✅ Validate all input (zod schema validation)
- ✅ Use HTTPS only (enforced in production)
- ✅ Set secure headers (Helmet)
- ❌ Don't log sensitive data
- ❌ Don't disable security features

### Deployment
- ✅ Run `npm audit` before deploying
- ✅ Keep CI/CD configuration in repo (reviewable)
- ✅ Require security checks to pass before merge
- ✅ Document any accepted vulnerabilities (with rationale)
- ❌ Don't skip security checks for speed

---

## Accepting Known Risks

Occasionally, a vulnerability has no fix and removing the package isn't feasible.

### Document Decision
```bash
# In package.json or SECURITY.md
{
  "acceptedVulnerabilities": [
    {
      "package": "some-old-library",
      "vulnerability": "GHSA-xxxx-xxxx-xxxx",
      "reason": "No security impact in our usage (X feature not used)",
      "mitigations": "Updated to latest patch version",
      "acceptedAt": "2026-07-30",
      "review": "2026-08-30"
    }
  ]
}
```

### Annual Review
Set reminder to re-evaluate accepted vulnerabilities (may be patched, may need removal)

---

## Performance

### Local Scan Time
- `npm audit`: <5 seconds
- Full security suite: ~30-60 seconds (includes tests)

### CI/CD Time
- GitHub Actions: ~3-5 minutes (all jobs parallel)
- Blocks merge if vulnerabilities found (configurable)

---

## Monitoring & Alerts

### GitHub Alerts
- Automatic notifications for new vulnerabilities in repo
- Weekly/daily summaries (configurable)
- Access: Repo → Security → Settings → Alerts

### Sentry Monitoring
- Runtime errors from dependencies logged
- Critical errors trigger PagerDuty (if configured)

### Manual Checks
```bash
# Monthly (add to calendar reminder)
npm audit --production

# Before every deployment
npm run test:security
```

---

## Related Documentation

- [HIPAA Compliance Guide](./docs/HIPAA_COMPLIANCE_GUIDE.md) — Risk assessment, breach procedures
- [Deploy Guide](./DEPLOYMENT_SETUP.md) — Secure deployment practices
- [README](./README.md) — Architecture, encryption details

---

**Status:** Automated security scanning deployed  
**Owner:** DevOps / Security team  
**Review Frequency:** Weekly (automated) + Monthly (manual)  
**Escalation:** Critical vulnerabilities → Immediate attention
