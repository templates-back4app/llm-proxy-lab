// File: scripts/inspect-surfaces.mjs · Node 22+ ESM
// The extraction search (T2/T11, widened per brief amendments pt. 4). A reproducible script, not a
// screenshot: it greps EVERY BYTE of the inspected surfaces for provider-key material and reports exactly
// "no key found in these inspected surfaces", with the surfaces listed. Surfaces:
//
//   1. the shipped client bundle (dist/default/app.bundle.js)
//   2. its source maps (app.bundle.js.map, sourcesContent included)
//   3. the served /config.js and index.html (what a Containers app would echo to the browser)
//   4. error responses (captured by the test run into docs/evidence/.rows-*.jsonl and the matrix files)
//   5. logs/ (if any)
//   6. the evidence files themselves (docs/evidence/**)
//   7. the repository's full history (`git log -p`) — accidental commits included
//
// Patterns: the provider key shape (sk-ant-…), the header name x-api-key, the exact synthetic canary and the
// exact committed placeholder. The canary and the placeholder are committed ON PURPOSE (cloud/config.example.js,
// the demo build); the scan therefore classifies every hit as `synthetic-known` or `UNKNOWN`. The claim the
// post makes is: the DEFAULT build's surfaces (1–3) contain no hit at all, and no surface anywhere contains an
// UNKNOWN (i.e. potentially real) key. The demo build is expected to leak the canary — that is its job.
//
// Usage: npm run inspect:surfaces            (builds dist/default when missing, writes docs/evidence/)
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, args, ensureCloudConfig } from './lib/env.mjs';

ensureCloudConfig();
const config = createRequire(import.meta.url)('../cloud/config.js');

const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{8,}/g;
const HEADER_NAME = /x-api-key/gi;
const KNOWN_SYNTHETIC = [config.CANARY_KEY, config.LLM_API_KEY].filter((k) => k && k.startsWith('sk-ant-'));

// Redaction breaks the key SHAPE on purpose ('sk-ant-' + a non-matching glyph), so an evidence file that
// reports a hit can never itself become a hit on the next scan.
const redact = (s) => s.slice(0, 7) + '✂…✂' + s.slice(-6) + ' (' + s.length + ' chars)';

/** Scan one text: returns { keyHits: [{value, kind}], headerHits: n }. */
export function scanText(text) {
  const keyHits = [];
  for (const m of String(text).matchAll(KEY_SHAPE)) {
    keyHits.push({ value: m[0], kind: KNOWN_SYNTHETIC.includes(m[0]) ? 'synthetic-known' : 'UNKNOWN' });
  }
  const headerHits = (String(text).match(HEADER_NAME) || []).length;
  return { keyHits, headerHits };
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

/**
 * inspectSurfaces({ bundleDir, extraTexts }) → { surfaces: [{surface, bytes, keyHits, headerHits}], clean,
 * unknownHits }. `clean` = surfaces 1–3 have zero hits; `unknownHits` = any UNKNOWN key anywhere.
 */
export function inspectSurfaces({ bundleDir, extraTexts = [], includeHistory = true } = {}) {
  const surfaces = [];
  const add = (surface, text, shipped) => {
    const { keyHits, headerHits } = scanText(text);
    surfaces.push({ surface, shipped, bytes: Buffer.byteLength(String(text)), keyHits, headerHits });
  };

  if (bundleDir) {
    for (const f of ['app.bundle.js', 'app.bundle.js.map', 'config.js', 'index.html']) {
      const p = path.join(bundleDir, f);
      if (existsSync(p)) add(`${path.relative(ROOT, bundleDir)}/${f}`, readFileSync(p, 'utf8'), true);
    }
  }
  for (const { label, text } of extraTexts) add(label, text, true); // captured network/error responses
  for (const p of walk(path.join(ROOT, 'logs'))) add(path.relative(ROOT, p), readFileSync(p, 'utf8'), false);
  for (const p of walk(path.join(ROOT, 'docs', 'evidence'))) {
    if (p.endsWith('.md') || p.endsWith('.csv') || p.includes('.rows-')) add(path.relative(ROOT, p), readFileSync(p, 'utf8'), false);
  }
  if (includeHistory) {
    let history = '';
    try { history = execFileSync('git', ['-C', ROOT, 'log', '-p', '--all'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); } catch { /* fresh repo with no commits */ }
    add('git log -p --all (full repository history)', history, false);
  }

  const shippedSurfaces = surfaces.filter((s) => s.shipped);
  const clean = shippedSurfaces.every((s) => s.keyHits.length === 0 && s.headerHits === 0);
  const unknownHits = surfaces.flatMap((s) => s.keyHits.filter((h) => h.kind === 'UNKNOWN').map((h) => ({ surface: s.surface, value: redact(h.value) })));
  return { surfaces, clean, unknownHits };
}

export function renderReport({ surfaces, clean, unknownHits }, { variant = 'default', target = 'local' } = {}) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `# Extraction search — ${variant} build, ${target.toUpperCase()}, ${date}`,
    '',
    'Generated by scripts/inspect-surfaces.mjs. The supported claim is exactly: **no key found in these',
    'inspected surfaces** — the surfaces are listed below; nothing is claimed about surfaces not listed.',
    'Hits are classified `synthetic-known` (the committed canary/placeholder, present on purpose) or',
    '`UNKNOWN` (treated as a potentially real key: always a failure).',
    '',
    '| Surface | Shipped to client | Bytes scanned | sk-ant-… hits | x-api-key hits |',
    '|---|---|---|---|---|',
    ...surfaces.map((s) => `| ${s.surface} | ${s.shipped ? 'yes' : 'no'} | ${s.bytes} | ${s.keyHits.length ? s.keyHits.map((h) => `${h.kind}: ${redact(h.value)}`).join('; ') : '0'} | ${s.headerHits} |`),
    '',
    `**Shipped surfaces clean (no key material at all): ${clean ? 'YES' : 'NO'}**`,
    `**UNKNOWN (potentially real) keys anywhere: ${unknownHits.length ? 'YES — ' + JSON.stringify(unknownHits) : 'none'}**`,
    '',
  ];
  return lines.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('inspect-surfaces.mjs')) {
  const a = args();
  const { buildClient } = await import('./build-client.mjs');
  const built = buildClient({ demoKeyInClient: false });
  const result = inspectSurfaces({ bundleDir: built.dir });
  const report = renderReport(result, { variant: 'default', target: a.live ? 'back4app' : 'local' });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(ROOT, 'docs', 'evidence', `extraction-${a.live ? 'back4app' : 'local'}-${date}.md`);
  writeFileSync(file, report);
  console.log(report);
  console.log(`written: ${path.relative(ROOT, file)}`);
  process.exit(result.clean && result.unknownHits.length === 0 ? 0 : 1);
}
