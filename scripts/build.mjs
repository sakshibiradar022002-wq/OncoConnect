// Frontend build: bundle and minify the shared JS modules, and fingerprint
// them so a deploy can be cached aggressively without serving stale code.
//
//   npm run build          production build into public/dist
//   npm run build -- --dev unminified, with sourcemaps
//
// The apps' own inline scripts are left alone — moving 7,500 lines of inline
// code into modules is a separate, much larger change. What this covers is the
// shared layer (clinical logic, the action dispatcher, the DOM actions), which
// is exactly the code both apps depend on and the code that is unit-tested.
//
// index.html and patient.html reference /dist/app.<hash>.js, rewritten in place
// by this script, so the HTML always points at the build it was made with.

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const DEV = process.argv.includes('--dev');
const OUT = 'public/dist';
const ENTRIES = ['public/js/clinical.js', 'public/js/dispatch.js', 'public/js/dom-actions.js'];
const HTML = ['public/index.html', 'public/patient.html'];

mkdirSync(OUT, { recursive: true });

// Clear previous fingerprinted output so stale hashes don't accumulate.
for (const f of readdirSync(OUT)) {
  if (/^app\.[a-f0-9]+\.js(\.map)?$/.test(f)) unlinkSync(join(OUT, f));
}

// These are classic scripts that attach to window in a fixed order, so they
// concatenate rather than import one another. Order matters: clinical defines
// what dom-actions and the apps call.
const combined = ENTRIES.map(f =>
  `/* ${f} */\n` + readFileSync(f, 'utf8')).join('\n;\n');

const tmp = join(OUT, '.entry.js');
writeFileSync(tmp, combined);

const result = await build({
  entryPoints: [tmp],
  outfile: join(OUT, 'app.js'),   // needed so esbuild can name its outputs
  bundle: false,          // no imports to resolve; these are classic scripts
  minify: !DEV,
  sourcemap: DEV ? 'inline' : true,
  target: ['es2019'],     // matches the browsers the PWAs already support
  legalComments: 'none',
  write: false,
});

const code = result.outputFiles.find(f => f.path.endsWith('.js')).text;
const map = result.outputFiles.find(f => f.path.endsWith('.js.map'));
const hash = createHash('sha256').update(code).digest('hex').slice(0, 10);
const name = `app.${hash}.js`;

writeFileSync(join(OUT, name), code);
if (map) writeFileSync(join(OUT, name + '.map'), map.text);
unlinkSync(tmp);

// Point the HTML at the fresh bundle, replacing either the three separate
// script tags (first build) or a previous bundle reference (rebuild).
const TAG = `<script src="/dist/${name}"></script>`;
const SEPARATE = /<script src="\/js\/clinical\.js"><\/script>\s*<script src="\/js\/dispatch\.js"><\/script>\s*<script src="\/js\/dom-actions\.js"><\/script>/;
const BUNDLED = /<script src="\/dist\/app\.[a-f0-9]+\.js"><\/script>/;

for (const file of HTML) {
  let src = readFileSync(file, 'utf8');
  if (BUNDLED.test(src)) src = src.replace(BUNDLED, TAG);
  else if (SEPARATE.test(src)) src = src.replace(SEPARATE, TAG);
  else { console.error(`! ${file}: could not find the script tags to replace`); process.exit(1); }
  writeFileSync(file, src);
}

// Keep the service-worker shell pointing at the current bundle, and bump the
// cache name so an old build's cache is discarded rather than serving a stale
// dispatcher offline. The filename is fingerprinted, so this is belt-and-braces
// for the precache list specifically.
const SW = 'public/sw.js';
let sw = readFileSync(SW, 'utf8');
sw = sw.replace(/'\/dist\/app\.[a-f0-9]+\.js', ?/g, '');           // drop previous
sw = sw.replace(/(const SHELL = APP === 'doctor'\s*\?\s*\[)/, `$1'/dist/${name}', `);
sw = sw.replace(/(: \[)('\/patient\.html')/, `$1'/dist/${name}', $2`);
// Cache name derives from the bundle hash, not a timestamp: the same source
// must produce the same output, or CI could never tell a stale committed build
// from a fresh one.
sw = sw.replace(/oncoconnect-\$\{APP\}-v[\w]+/, `oncoconnect-\${APP}-v${hash}`);
writeFileSync(SW, sw);

const kb = (code.length / 1024).toFixed(1);
console.log(`built ${OUT}/${name}  (${kb} KB${DEV ? ', dev' : ', minified'})`);
console.log(`referenced from: ${HTML.join(', ')}, ${SW}`);
