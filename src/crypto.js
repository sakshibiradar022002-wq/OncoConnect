// All cryptographic primitives in one place.
// - Passwords: PBKDF2-SHA512 with per-user salt (never reversible).
// - PHI at rest: AES-256-GCM authenticated encryption with per-record IV.

import crypto from 'node:crypto';
import { config } from './config.js';

const PHI_KEY = Buffer.from(config.phiKeyHex, 'hex'); // 32 bytes

// ── Password hashing ──────────────────────────────────────────────

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(plain, salt, config.pbkdf2Iterations, 64, 'sha512');
  // Stored format: pbkdf2$iterations$salt_hex$hash_hex
  return `pbkdf2$${config.pbkdf2Iterations}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(plain, stored) {
  if (!stored || !stored.startsWith('pbkdf2$')) return false;
  const [, iterStr, saltHex, hashHex] = stored.split('$');
  const iterations = parseInt(iterStr, 10);
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.pbkdf2Sync(plain, salt, iterations, expected.length, 'sha512');
  // Constant-time comparison to prevent timing attacks.
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ── PHI encryption at rest (AES-256-GCM) ──────────────────────────

// Encrypts any JS value (object/string/number) → compact string blob.
// Format: v1.<iv_b64>.<tag_b64>.<ciphertext_b64>
export function encryptPHI(value) {
  if (value === null || value === undefined) return null;
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const iv = crypto.randomBytes(12); // GCM standard IV size
  const cipher = crypto.createCipheriv('aes-256-gcm', PHI_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

export function decryptPHI(blob) {
  if (!blob) return null;
  try {
    const [version, ivB64, tagB64, ctB64] = blob.split('.');
    if (version !== 'v1') throw new Error('Unknown PHI blob version');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', PHI_KEY, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch (err) {
    // Authentication failure = tampered or wrong key. Never leak details.
    console.error('[crypto] PHI decryption failed:', err.message);
    return null;
  }
}

// ── Random identifiers ────────────────────────────────────────────

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function generateMRN() {
  // Human-readable, collision-resistant. e.g. MRN-7F3K9Q2M
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = crypto.randomBytes(8);
  let out = '';
  for (const b of buf) out += chars[b % chars.length];
  return `MRN-${out}`;
}

export function generatePassword(len = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  const buf = crypto.randomBytes(len);
  let out = '';
  for (const b of buf) out += chars[b % chars.length];
  return out;
}
