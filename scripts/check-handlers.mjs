// Guards the bug class that shipped seven dead controls to production.
//
// Actions are declared as `data-click="fn(args)"` and resolved by the delegated
// dispatcher against window. A function that is missing, or defined inside an
// IIFE/closure, does nothing at all — invisible to `node --check`, to the API
// tests, and to anyone not clicking that exact control. This makes it loud.
//
// Also fails on any leftover inline `onclick=` in the app documents: those
// bypass the dispatcher and would need the CSP to keep allowing inline event
// attributes. Handlers inside generated popup documents are exempt — that
// window has its own scope and no dispatcher.
//
// Two sources of handlers are checked:
//   1. the live DOM after the app boots  (static markup)
//   2. onclick="..." occurrences in the raw source, which also catches handlers
//      that only ever appear inside JS template literals and are therefore
//      absent from the initial DOM
//
//   node scripts/check-handlers.mjs            (starts its own server)
//   BASE_URL=http://localhost:3000 node scripts/check-handlers.mjs
//
// Exits non-zero listing every handler that cannot resolve.

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OWN_SERVER = !process.env.BASE_URL;

const PAGES = [
  { url: '/', file: 'public/index.html', name: 'doctor' },
  { url: '/patient.html', file: 'public/patient.html', name: 'patient' },
  { url: '/admin.html', file: 'public/admin.html', name: 'admin' },
];

// Identifiers that inline handlers may legitimately reference without being
// app globals — browser built-ins reachable from an inline handler's scope.
const BUILTINS = new Set([
  'alert', 'confirm', 'prompt', 'print', 'open', 'close', 'focus', 'blur',
  'event', 'window', 'document', 'this', 'location', 'history', 'navigator',
  'setTimeout', 'setInterval', 'fetch', 'console', 'return', 'if', 'for',
  'while', 'switch', 'typeof', 'new', 'delete', 'void', 'function', 'let',
  'const', 'var', 'try', 'catch', 'throw',
]);

// Pull the leading callee out of each statement in a handler body.
// "a(); b(this)" -> ['a','b'];  "x.y()" is skipped (member call, not a global).
function calleesIn(code) {
  const names = [];
  for (const stmt of String(code).split(';')) {
    const m = stmt.match(/(?:^|[\s{(!])([A-Za-z_$][\w$]*)\s*\(/);
    if (m && !BUILTINS.has(m[1])) names.push(m[1]);
  }
  return names;
}

// Functions the app writes as source text into ANOTHER document — the lab
// portal is built by pushing `'function switchTab(tab){'` strings into a
// window.open() document. Those live in that window's scope, so checking them
// against the parent's window would be a false positive.
function popupDefinedNames(src) {
  const names = new Set();
  const re = /['"`]\s*function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return names;
}

function handlersInSource(file) {
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { return []; }
  const inPopup = popupDefinedNames(src);
  const found = [];
  // onclick="..."  onclick='...'  onclick=\"...\" (escaped inside JS strings)
  const re = /data-click=(?:\\?["'])((?:[^"'\\]|\\.)*?)(?:\\?["'])/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const body = m[1].replace(/\\(['"])/g, '$1');
    for (const n of calleesIn(body)) {
      if (inPopup.has(n)) continue; // defined in the generated document, not here
      found.push({ name: n, snippet: body.slice(0, 60) });
    }
  }
  return found;
}

async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url + '/health');
      if (r.ok) return true;
    } catch {}
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

let failures = 0;
let checked = 0;

for (const page of PAGES) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  try {
    await p.goto(BASE + page.url, { waitUntil: 'networkidle', timeout: 30000 });
    await p.waitForTimeout(800);
  } catch (e) {
    console.error(`✗ ${page.name}: could not load ${page.url} — ${e.message}`);
    failures++;
    await ctx.close();
    continue;
  }

  // 1. live DOM
  const domBad = await p.evaluate((builtins) => {
    const bad = [];
    for (const el of document.querySelectorAll('[data-click]')) {
      const code = el.getAttribute('data-click') || '';
      for (const stmt of code.split(';')) {
        const m = stmt.match(/(?:^|[\s{(!])([A-Za-z_$][\w$]*)\s*\(/);
        if (!m || builtins.includes(m[1])) continue;
        if (typeof window[m[1]] !== 'function') {
          bad.push({
            name: m[1],
            where: `<${el.tagName.toLowerCase()}> "${(el.textContent || '').trim().slice(0, 34)}"`,
          });
        }
      }
    }
    return bad;
  }, [...BUILTINS]);

  // 2. handlers that only exist inside template literals
  const srcHandlers = handlersInSource(page.file);
  const uniq = [...new Map(srcHandlers.map(h => [h.name, h])).values()];
  const srcBad = [];
  for (const h of uniq) {
    const ok = await p.evaluate(n => typeof window[n] === 'function', h.name);
    if (!ok) srcBad.push(h);
  }

  // 3. No inline event attributes may survive in the live document. Any that
  //    do would bypass the dispatcher and force the CSP to keep allowing
  //    inline script attributes. Handlers inside popup documents built with
  //    document.write are a separate document and are not reachable here.
  const inlineLeft = await p.evaluate(() =>
    [...document.querySelectorAll('*')]
      .filter(el => [...el.attributes].some(a => /^on[a-z]+$/.test(a.name)))
      .map(el => `<${el.tagName.toLowerCase()}> ${[...el.attributes].filter(a => /^on[a-z]+$/.test(a.name)).map(a => a.name).join(',')}`)
      .slice(0, 10)
  );
  if (inlineLeft.length) {
    failures += inlineLeft.length;
    console.error(`\n✗ ${page.name}: inline event attributes still present`);
    for (const t of inlineLeft) console.error(`    ${t}`);
  }

  checked += (await p.evaluate(() => document.querySelectorAll('[data-click]').length)) + uniq.length;

  const domNames = new Set(domBad.map(b => b.name));
  const extra = srcBad.filter(b => !domNames.has(b.name));

  if (domBad.length || extra.length) {
    failures += domBad.length + extra.length;
    console.error(`\n✗ ${page.name} (${page.url})`);
    for (const b of domBad) console.error(`    ${b.name}()  —  ${b.where}   [in DOM]`);
    for (const b of extra) console.error(`    ${b.name}()  —  ${b.snippet}   [in generated markup]`);
  } else {
    console.log(`✓ ${page.name}: every inline handler resolves`);
  }

  await ctx.close();
}

await browser.close();
if (server) server.kill();

console.log(`\n${checked} handler reference(s) checked across ${PAGES.length} pages.`);
if (failures) {
  console.error(`\n${failures} inline handler(s) reference something that is not a function on window.`);
  console.error('A control wired to one of these does nothing when clicked, silently.');
  console.error('Fix: define the function, or assign it to window if it lives inside an IIFE.');
  process.exit(1);
}
console.log('All inline handlers resolve.');
process.exit(0);
