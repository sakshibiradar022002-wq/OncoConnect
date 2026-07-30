// Accessibility audit across every app surface, using axe-core.
//
// Clinicians work these screens under time pressure and patients use them while
// unwell, so keyboard reachability and screen-reader semantics are not a
// nice-to-have. This runs the WCAG 2.1 A/AA rule set and fails on violations at
// or above the configured severity.
//
//   node scripts/check-a11y.mjs                 (fails on serious + critical)
//   A11Y_LEVEL=moderate node scripts/check-a11y.mjs
//   A11Y_REPORT=1 node scripts/check-a11y.mjs   (list every violation, incl. minor)

import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OWN_SERVER = !process.env.BASE_URL;
const REPORT_ALL = process.env.A11Y_REPORT === '1';

// Severity that fails the build. axe orders: minor < moderate < serious < critical.
const ORDER = ['minor', 'moderate', 'serious', 'critical'];
const LEVEL = process.env.A11Y_LEVEL || 'serious';
const THRESHOLD = ORDER.indexOf(LEVEL);

const PAGES = [
  { url: '/', name: 'doctor' },
  { url: '/patient.html', name: 'patient' },
  { url: '/admin.html', name: 'admin' },
];

async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url + '/health')).ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

let server = null;
if (OWN_SERVER) {
  server = spawn('node', ['src/server.js'], {
    env: { ...process.env, DB_EPHEMERAL: 'true', NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  if (!await waitForServer(BASE)) {
    console.error('Could not start a server on ' + BASE);
    server.kill();
    process.exit(1);
  }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
});

let blocking = 0;
const summary = [];

for (const page of PAGES) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(BASE + page.url, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(700);

  const results = await new AxeBuilder({ page: p })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of results.violations) counts[v.impact || 'minor'] += v.nodes.length;

  const bad = results.violations.filter(v => ORDER.indexOf(v.impact || 'minor') >= THRESHOLD);
  blocking += bad.reduce((n, v) => n + v.nodes.length, 0);
  summary.push({ name: page.name, counts, total: results.violations.length });

  const label = `${page.name.padEnd(8)} critical:${counts.critical} serious:${counts.serious} moderate:${counts.moderate} minor:${counts.minor}`;
  console.log(bad.length ? `✗ ${label}` : `✓ ${label}`);

  const show = REPORT_ALL ? results.violations : bad;
  for (const v of show) {
    console.log(`   [${v.impact}] ${v.id} — ${v.help}  (${v.nodes.length}×)`);
    for (const n of v.nodes.slice(0, 3)) {
      console.log(`        ${n.target.join(' ')}`.slice(0, 150));
    }
    if (v.nodes.length > 3) console.log(`        … +${v.nodes.length - 3} more`);
  }

  await ctx.close();
}

await browser.close();
if (server) server.kill();

console.log('');
if (blocking) {
  console.error(`${blocking} accessibility violation(s) at or above "${LEVEL}".`);
  console.error('Run with A11Y_REPORT=1 to see everything including minor issues.');
  process.exit(1);
}
console.log(`No accessibility violations at or above "${LEVEL}".`);
process.exit(0);
