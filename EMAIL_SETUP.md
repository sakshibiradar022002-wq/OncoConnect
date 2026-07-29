# Making email work — real verification codes

OncoConnect sends real registration codes and appointment reminders **from the
server**. Until you configure a provider, it runs in **dev mode**: the code is
shown on screen instead of emailed (handy for demos, useless for real users).

> Emails can only send from the **deployed server** (Render / Vercel / Fly /
> Emergent). The single-file **demo artifacts have no server**, so they always
> show the code on screen — that is expected, not a bug.

Pick **one** provider below and set its variables in your host's dashboard,
then redeploy/restart.

---

## Option 1 — Resend (recommended: free, easiest, works everywhere)

Resend sends over HTTPS, so it works on **every** host including Vercel and
other serverless platforms that block SMTP. Setup is ~2 minutes.

1. Sign up free at **https://resend.com**.
2. **API Keys → Create API Key** → copy it (starts with `re_`).
3. Set on your server:
   ```
   RESEND_API_KEY=re_your_key_here
   EMAIL_FROM=OncoConnect <onboarding@resend.dev>
   ```
   `onboarding@resend.dev` works immediately with no domain setup. To send from
   your own address later, add and verify your domain in Resend, then change
   `EMAIL_FROM`.
4. Redeploy. In the doctor app → **Data & Backup → Email Setup** you should see
   **"Server email is live (resend)"**.

Free tier: 100 emails/day, 3,000/month — plenty for a pilot.

---

## Option 2 — Gmail App Password

Works well on hosts with a persistent server (Render, Fly). **Avoid on Vercel**
(serverless functions usually can't open SMTP connections).

1. Turn on **2-Step Verification**: Google Account → Security.
2. Security → **App passwords** → create one (name it "OncoConnect") → copy the
   16-character password.
3. Set on your server:
   ```
   GMAIL_USER=you@gmail.com
   GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
   ```
   (Your normal Gmail password will **not** work — it must be an App Password.)
4. Redeploy. Email Setup should show **"Server email is live (smtp)"**.

---

## Option 3 — Any SMTP provider

```
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=OncoConnect <no-reply@yourdomain.com>
```

---

## Verify it works

- **In the app:** Data & Backup → Email Setup shows a live status line
  (it calls `GET /api/email/status?verify=1`, which checks the credentials).
- **Registration:** create a new doctor account — a 6-digit code should arrive
  in the inbox instead of appearing on screen.
- **Reminders / test:** Email Setup → **Send Test Email**.

## How the app chooses

Priority is **Resend → Gmail → SMTP**. The verification code itself is always
generated and checked **on the server** (hashed, single-use, 10-minute expiry,
rate-limited) — the browser only sees the code in dev mode when no provider is
configured.
