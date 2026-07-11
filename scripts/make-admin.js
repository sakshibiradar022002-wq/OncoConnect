// Promote (or demote) an account's role.
// Usage: node scripts/make-admin.js doctor@example.com [role=admin]

import { db } from '../src/db/index.js';

const email = (process.argv[2] || '').toLowerCase().trim();
const role = process.argv[3] || 'admin';
if (!email) { console.error('Usage: node scripts/make-admin.js <email> [role]'); process.exit(1); }
if (!['admin', 'doctor', 'lab'].includes(role)) { console.error('Role must be admin, doctor, or lab.'); process.exit(1); }

const user = await db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
if (!user) { console.error(`No account found for ${email}`); process.exit(1); }

await db.prepare('UPDATE users SET role = ?, active = 1 WHERE id = ?').run(role, user.id);
console.log(`${email}: ${user.role} → ${role} (active)`);
process.exit(0);
