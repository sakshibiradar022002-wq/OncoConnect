// Extracts every inline <script> from the browser HTML apps and runs
// `node --check` on each. Catches syntax errors that would silently break
// a button in production. Used by CI and runnable locally: node scripts/check-html.mjs
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const files = ['public/index.html', 'public/patient.html', 'public/admin.html'];
let failures = 0;

for (const file of files) {
  let html;
  try { html = readFileSync(file, 'utf8'); } catch { continue; }
  // Inline scripts only (skip <script src=...>).
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, i = 0;
  while ((m = re.exec(html)) !== null) {
    const code = m[1];
    if (!code.trim()) { i++; continue; }
    const tmp = join(tmpdir(), `oc-check-${process.pid}-${i}.js`);
    writeFileSync(tmp, code);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } catch (e) {
      failures++;
      console.error(`✗ ${file} inline script #${i}:\n${e.stderr?.toString().slice(0, 600) || e.message}`);
    } finally {
      unlinkSync(tmp);
    }
    i++;
  }
  console.log(`✓ ${file}: ${i} inline script block(s) checked`);
}

if (failures) {
  console.error(`\n${failures} inline script(s) failed the syntax check.`);
  process.exit(1);
}
console.log('\nAll inline browser scripts parse cleanly.');
