// File: test/extraction.test.mjs · T2/T10/T11 + H4: the extraction attack, run as reproducible code.
// T2/T11 inspect the DEFAULT build's shipped surfaces (bundle, source map, /config.js over HTTP, error
// responses) plus logs, evidence files and the full repo history — the claim is exactly "no key found in
// these inspected surfaces". T10 builds the deliberately vulnerable DEMO_KEY_IN_CLIENT variant (off by
// default, enabled here for one test with the env var) and extracts the SYNTHETIC canary from the bundle,
// then "spends" with it against the simulator — the honest "before" picture with nothing at risk.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { harness } from './helpers.mjs';
import { buildClient, startWebServer } from '../scripts/build-client.mjs';
import { inspectSurfaces, scanText, renderReport } from '../scripts/inspect-surfaces.mjs';
import { ROOT } from '../scripts/lib/env.mjs';

let h; let user; let config;
before(async () => {
  h = await harness({ suite: 'extraction' });
  user = await h.signUp('inspector');
  config = createRequire(import.meta.url)('../cloud/config.js');
});
after(async () => { await h.cleanup(); });

test('T2/T11/H4 default build: every byte the client is served holds no provider key material — and the haul is listed', async () => {
  const built = buildClient({ demoKeyInClient: false, serverUrl: h.env.SERVER_URL });
  const web = await startWebServer({ dir: built.dir });
  const servedTexts = [];
  try {
    for (const f of ['/', '/app.bundle.js', '/app.bundle.js.map', '/config.js']) {
      const res = await fetch(web.url + f);
      assert.equal(res.status, 200, `${f} served`);
      servedTexts.push({ label: `GET ${f} (served over HTTP)`, text: await res.text() });
    }
  } finally {
    await web.close();
  }
  // Error responses are a leak surface too (amendments pt. 4): capture real refusal bodies and scan them.
  const anon = await h.fn('askLlm', { prompt: 'x' });
  const invalid = await h.fn('askLlm', { prompt: '' }, user.token);
  const providerFail = await h.fn('askLlm', { prompt: 'x [[sim:500]]' }, user.token);
  servedTexts.push({ label: 'askLlm error responses (anonymous, validation, mapped provider 500)',
    text: JSON.stringify([anon.json, invalid.json, providerFail.json]) });

  const result = inspectSurfaces({ bundleDir: built.dir, extraTexts: servedTexts });
  assert.equal(result.clean, true, 'shipped surfaces: zero sk-ant-… hits and zero x-api-key hits');
  assert.equal(result.unknownHits.length, 0, 'no UNKNOWN (potentially real) key anywhere, repo history included');

  // T11, the attacker's haul — honest and NOT empty: what the shipped bytes DO contain.
  const everything = servedTexts.map((s) => s.text).join('\n');
  assert.ok(everything.includes(h.env.APP_ID), 'haul: the App ID ships (public by design)');
  assert.ok(everything.includes(h.env.JS_KEY), 'haul: the JS key ships (public by design)');
  assert.ok(everything.includes(h.env.SERVER_URL), 'haul: the server URL ships');
  assert.ok(!everything.includes(h.env.MASTER_KEY), 'the master key does NOT ship');
  assert.ok(!everything.includes(h.setupToken), 'the setup token does NOT ship');

  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(path.join(ROOT, 'docs', 'evidence', `extraction-local-${date}.md`),
    renderReport(result, { variant: 'default', target: 'local' }));
  h.record({
    id: 'T2', test: 'extraction search (default build)', persona: 'attacker with everything the client holds',
    attempt: 'grep bundle + source map + served /config.js + error responses + logs + evidence + git log -p for sk-ant-…/x-api-key',
    status: 'n/a', code: null,
    body: 'no key found in these inspected surfaces (surfaces listed in extraction-local-<date>.md)',
    state: 'haul = App ID, JS key, server URL — and nothing else (no master key, no setup token)',
  });
});

test('T10 DEMO_KEY_IN_CLIENT build: the canary key is extracted from the bundle and "spends" directly', async () => {
  process.env.DEMO_KEY_IN_CLIENT = '1';
  let built;
  try {
    built = buildClient({ demoKeyInClient: true, serverUrl: h.env.SERVER_URL, providerUrl: h.sim.url });
  } finally {
    delete process.env.DEMO_KEY_IN_CLIENT;
  }
  const bundle = readFileSync(path.join(built.dir, 'app.bundle.js'), 'utf8');
  const map = readFileSync(path.join(built.dir, 'app.bundle.js.map'), 'utf8');

  // Step 1 of the demo: the key shape alone finds it — no reverse engineering needed.
  const extracted = (scanText(bundle).keyHits[0] || {}).value;
  assert.equal(extracted, config.CANARY_KEY, 'the full key is readable in the shipped bundle');
  assert.ok(scanText(map).keyHits.length > 0, 'the source map leaks it too');

  // Step 2: the extracted key calls the provider directly — nobody asked the backend anything.
  const res = await fetch(`${h.sim.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': extracted, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: config.MODEL, max_tokens: 32, messages: [{ role: 'user', content: 'free tokens [[sim:out:8]]' }] }),
  });
  assert.equal(res.status, 200, 'the provider accepts the stolen key — unbounded spend in the real world');
  const json = await res.json();
  assert.ok(json.usage.output_tokens > 0);

  // And the backend's ledger knows NOTHING about it: direct calls bypass every budget.
  assert.equal((await h.master('LlmUsage', {})).filter((r) => r.requestChars > 0 && r.outcome === 'ok' && r.user.objectId === user.objectId).length, 0,
    'no LlmUsage row for the direct call — the budget never saw it');
  h.record({
    id: 'T10', test: 'extraction demo (deliberately vulnerable build)', persona: 'attacker with the shipped demo bundle',
    attempt: 'grep the bundle for the key shape; call the provider directly with the extracted key',
    status: 200, code: null,
    body: 'SYNTHETIC canary extracted from bundle AND source map; direct provider call succeeds',
    state: 'no LlmUsage row — key-in-client spend is invisible to every control. Flag off by default; canary only, never a real key.',
  });
});

test('T10b guardrail: the demo build refuses to build without the explicit env flag', async () => {
  delete process.env.DEMO_KEY_IN_CLIENT;
  assert.throws(() => buildClient({ demoKeyInClient: true }), /DEMO_KEY_IN_CLIENT=1/,
    'off by default, twice: the flag AND the env var are required');
  h.record({
    id: 'T10b', test: 'demo-flag guardrail', persona: 'builder',
    attempt: 'buildClient({demoKeyInClient:true}) without DEMO_KEY_IN_CLIENT=1',
    status: 'throws', code: null,
    body: 'refused with the env-var message', state: 'no dist/demo-key-in-client output produced',
  });
});

test('T2b the default bundle does not even contain the direct-provider code path', async () => {
  const bundle = readFileSync(path.join(ROOT, 'dist', 'default', 'app.bundle.js'), 'utf8');
  assert.ok(!bundle.includes('askProviderDirectly'), 'dead vulnerable code is stripped, not just disabled');
  assert.ok(!bundle.includes('__DEMO_PROVIDER_KEY__'), 'no placeholder slot ships either');
  h.record({
    id: 'T2b', test: 'extraction search (default build)', persona: 'attacker reading the bundle',
    attempt: 'look for the direct-provider code path in the default bundle',
    status: 'n/a', code: null,
    body: 'the askProviderDirectly function and its key slot are absent from the shipped bytes',
    state: 'n/a (static artifact)',
  });
});
