// File: test/helpers.mjs · shared by the node:test suites. Raw REST only — no Parse SDK, no browser.
//
// Target: by default an in-process parse-server (scripts/dev-server.mjs) on a free port with the database
// postgres://localhost:5433/llm_test, purged at the start of every suite file, plus an in-process DETERMINISTIC
// PROVIDER SIMULATOR (scripts/simulator.mjs) on a free port — cloud/config.js is pointed at it via
// LLM_PROVIDER_URL before the server loads Cloud Code. NO REAL PROVIDER IS EVER CALLED by this suite.
//
// For the LIVE run (coordinator-run, later):
//
//   TEST_SERVER_URL=https://parseapi.back4app.com npm test
//
// which loads the keys from .env.live (APP_ID, JS_KEY, REST_KEY, SETUP_TOKEN — never the master key), uses the
// token-gated Cloud helpers instead of master-key REST (setupSchema, testCreateUser, testSeedUsage,
// testInspect, testCleanup), and SKIPS, with a printed reason, the parts that need the local failpoints. The
// live backend's cloud/config.js must point LLM_PROVIDER_URL at the deployed simulator Containers app for the
// directive-driven rows; real-provider rows are separate counted runs.
//
// Every object a run creates carries the per-execution RUN prefix in its username, so parallel or crashed runs
// never collide and cleanup can only ever sweep its own run. Every suite records matrix rows (persona,
// attempt, HTTP/Parse code, body assertion, state assertion) into docs/evidence/.rows-<target>.jsonl;
// `npm test` regenerates docs/evidence/matrix-<target>-<date>.md from them (scripts/evidence.mjs).
import { createServer } from 'node:net';
import crypto from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { LOCAL, ROOT, loadDotEnv, ensureCloudConfig } from '../scripts/lib/env.mjs';
import { makeClient, parseCloudError, where, sleep } from '../scripts/lib/rest.mjs';
import { startSimulator } from '../scripts/simulator.mjs';

export { where, sleep, parseCloudError, startSimulator };
/** Per-execution run prefix: every username carries it (shape enforced by testCleanup). */
export const RUN = 'zz' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
export const unique = (prefix) => `${RUN}_${prefix}_${crypto.randomBytes(3).toString('hex')}`.toLowerCase();
export const password = () => 'Pw-' + crypto.randomBytes(9).toString('base64url');

/** Evidence label: 'back4app' only for the real live host — a localhost TEST_SERVER_URL is a rehearsal. */
export const TARGET = !process.env.TEST_SERVER_URL ? 'local'
  : /back4app\.com/.test(process.env.TEST_SERVER_URL) ? 'back4app' : 'remote-rehearsal';
const ROWS_FILE = path.join(ROOT, 'docs', 'evidence', `.rows-${TARGET}.jsonl`);

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer(); s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/**
 * Starts (or attaches to) the server + simulator, applies the schema, purges local data (local) / nothing
 * (live). opts.env: extra process env (budgets, timeout, failpoints) that cloud/config.js reads AT LOAD —
 * node --test runs each file in its own process, so a suite file sets these before calling harness().
 */
