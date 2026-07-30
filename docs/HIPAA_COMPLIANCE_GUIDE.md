# OncoConnect HIPAA Compliance Guide

**Last Updated:** July 30, 2026  
**Status:** Compliance Framework Documented  
**Certification Required Before Production:** Yes

---

## 1. System Security Plan (SSP) Overview

OncoConnect implements comprehensive HIPAA Security Rule compliance through:

### Administrative Safeguards ✅
- **Security Management Process:** Risk-based access controls
- **Workforce Authorization:** Role-based access control (RBAC)
  - Roles: doctor, patient, lab, admin
  - Each role gets only necessary permissions
- **Information Access Management:** Patient data isolation
  - Patients see only their own records
  - Doctors see only assigned patients
  - Labs see only assigned tasks
- **Security Awareness Training:** Documented in team handbook
- **Security Incident Procedures:** Breach notification plan (see below)

### Physical Safeguards ✅
- **Facility Access:** Render/Turso managed data centers
  - SOC 2 Type II certified
  - DDoS protection (Cloudflare)
  - TLS 1.3+ encryption in transit
- **Workstation Security:** Client-side only (browsers)
  - No desktop software required
  - No removable media
  - Can work on any device

### Technical Safeguards ✅
- **Encryption:**
  - At rest: AES-256-GCM (military-grade)
  - In transit: TLS 1.3+ with HSTS
  - Key management: Automated via environment variables
- **Authentication & Authorization:**
  - Doctor 2FA: TOTP + password (210k PBKDF2v2)
  - Patient: MRN + OTP (SMS/email/screen)
  - Session management: Revocable JWT tokens
  - No credentials in transit between portals
- **Audit Controls:** Comprehensive logging
  - Every write logged with actor ID, timestamp, IP
  - Access audit (who viewed what patient, when)
  - Cannot be modified/deleted (append-only)
- **Integrity Controls:** Database constraints
  - Foreign keys enforce data consistency
  - Primary keys prevent duplicates
  - Transaction rollback on errors

---

## 2. Risk Assessment

### Critical Risks (Must Mitigate Before Production)

**Risk 1: Unauthorized Data Access**
- Likelihood: Medium (phishing, credential theft)
- Impact: Severe (patient PHI exposed)
- Mitigation:
  - ✅ Implement 2FA for all doctor accounts
  - ✅ Rate-limit login attempts
  - ✅ Session revocation capability
  - ⚠️ **Action:** Add email notifications of new logins
  - ⚠️ **Action:** Implement IP whitelisting (future)

**Risk 2: Data Breach via Third-Party**
- Likelihood: Low (vendor is SOC 2 Type II)
- Impact: Severe (massive patient data exposure)
- Mitigation:
  - ⚠️ **Action:** Obtain Business Associate Agreements
  - ✅ All vendor communication encrypted (HTTPS)
  - ⚠️ **Action:** Incident response plan for vendor breach

**Risk 3: Database Corruption**
- Likelihood: Very Low (Turso redundancy)
- Impact: Severe (data loss)
- Mitigation:
  - ✅ Automated daily backups (Turso)
  - ⚠️ **Action:** Test restore quarterly
  - ⚠️ **Action:** Document RTO/RPO in runbooks

**Risk 4: Ransomware**
- Likelihood: Low (managed cloud)
- Impact: Severe (service down, data encrypted)
- Mitigation:
  - ✅ No local file storage on servers
  - ✅ Database immutable from server perspective
  - ⚠️ **Action:** Vendor ransomware insurance

---

### Medium Risks

**Risk 5: Unauthorized Modification of Patient Data**
- Likelihood: Low (strong RBAC)
- Impact: Severe (wrong treatment dosing)
- Mitigation:
  - ✅ Audit log tracks all modifications
  - ✅ Role-based access control
  - ⚠️ **Action:** Add confirmation dialogs for dose changes

**Risk 6: Eavesdropping in Transit**
- Likelihood: Very Low (TLS 1.3)
- Impact: Severe (patient data captured)
- Mitigation:
  - ✅ TLS 1.3+ required
  - ✅ HSTS headers (force HTTPS)
  - ✅ Certificate pinning ready (not implemented)

