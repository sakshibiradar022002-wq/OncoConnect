# OncoConnect Deployment Setup Guide

## Current Status 🔴

The preview deployment at `onco-connect-run.preview.emergentagent.com` is **incomplete**: frontend loads but backend API is unavailable.

**Root Cause:** Missing database configuration (`TURSO_DATABASE_URL` environment variable not set)

---

## Fix: 2 Options

### Option A: Quick Testing (5 minutes, data resets each deploy)

Use ephemeral in-memory database. **Good for:** demos, testing, development.

**Steps:**

1. Go to your Render dashboard
2. Select the `oncoconnect-server` service
3. Go to **Environment** tab
4. Add new environment variable:
   - Key: `DB_EPHEMERAL`
   - Value: `true`
5. Click **Save** → Render auto-redeploys
6. Wait 2-3 minutes for deployment to complete
7. Visit https://onco-connect-run.preview.emergentagent.com

**Test credentials** (auto-created on first startup):
- **Doctor:** email=`test@example.com`, password=`testdoc123`
- **Patient MRN:** `12345`, password=`testpat123`
- **Lab:** username=`testlab`, password=`testlab123`

**Limitations:**
- ❌ All data lost when you redeploy
- ❌ Not suitable for real patient data
- ✅ Perfect for live demos and testing features

---

### Option B: Production Setup (15 minutes, persistent data)

Use Turso cloud database. **Good for:** real patients, production, persistent data.

**Steps:**

1. **Create free Turso database:**
   ```bash
   # Install Turso CLI
   curl -sSfL https://get.tur.so/install.sh | bash

   # Sign up (creates free account)
   turso auth signup

   # Create database
   turso db create oncoconnect

   # Get the connection string
   turso db show oncoconnect --url
   # Output: libsql://onco-xyz-abc.turso.io
   # Copy this value

   # Create auth token
   turso db tokens create oncoconnect
   # Output: eyJ0eXAiOiJKV1QiLCJhbGc...
   # Copy this value
   ```

2. **Update Render environment:**
   - Go to Render dashboard → `oncoconnect-server` service
   - Go to **Environment** tab
   - **Remove** `DB_EPHEMERAL` if you added it (Option A)
   - Add/update these variables:
     - Key: `TURSO_DATABASE_URL`
       Value: `libsql://onco-xyz-abc.turso.io` (from step 1)
     - Key: `TURSO_AUTH_TOKEN`
       Value: `eyJ0eXAiOiJKV1QiLCJhbGc...` (from step 1)

3. **Save and redeploy:**
   - Click **Save**
   - Render auto-redeploys
   - Wait 2-3 minutes

4. **Verify deployment:**
   ```bash
   curl https://onco-connect-run.preview.emergentagent.com/health
   # Should return: {"ok":true,"ts":"2026-07-30T..."}
   ```

5. **Test the app:**
   - Doctor: https://onco-connect-run.preview.emergentagent.com/
   - Patient: https://onco-connect-run.preview.emergentagent.com/patient.html

**First-time setup (create test users):**
- Doctor app will create first user (becomes admin)
- Sign up with: email=`your-email@example.com`, password=`secure-password`
- Then you can invite other doctors

**Costs:**
- Turso: FREE (100GB/month included)
- Render: FREE (if using free tier; limited to 0.5 CPU)

---

## Verify Backend is Working

After deployment, test the API endpoints:

```bash
# Health check (shallow)
curl https://onco-connect-run.preview.emergentagent.com/health
# Expected: {"ok":true,"ts":"..."}

# Health check (deep, with database)
curl https://onco-connect-run.preview.emergentagent.com/health?deep=1
# Expected: {"ok":true,"db":true,"ts":"..."}

# Admin endpoint (requires login)
curl https://onco-connect-run.preview.emergentagent.com/api/admin/users
# Expected: 401 Unauthorized (you need to login first)
```

---

## Common Issues

### ❌ `curl` returns HTML instead of JSON

**Problem:** Backend isn't running, only static files served.  
**Solution:** Check environment variables are set. Redeploy.

### ❌ "Database unreachable" error

**Problem:** Database connection failed.  
**Solution:**
- Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are correct
- Make sure Turso database hasn't been deleted
- Try Option A (ephemeral) to isolate the issue

### ❌ "Missing required environment variable: NODE_ENV"

**Problem:** Render didn't auto-generate secrets.  
**Solution:** Manually add `NODE_ENV=production` in Environment tab.

### ❌ App starts but login doesn't work

**Problem:** Database connected but no users exist.  
**Solution:**
- Option A: Using ephemeral DB? Data resets on deploy.
- Option B: If using Turso, sign up as new doctor (first user becomes admin)

---

## What Each Component Does

| Component | Status | Details |
|-----------|--------|---------|
| Frontend (HTML/CSS/JS) | ✅ | Served from `/public` |
| Backend API (Node.js) | ⚠️ | Needs DB configured to start |
| Database | ⚠️ | Ephemeral (option A) or Turso (option B) |
| Authentication | ✅ | Works after DB is configured |
| Sync (offline-first) | ✅ | Works after DB is configured |
| Push notifications | ✅ | Works (optional setup) |
| Email (OTP, reminders) | ⚠️ | Needs Resend/Gmail config |

---

## Next Steps

1. **Test the backend** (choose Option A or B above)
2. **Create test patient records** in the doctor app
3. **Test patient login** via patient portal
4. **Run comprehensive tests** using the assessment docs

---

## For Teachers/Academic Use

If deploying for a class project or academic work:

**Option A (Ephemeral)** is recommended because:
- ✅ No external setup (no Turso account needed)
- ✅ Fresh data for each demo
- ✅ Can't accidentally leak real data
- ✅ Free and instant

**Just show the `/health` endpoint returning JSON** to prove the backend is working! 

```bash
curl -s https://onco-connect-run.preview.emergentagent.com/health | jq .
```

---

## Architecture Overview

```
Browser (Patient/Doctor)
    ↓
Frontend (HTML + CCSync client)
    ↓
Render Node.js (Express backend)
    ↓
Database (Turso OR ephemeral SQLite)
```

The **Frontend** works offline (localStorage sync).  
The **Backend** persists data to the database.  
The **Database** stores encrypted patient data.

---

**Last Updated:** July 30, 2026  
**Status:** Ready to deploy