export async function harness({ suite, env: extraEnv = {} } = {}) {
  let env; let handle = null; let sim = null; let isLocal = true;
  if (process.env.TEST_SERVER_URL) {
    isLocal = false;
    loadDotEnv(path.join(ROOT, '.env.live')); // live keys live here; never printed, never committed
    loadDotEnv();
    env = {
      name: TARGET,
      APP_ID: process.env.APP_ID, JS_KEY: process.env.JS_KEY || '', REST_KEY: process.env.REST_KEY || '',
      MASTER_KEY: process.env.MASTER_KEY || '', SETUP_TOKEN: process.env.SETUP_TOKEN || '',
      SERVER_URL: process.env.TEST_SERVER_URL.replace(/\/+$/, ''),
    };
    if (!env.APP_ID) throw new Error('TEST_SERVER_URL is set but APP_ID is missing — fill .env.live first.');
  } else {
    ensureCloudConfig();
    loadDotEnv();
    // The deterministic simulator first; Cloud Code must see its URL when config.js loads.
    sim = await startSimulator({ port: await freePort() });
    process.env.LLM_PROVIDER_URL = `${sim.url}/v1/messages`;
    process.env.LLM_LAB_FAILPOINTS = process.env.LLM_LAB_FAILPOINTS ?? '1'; // throwaway test server only
    for (const [k, v] of Object.entries(extraEnv)) process.env[k] = String(v);
    const { startServer } = await import('../scripts/dev-server.mjs');
    const port = await freePort();
    handle = await startServer({ port, databaseURI: process.env.TEST_DATABASE_URL || LOCAL.TEST_DATABASE_URL, quiet: true });
    env = { ...LOCAL, name: 'local-test', SERVER_URL: handle.url };
  }
  const api = makeClient(env, { retry: !isLocal }); // live: retry Back4app's 155 throttle with backoff
  const canMaster = !!env.MASTER_KEY;
  const setupToken = env.SETUP_TOKEN || LOCAL.SETUP_TOKEN;

  if (canMaster) {
    const { applySchema } = await import('../scripts/setup.mjs');
    await applySchema(env);
  } else {
    const setup = await api.call('setupSchema', { setupToken, allowRerun: true });
    if (!setup.ok) {
      const why = setup.error.code === 'SETUP_DISABLED' ? 'cloud/config.js has SETUP_ENABLED=false on this backend'
        : setup.error.code === 'SETUP_TOKEN_INVALID' ? 'SETUP_TOKEN in .env/.env.live does not match the deployed cloud/config.js'
          : /Invalid function/.test(setup.error.message || '') ? 'Cloud Code is not deployed (upload main.js, config.js, guards.js, confirm the badge, Deploy — verify with a request)'
            : `HTTP ${setup.status} ${JSON.stringify(setup.error)}`;
      throw new Error(`setupSchema failed: ${why}`);
    }
  }
  if (isLocal) {
    // Purge everything from previous runs so budget sums and state assertions are deterministic. Live runs
    // never purge: testCleanup removes this run's rows only.
    for (const cls of ['LlmUsage', '_Session', '_User']) {
      await api.request('DELETE', `/purge/${cls}`, { master: true });
    }
  }

  const observations = [];
  const h = {
    env, api, sim, isLocal, canMaster, setupToken, observations, suite: suite || 'suite',

    /** Skip helper for live runs: parts that need the local failpoints or master REST print a reason live. */
    liveSkip(t, reason) {
      if (isLocal) return false;
      t.skip(`live run: ${reason}`);
      return true;
    },

    observe(label, value) { observations.push({ label, value }); },

    /** One evidence-matrix row. `id` sorts the final table (P1, T4, F2, …). */
    record(row) {
      mkdirSync(path.dirname(ROWS_FILE), { recursive: true });
      appendFileSync(ROWS_FILE, JSON.stringify({ suite: h.suite, at: new Date().toISOString(), ...row }) + '\n');
    },

    // ---- raw REST --------------------------------------------------------------------------------------
    rest: (method, p, body, opts = {}) => api.request(method, p, { ...opts, body }),
    fn: (name, params, session) => api.request('POST', `/functions/${name}`, { body: params || {}, session }),
    /** Cloud call with the envelope unwrapped: {ok, status, result | error:{parseCode, code, message}} */
    call: (name, params, session) => api.call(name, params || {}, { session }),
    /** askLlm shorthand. */
    ask: (prompt, session, extraParams) => api.call('askLlm', { prompt, ...(extraParams || {}) }, { session }),

    /**
     * Master-rights read-back for STATE assertions (equality-where only). Locally: REST with the master key.
     * Live: the token-gated Cloud function testInspect — the master key never leaves the dashboard.
     */
    async master(className, whereObj) {
      if (canMaster) {
        const r = await api.request('GET', `/classes/${className}?where=${where(whereObj)}`, { master: true });
        if (r.status !== 200) throw new Error(`master read ${className} failed: ${r.status} ${JSON.stringify(r.json)}`);
        return r.json.results;
      }
      const r = await api.call('testInspect', { setupToken, className, where: whereObj, limit: 1000 });
      if (!r.ok) throw new Error(`testInspect ${className} failed: ${JSON.stringify(r.error)}`);
      return r.result.results;
    },

    /** This run's LlmUsage rows for one user (today). */
    usageRows(userId) {
      return h.master('LlmUsage', { user: ptr('_User', userId) });
    },

    // ---- personas (public sign-up is DISABLED — users are created server-side, via the token-gated helper)
    async signUp(prefix, { isAdmin = false } = {}) {
      const username = unique(prefix);
      const pw = password();
      const created = await api.call('testCreateUser', { setupToken, username, password: pw, isAdmin });
      if (!created.ok) throw new Error(`testCreateUser failed: ${JSON.stringify(created.error)}`);
      const r = await api.request('POST', '/login', { body: { username, password: pw } });
      if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.json)}`);
      return { username, pw, objectId: created.result.objectId, token: r.json.sessionToken, isAdmin };
    },
    async login(username, pw) {
      const r = await api.request('POST', '/login', { body: { username, password: pw } });
      if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
      return { objectId: r.json.objectId, token: r.json.sessionToken };
    },

    /** Seeds today's usage for a test user up to `totalUsd` (token-gated helper; works local and live). */
    async seedSpend(userId, totalUsd, count = 1) {
      const r = await api.call('testSeedUsage', { setupToken, userId, costUsd: totalUsd / count, count });
      if (!r.ok) throw new Error(`testSeedUsage failed: ${JSON.stringify(r.error)}`);
      return r.result;
    },

    async cleanup() {
      printObservations(`${h.suite} observations`, observations);
      // The request inventory: this is what the build diary's request budget is computed from (C4 — HTTP
      // requests, with provider calls and billable platform operations reported separately).
      console.log(`\n## ${h.suite} request inventory (HTTP requests this suite sent)`);
      console.log(`total: ${api.stats.requests}`);
      for (const [p, n] of Object.entries(api.stats.byPath).sort((a, b) => b[1] - a[1])) console.log(`- ${p}: ${n}`);
      if (sim) console.log(`- provider calls that reached the simulator: ${sim.stats.messages} (streamed: ${sim.stats.streamed})`);
      if (!isLocal) {
        const r = await api.call('testCleanup', { setupToken, runPrefix: RUN });
        if (r.ok) console.log(`cleanup: testCleanup(${RUN}) removed ${JSON.stringify(r.result)}`);
        else console.log(`cleanup: testCleanup failed (${r.error.code}) — rows with prefix ${RUN} remain on the backend`);
      }
      if (handle) await handle.close();
      if (sim) await sim.close();
    },
  };
  return h;
}

export async function mustCall(h, name, params, session) {
  const r = await h.call(name, params, session);
  if (!r.ok) throw new Error(`${name} failed: HTTP ${r.status} ${JSON.stringify(r.error)}`);
  return r.result;
}

export function ptr(className, objectId) {
  return { __type: 'Pointer', className, objectId };
}

/** Prints the observations table so a test run doubles as evidence for the article. */
export function printObservations(title, observations) {
  if (!observations.length) return;
  console.log([`\n## ${title}`, ...observations.map((o) => `- ${o.label}: ${o.value}`)].join('\n'));
}
