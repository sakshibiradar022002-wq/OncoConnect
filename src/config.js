// Central configuration. All secrets come from environment variables.
// Never hard-code secrets. On a cloud host, set these in the dashboard.

import crypto from 'node:crypto';

function required(name) {
  const val = process.env[name];
  if (val === undefined) {
    console.error(`\n[FATAL] Missing required environment variable: ${name}`);
    console.error(`Set it in your host's environment settings and restart.\n`);
    process.exit(1);
  }
  return val;
}

// In development we auto-generate ephemeral secrets so the app boots.
// In production (NODE_ENV=production) they MUST be provided, or we refuse to start.
const isProd = process.env.NODE_ENV === 'production';

function secret(name, bytes = 32) {
  if (process.env[name]) return process.env[name];
  if (isProd) return required(name); // hard-fail in prod
  const generated = crypto.randomBytes(bytes).toString('hex');
  console.warn(`[dev] ${name} not set — generated an ephemeral one. Sessions reset on restart.`);
  return generated;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  isProd,

  // Secret used to sign session JWTs.
  jwtSecret: secret('JWT_SECRET'),

  // Master key used to encrypt PHI columns at rest (AES-256-GCM).
  // MUST be a 64-char hex string (32 bytes). Generate with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  phiKeyHex: (() => {
    const k = process.env.PHI_ENCRYPTION_KEY;
    if (k) {
      if (!/^[0-9a-fA-F]{64}$/.test(k)) {
        console.error('[FATAL] PHI_ENCRYPTION_KEY must be 64 hex chars (32 bytes).');
        process.exit(1);
      }
      return k;
    }
    if (isProd) return required('PHI_ENCRYPTION_KEY');
    const gen = crypto.randomBytes(32).toString('hex');
    console.warn('[dev] PHI_ENCRYPTION_KEY not set — generated ephemeral. Encrypted data will be unreadable after restart.');
    return gen;
  })(),

  // Session lifetime.
  sessionTtlMinutes: parseInt(process.env.SESSION_TTL_MIN || '120', 10),

  // Path to the SQLite database file.
  dbPath: process.env.DB_PATH || './chemocure.db',

  // Password hashing cost (PBKDF2 iterations).
  pbkdf2Iterations: 210000,

  // When true, doctor accounts after the first one start deactivated and an
  // admin must set users.active = 1 before they can sign in.
  requireDoctorApproval: process.env.REQUIRE_DOCTOR_APPROVAL === 'true',
};