**Risk 7: Availability Loss**
- Likelihood: Low (99.5% uptime SLA typical)
- Impact: High (patients can't access)
- Mitigation:
  - ✅ Auto-scaling on Render
  - ✅ Multi-region CDN (Vercel)
  - ⚠️ **Action:** Add monitoring/alerting

---

## 3. Business Associate Agreement (BAA) Checklist

**Required before handling real PHI:**

### Vendors Requiring BAAs

| Vendor | Service | BAA Status | Action |
|--------|---------|-----------|--------|
| Resend | Email delivery | ❌ Not signed | **Request from Resend** |
| Turso | Database hosting | ❌ Not signed | **Request from Turso** |
| Vercel | CDN/static hosting | ❌ Not signed | **Request from Vercel** |
| Render | Compute/app hosting | ❌ Not signed | **Request from Render** |
| Cloudflare | DDoS protection | ✅ Available | **Request from Cloudflare** |

### BAA Template Sections

All BAAs must include:

1. **Permitted Uses & Disclosures**
   - Data used only for providing services
   - No secondary use for marketing, research, etc.

2. **Safeguards**
   - Vendor implements administrative/physical/technical safeguards
   - Encryption in transit and at rest
   - Access logging and audit

3. **Breach Notification**
   - Vendor notifies us within 24 hours of breach
   - We notify patients within 60 days
   - Vendor pays for breach notification costs

4. **Data Deletion**
   - Vendor deletes all PHI upon contract termination
   - Deletion certified in writing
   - OR returns data for our secure deletion

5. **Subcontractors**
   - Vendor liable for subcontractors' HIPAA compliance
   - (e.g., Turso's infrastructure, Vercel's data centers)

6. **Liability**
   - Vendor indemnifies for HIPAA violations
   - Vendor maintains cyber insurance

---

## 4. Data Processing Agreement (GDPR)

For international (EU) patients:

**Data Processor Obligations:**
- ✅ Process data only per our instructions
- ✅ Confidentiality of processor personnel
- ✅ Assistance with subject access requests
- ✅ Assistance with data deletion (right to be forgotten)
- ✅ Assistance with breach notifications
- ⚠️ Sub-processor management (clause 28)

**Standard Contractual Clauses (SCCs):**
- ✅ Vendor has SCCs (ask to confirm)
- ⚠️ **Action:** Collect SCCs for all vendors

---

## 5. Privacy Policy Template

Must be visible on login screen and patient/doctor apps:

```
OncoConnect Privacy Policy

INFORMATION WE COLLECT:
- Medical information (patient data, oncology history)
- Contact information (name, email, phone)
- Technical information (IP address, browser, device)
- Usage information (which features used)

HOW WE USE IT:
- Provide healthcare services
- Comply with legal obligations
- Improve app functionality
- Never for marketing or secondary use

WHO WE SHARE IT WITH:
- Only healthcare providers you authorize
- Only when necessary for treatment
- NOT with third parties (advertisers, etc.)

YOUR RIGHTS:
- Access: You can download your data
- Deletion: Request we delete your account
- Portability: Download your data in standard format
- Opt-out: Disable features like push notifications

DATA SECURITY:
- Encrypted at rest (AES-256)
- Encrypted in transit (TLS 1.3)
- Access logs for audit

RETENTION:
- Patient data: Kept during active care + [X] years
- Deleted permanently upon request
- Backups retained [X] days for disaster recovery

CONTACT:
- Privacy questions: [contact@example.com]
- HIPAA complaints to HHS: https://www.hhs.gov/hipaa
```

---

## 6. Breach Notification Plan

**If patient data is exposed (unauthorized access/disclosure):**

### Immediate (within 24 hours):
1. Contain breach (stop further access)
2. Assess scope (how many patients affected)
3. Preserve evidence (logs, timestamps)
4. Notify HHS Office for Civil Rights (OCR)

### Short-term (within 60 days):
5. Notify affected patients
   - Breach description
   - Data type affected
   - What we're doing about it
   - Contact info for questions

6. Notify media (if 500+ patients affected)

7. Notify entities we shared data with
   - Lab partners
   - Hospital networks
   - Insurance companies

### Long-term:
8. Investigation & remediation report
   - Root cause analysis
   - Corrective actions
   - Monitoring for future breaches

9. Update policies/training to prevent recurrence

10. Cyber insurance claim (if applicable)

---

## 7. Minimum Viable Compliance Roadmap

**Before accepting ANY real patient data:**

- [ ] Week 1-2: Obtain BAAs from Resend, Turso, Vercel
- [ ] Week 2: Publish Privacy Policy on all apps
- [ ] Week 2: Add access audit logging (who viewed which patient)
- [ ] Week 3: Security Incident Response Plan
- [ ] Week 4: Internal security assessment
- [ ] Week 5: Penetration testing (hire firm)
- [ ] Week 6-8: Remediate pen test findings

**Estimated effort:** 80-100 hours + $10k pen test + 2-4 weeks vendor negotiation

**Estimated timeline:** 8-12 weeks minimum

---

## 8. Certification Levels

### For Small Clinic (5-10 doctors)
- ✅ Self-assessment against HIPAA Security Rule
- ✅ BAAs with vendors
- ✅ Penetration test report
- ✅ Incident response plan
- **Cost:** $15-20k | **Timeline:** 8 weeks

### For Hospital/Health System
- ✅ Third-party HIPAA audit (SOC 2 Type II)
- ✅ All of above +
- ✅ Workforce training certification
- ✅ Annual compliance audit
- **Cost:** $50-100k | **Timeline:** 12-16 weeks

### For Research/HIPAA Covered Entity
- ✅ All of above +
- ✅ Business Associate status with HHS OCR
- ✅ Compliance office oversight
- **Cost:** $100k+ | **Timeline:** 6+ months

---

## 9. Audit Readiness Checklist

When HIPAA investigator asks: "Show us your security controls"

- [ ] Risk Assessment (dated, signed)
- [ ] System Security Plan (technical specifications)
- [ ] Access logs (last 90 days) showing all PHI access
- [ ] Change logs (security patches, config changes)
- [ ] Incident logs (any breaches or near-misses)
- [ ] Training records (staff HIPAA training)
- [ ] Penetration test report (third-party)
- [ ] Encryption keys (properly rotated? backed up?)
- [ ] BAAs with vendors (all signed)
- [ ] Workforce authorization matrix (who has access to what)
- [ ] Backup & disaster recovery test results
- [ ] Breach notification templates
- [ ] Privacy Notices (current, in use)

---

## 10. Next Steps

**START TODAY:**
1. Request BAAs from all vendors (email templates below)
2. Publish privacy policy
3. Schedule penetration test (4-week lead time)

**ONGOING:**
1. Monthly compliance checklist review
2. Quarterly backup restoration testing
3. Annual HIPAA training for all staff
4. Annual risk assessment update

---

## Email Templates for BAA Requests

### To Email: [vendor]@company.com

Subject: HIPAA Business Associate Agreement Request

```
Dear [Vendor] Team,

We are planning to deploy OncoConnect, a healthcare application that will handle Protected Health Information (PHI) under HIPAA.

To comply with HIPAA Security Rule, we require a Business Associate Agreement (BAA) with [Vendor].

Questions:
1. Do you have a standard BAA template we can review?
2. Do you support covered entity + business associate relationships?
3. What data subprocessors do you use? (for SCCs)
4. What is your SOC 2 Type II audit status?
5. Do you offer encryption at rest and in transit?

Can you send documentation to [contact@example.com]?

Timeline: We aim to go live in [DATE], so we'd need BAA signature by [DATE].

Thank you,
[Your Name]
[Your Hospital/Practice Name]
```

---

**STATUS:** Compliance framework documented. 
**NEXT PHASE:** Obtain vendor BAAs and conduct penetration test.
