// File: scripts/lib/measure.mjs · Node 22+ ESM · shared bootstrap for the measurement scripts.
//
// House protocol pieces every measurement script uses:
//   - CONTEMPORANEOUS BASELINE (amendments C1): every comparison is between legs measured in the SAME session
//     by the same script; no prior number is ever a baseline.
//   - REGISTERED MARGIN (amendments C2): the practical-equivalence margin is appended to the evidence file
//     BEFORE the timed runs start; verdicts are 'within margin' / 'outside margin' / 'inconclusive'.
//   - LOCAL vs LIVE: --live points at the Back4app backend from .env.live and a deployed simulator/provider
//     URL. Phase A never passes --live; the flag exists so the live phase (coordinator-run) reuses the exact
//     same script. Local numbers are LOCAL, SIMULATOR-BASED mechanism evidence, labeled as such.
import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT, LOCAL, loadDotEnv, ensureCloudConfig } from './env.mjs';
import { makeClient } from './rest.mjs';
import { startSimulator } from '../simulator.mjs';

export const RUN = 'zz' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer(); s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/**
 * setupContext({ live, providerUrl }) → { target, env, api, session, user, providerUrl, sim, close() }
 * Local: in-process simulator + parse-server (database llm_test), budgets raised so measurement volume never
 * trips the limiter (one factor at a time). Live: the .env.live backend; providerUrl must be the deployed
 * controlled endpoint for overhead runs (the function's own provider stays whatever cloud/config.js says).
 */
export async function setupContext({ live = false, providerUrl: providerUrlFlag } = {}) {
  if (live) {
    if (!loadDotEnv(path.join(ROOT, '.env.live'))) throw new Error('--live: no .env.live (APP_ID, JS_KEY, REST_KEY, SETUP_TOKEN, SERVER_URL)');
    const env = {
      name: 'back4app', APP_ID: process.env.APP_ID, JS_KEY: process.env.JS_KEY || '',
      REST_KEY: process.env.REST_KEY || '', MASTER_KEY: '', SETUP_TOKEN: process.env.SETUP_TOKEN || '',
      SERVER_URL: (process.env.SERVER_URL || 'https://parseapi.back4app.com').replace(/\/+$/, ''),
    };
    if (!env.APP_ID) throw new Error('--live: .env.live has no APP_ID');
    const api = makeClient(env, { retry: true });
    const { user, session } = await makeUser(api, env.SETUP_TOKEN);
    return {
      target: 'back4app', env, api, user, session, sim: null,
      providerUrl: providerUrlFlag || null,
      close: async () => { await api.call('testCleanup', { setupToken: env.SETUP_TOKEN, runPrefix: RUN }); },
    };
  }
  ensureCloudConfig();
  const sim = await startSimulator({ port: await freePort() });
  process.env.LLM_PROVIDER_URL = `${sim.url}/v1/messages`;
  process.env.LLM_DAILY_BUDGET_USD = process.env.LLM_DAILY_BUDGET_USD || '50';
  process.env.LLM_GLOBAL_DAILY_BUDGET_USD = process.env.LLM_GLOBAL_DAILY_BUDGET_USD || '500';
  process.env.LLM_MAX_CONCURRENT_PER_USER = process.env.LLM_MAX_CONCURRENT_PER_USER || '50';
  const { startServer } = await import('../dev-server.mjs');
  const handle = await startServer({ port: await freePort(), databaseURI: process.env.TEST_DATABASE_URL || LOCAL.TEST_DATABASE_URL, quiet: true });
  const env = { ...LOCAL, name: 'local-measure', SERVER_URL: handle.url };
  const api = makeClient(env);
  const { applySchema } = await import('../setup.mjs');
  await applySchema(env);
  const { user, session } = await makeUser(api, LOCAL.SETUP_TOKEN);
  return {
    target: 'local', env, api, user, session, sim,
    providerUrl: providerUrlFlag || sim.url,
    close: async () => {
      await api.call('testCleanup', { setupToken: LOCAL.SETUP_TOKEN, runPrefix: RUN });
      await handle.close();
      await sim.close();
    },
  };
}

async function makeUser(api, setupToken) {
  const username = `${RUN}_measure`;
  const password = 'Pw-' + crypto.randomBytes(9).toString('base64url');
  const created = await api.call('testCreateUser', { setupToken, username, password });
  if (!created.ok) throw new Error(`testCreateUser failed: ${JSON.stringify(created.error)}`);
  const login = await api.request('POST', '/login', { body: { username, password } });
  if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
  return { user: { objectId: created.result.objectId, username }, session: login.json.sessionToken };
}

/** Evidence writer bound to one file: register(text) appends and FLUSHES before any run; section() appends. */
export function evidenceFile(name) {
  const file = path.join(ROOT, 'docs', 'evidence', name);
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, '');
  return {
    file,
    relative: path.relative(ROOT, file),
    append: (text) => appendFileSync(file, text),
    read: () => readFileSync(file, 'utf8'),
  };
}

export function quantiles(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: q(0.5), p95: q(0.95), min: s[0], max: s[s.length - 1] };
}

export const fmt = (x) => (Math.round(x * 10) / 10).toFixed(1);
export const nowIso = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);
