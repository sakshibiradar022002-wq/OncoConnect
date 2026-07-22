// Server-side email — the primary channel for OTP codes and reminders.
//
// Configure with a Gmail App Password (Google Account → Security → 2-Step
// Verification → App passwords):
//   GMAIL_USER=you@gmail.com
//   GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx   (spaces are fine, we strip them)
// Or any other SMTP provider via the generic variables:
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM
// GMAIL_* wins when both are set. When neither is set, mailConfigured()
// is false and callers fall back to their dev-mode behaviour.

import nodemailer from 'nodemailer';

let transport = null;
let fromAddr = null;

function build() {
  if (transport) return;
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
  return !!transport;
}

export async function sendMail({ to, subject, text, html }) {
  build();
  if (!transport) {
    const e = new Error('Email is not configured on this server');
    e.status = 503;
    throw e;
  }
  // Retry transient SMTP failures with exponential backoff (0.5s, 1s, 2s).
  // Auth failures (EAUTH) are permanent — fail fast, don't hammer.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await transport.sendMail({ from: fromAddr, to, subject, text, html });
    } catch (err) {
      lastErr = err;
      if (err.code === 'EAUTH' || err.responseCode === 535) break;
      if (attempt < 2) await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

// Verifies SMTP credentials without sending anything. Used by the status
// endpoint's ?verify=1 so a wrong app password surfaces immediately instead
// of on the first real send.
export async function verifyMail() {
  build();
  if (!transport) return { configured: false };
  try {
    await transport.verify();
    return { configured: true, ok: true };
  } catch (e) {
    return { configured: true, ok: false, error: e.message };
  }
}
