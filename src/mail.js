// Server-side email — the primary channel for OTP codes and reminders.
//
// Three ways to configure, in priority order:
//
//  1. Resend (RECOMMENDED — works everywhere, incl. Vercel/serverless and
//     behind proxies, because it sends over HTTPS not SMTP; easiest setup):
//       RESEND_API_KEY=re_xxx           (free at https://resend.com)
//       EMAIL_FROM="OncoConnect <onboarding@resend.dev>"   (or your domain)
//
//  2. Gmail App Password (Google Account → Security → 2-Step Verification →
//     App passwords). Note: many serverless hosts BLOCK outbound SMTP, so
//     prefer Resend on Vercel.
//       GMAIL_USER=you@gmail.com
//       GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx   (spaces are stripped)
//
//  3. Any SMTP provider:
//       SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM
//
// When none is set, mailConfigured() is false and callers fall back to
// dev-mode (the verification code is shown on screen instead of emailed).

import nodemailer from 'nodemailer';

let transport = null;   // nodemailer transport (Gmail/SMTP)
let resend = null;      // { apiKey, from } when Resend is configured
let fromAddr = null;

function build() {
  if (transport || resend) return;

  // 1. Resend over HTTPS — first choice.
  if (process.env.RESEND_API_KEY) {
    resend = {
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.EMAIL_FROM || process.env.SMTP_FROM || 'OncoConnect <onboarding@resend.dev>',
    };
    return;
  }

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  // Fail fast rather than hang: a host that can't reach the SMTP port
  // (firewalled egress, wrong host) should surface an error in seconds.
  const timeouts = { connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 };
  if (gmailUser && gmailPass) {
    transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: gmailUser, pass: gmailPass },
      ...timeouts,
    });
    fromAddr = process.env.SMTP_FROM || `OncoConnect <${gmailUser}>`;
    return;
  }
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    const port = parseInt(SMTP_PORT || '587', 10);
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      ...timeouts,
    });
    fromAddr = process.env.SMTP_FROM || `OncoConnect <${SMTP_USER}>`;
  }
}

export function mailConfigured() {
  build();
  return !!(transport || resend);
}

// Provider label so the UI can show which channel is live.
export function mailProvider() {
  build();
  return resend ? 'resend' : transport ? 'smtp' : null;
}

async function sendViaResend({ to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resend.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: resend.from, to: [to], subject, text, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Resend send failed (${res.status}): ${body.slice(0, 200)}`);
    err.permanent = res.status === 401 || res.status === 403 || res.status === 422;
    throw err;
  }
  return res.json().catch(() => ({}));
}

export async function sendMail({ to, subject, text, html }) {
  build();
  if (!transport && !resend) {
    const e = new Error('Email is not configured on this server');
    e.status = 503;
    throw e;
  }
  // Retry transient failures with exponential backoff (0.5s, 1s, 2s).
  // Auth/validation failures are permanent — fail fast, don't hammer.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (resend) return await sendViaResend({ to, subject, text, html });
      return await transport.sendMail({ from: fromAddr, to, subject, text, html });
    } catch (err) {
      lastErr = err;
      if (err.permanent || err.code === 'EAUTH' || err.responseCode === 535) break;
      if (attempt < 2) await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

// Verifies the configured channel is usable without sending a real message,
// so a wrong key/password surfaces immediately. Used by /api/email/status?verify=1.
export async function verifyMail() {
  build();
  if (resend) {
    // Resend has no cheap verify endpoint; a well-formed API key is 're_...'.
    const looksValid = /^re_[A-Za-z0-9_]+/.test(resend.apiKey);
    return { configured: true, provider: 'resend', ok: looksValid,
      error: looksValid ? undefined : 'RESEND_API_KEY does not look like a valid key (expected re_...)' };
  }
  if (!transport) return { configured: false };
  try {
    await transport.verify();
    return { configured: true, provider: 'smtp', ok: true };
  } catch (e) {
    return { configured: true, provider: 'smtp', ok: false, error: e.message };
  }
}
