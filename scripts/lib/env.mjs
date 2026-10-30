// File: scripts/lib/env.mjs · Node 22+ ESM
// .env loading, the fixed LOCAL target, target selection and CLI flags — shared by scripts and tests.
// Same pattern as the sibling repos (tenant-lab, game-backend-starter).
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Fixed keys of the LOCAL parse-server (scripts/dev-server.mjs). They are not secrets: the server only listens
// on localhost and the database is a throwaway. Port 1343 and simulator port 1344 are this lab's slots
// (tenant-lab holds 1341/5433's tenant_* databases, chat-lab will hold 1342/1352 — do not collide).
export const LOCAL = {
  name: 'local',
  APP_ID: 'llm-proxy-lab-dev',
  JS_KEY: 'llm-proxy-lab-dev-js',
  REST_KEY: 'llm-proxy-lab-dev-rest',
  MASTER_KEY: 'llm-proxy-lab-dev-master',
  SETUP_TOKEN: 'llm-proxy-lab-dev-setup-token',
  SERVER_URL: 'http://localhost:1343/parse',
  PORT: 1343,
  DATABASE_URL: 'postgres://localhost:5433/llm_dev',
  TEST_DATABASE_URL: 'postgres://localhost:5433/llm_test',
};

// The deterministic provider simulator's fixed local port (scripts/simulator.mjs). Tests start their own
// instance on a free port instead.
export const SIM_PORT = 1344;

// cloud/config.js is gitignored (on a live deploy it holds the real provider key). Local work uses a verbatim
// copy of the committed template; this creates it when missing so `npm test` works on a fresh clone.
export function ensureCloudConfig() {
  const real = path.join(ROOT, 'cloud', 'config.js');
  if (!existsSync(real)) {
    copyFileSync(path.join(ROOT, 'cloud', 'config.example.js'), real);
    console.log('created cloud/config.js from cloud/config.example.js (gitignored; the live deploy edits that copy)');
  }
  return real;
}

export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!existsSync(file)) return false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

/**
 * Target selection: `--local` (or TARGET=local) → the local dev server; `--live` → the Back4app backend from
 * .env.live (keys are never printed; LIVE RUNS ARE THE COORDINATOR'S — Phase A never uses this); otherwise
 * the backend from .env, falling back to LOCAL.
 */
export function target(a = args()) {
  if (a.live) {
    if (!loadDotEnv(path.join(ROOT, '.env.live'))) {
      console.error('--live: no .env.live found. It must hold APP_ID, JS_KEY, REST_KEY, SERVER_URL, SETUP_TOKEN.');
      process.exit(2);
    }
    if (!process.env.APP_ID) { console.error('--live: .env.live has no APP_ID.'); process.exit(2); }
    return {
      name: 'back4app',
      APP_ID: process.env.APP_ID,
      JS_KEY: process.env.JS_KEY || '',
      REST_KEY: process.env.REST_KEY || '',
      MASTER_KEY: '', // the master key stays in the dashboard; everything privileged runs inside Cloud Code
      SETUP_TOKEN: process.env.SETUP_TOKEN || '',
      SERVER_URL: (process.env.SERVER_URL || 'https://parseapi.back4app.com').replace(/\/+$/, ''),
    };
  }
  loadDotEnv();
  if (a.local || process.env.TARGET === 'local' || !process.env.APP_ID) {
    return { ...LOCAL };
  }
  return {
    name: 'live',
    APP_ID: process.env.APP_ID,
    JS_KEY: process.env.JS_KEY || '',
    REST_KEY: process.env.REST_KEY || '',
    MASTER_KEY: process.env.MASTER_KEY || '',
    SETUP_TOKEN: process.env.SETUP_TOKEN || LOCAL.SETUP_TOKEN,
    SERVER_URL: (process.env.SERVER_URL || 'https://parseapi.back4app.com').replace(/\/+$/, ''),
  };
}

/** Parse command-line flags of the form --name value / --name=value / --flag. */
export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
    else out[a.slice(2)] = true;
  }
  return out;
}

/** Appends to (or creates) an evidence file; used by measurement scripts to register margins BEFORE runs. */
export function appendEvidence(file, text) {
  const full = path.join(ROOT, 'docs', 'evidence', file);
  const prev = existsSync(full) ? readFileSync(full, 'utf8') : '';
  writeFileSync(full, prev + text);
  return full;
}
