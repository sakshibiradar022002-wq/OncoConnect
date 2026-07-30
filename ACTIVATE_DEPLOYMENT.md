# 🚀 Activate Your OncoConnect Deployment

Your backend code is deployed, but needs **one quick configuration** to start working.

**Current Status:** Backend waiting for database setup  
**Fix Time:** 3-5 minutes  
**Data Loss Risk:** None (we're adding a new variable, not changing existing data)

---

## Choose Your Path

### 🟢 Path A: Test Mode (Quickest - 3 minutes)

**Best for:** Live demos, testing features, academic use

**What it does:** Uses in-memory database (fast, no external setup, data resets on redeploy)

**Steps:**

1. Go to: https://dashboard.render.com/
2. Select **oncoconnect-server** service
3. Click **Environment** tab
4. Click **Add Environment Variable**
5. Enter:
   - **Key:** `DB_EPHEMERAL`
   - **Value:** `true`
6. Click **Save**
7. Wait 2-3 minutes for redeploy
8. Visit: https://onco-connect-run.preview.emergentagent.com/

**Test login immediately:**
- Doctor: `test@example.com` / `testdoc123`
- Patient MRN: `12345` / `testpat123`
- Lab: `testlab` / `testlab123`

✅ Database auto-created with test users  
✅ No external setup needed  
✅ All features working

---

### 🔵 Path B: Production Mode (Persistent data - 15 minutes)

**Best for:** Real patient data, keeping records long-term

**What it does:** Uses Turso cloud database (free tier, persistent)

**Steps:**

1. **Create Turso database** (2 min):
   ```bash
   # Install Turso
   curl -sSfL https://get.tur.so/install.sh | bash
   
   # Sign up
   turso auth signup
   
   # Create database
   turso db create oncoconnect
   
   # Get URL (copy this)
   turso db show oncoconnect --url
   
   # Get token (copy this)
   turso db tokens create oncoconnect
   ```

2. **Update Render** (3 min):
   - Go to: https://dashboard.render.com/
   - Select **oncoconnect-server**
   - Click **Environment** tab
   - **Remove** `DB_EPHEMERAL` if you added it (Path A)
   - Add these variables:
     - `TURSO_DATABASE_URL` = `libsql://your-db-xyz.turso.io`
     - `TURSO_AUTH_TOKEN` = `eyJ0eXAi...` (the token)
   - Click **Save**
   - Wait 2-3 minutes for redeploy

3. **Verify:**
   ```bash
   curl https://onco-connect-run.preview.emergentagent.com/health
   # Should return JSON
   ```

✅ Data persists across redeploys  
✅ Suitable for real use  
✅ Free Turso tier is generous (100GB/month)

---

### 🟡 Path C: Advanced (Custom database)

See `DEPLOYMENT_SETUP.md` for Railway, Fly.io, or self-hosted options.

---

## Verify It's Working

After you choose Path A or B, test these URLs:

```bash
# Health check (should return JSON)
curl https://onco-connect-run.preview.emergentagent.com/health
# {"ok":true,"ts":"2026-07-30T..."}

# Test doctor login
curl -X POST https://onco-connect-run.preview.emergentagent.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"testdoc123"}'
# Should return: {"ok":true,"user":{"id":"...","email":"..."},...}
```

If you get **HTML instead of JSON** → backend not started yet. Wait a bit longer or check Environment variables.

---

## App URLs

After deployment works:

| Role | URL |
|------|-----|
| 👨‍⚕️ **Doctor** | https://onco-connect-run.preview.emergentagent.com/ |
| 🤒 **Patient** | https://onco-connect-run.preview.emergentagent.com/patient.html |
| 🧪 **Lab** | https://onco-connect-run.preview.emergentagent.com/lab.html |
| 🛡️ **Admin** | https://onco-connect-run.preview.emergentagent.com/admin.html |

---

## What Changes Did We Make?

To fix the deployment, we:

1. ✅ Added `DB_EPHEMERAL` mode (in-memory DB for testing)
2. ✅ Auto-populate test users on ephemeral startup
3. ✅ Updated render.yaml with better docs
4. ✅ Created DEPLOYMENT_SETUP.md with detailed steps

**No breaking changes.** Production (Turso) mode still works exactly the same.

---

## Need Help?

**Backend not starting?**
→ Check that `NODE_ENV=production` is set in Environment

**Database connection failed?**
→ Verify TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are exact copies (no spaces)

**Test data not showing?**
→ You're using Path B (Turso). Create your first user by signing up in the doctor app.

**Data keeps resetting?**
→ You're using Path A (ephemeral). It's designed to reset on redeploy for testing.

---

## Next: Comprehensive Assessment

Once deployed and verified working, see `COMPREHENSIVE_ASSESSMENT.md` for detailed ratings across:
- ✅ Security & Privacy (7/10)
- ✅ Functionality (6/10)
- ✅ Performance (4/10)
- ✅ Compliance (2/10)
- ✅ And 6 more dimensions...

---

**Your deployment is ready to activate. Pick Path A or B above and get started!** 🚀

Last updated: July 30, 2026
