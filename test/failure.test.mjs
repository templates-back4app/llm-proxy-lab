// File: test/failure.test.mjs · F/G-series: FAIL-CLOSED rows (amendments pt. 2: if the budget cannot be read
// or the usage row cannot be written, askLlm refuses) and the timeout aftermath. This file runs in its own
// process (node --test), so it shortens the proxy's provider timeout and shrinks the global budget via env
// BEFORE cloud/config.js loads. Failure injection uses the lab-only [[fail:…]] prompt directives, enabled only
// on this throwaway server (LLM_LAB_FAILPOINTS=1 — never a default deploy).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { harness } from './helpers.mjs';

let h; let user; let config;
before(async () => {
  h = await harness({
    suite: 'failure',
    env: { LLM_PROVIDER_TIMEOUT_MS: 600, LLM_GLOBAL_DAILY_BUDGET_USD: 0.01 },
  });
  user = await h.signUp('fail_user');
  config = createRequire(import.meta.url)('../cloud/config.js');
});
after(async () => { await h.cleanup(); });

test('F1 usage storage unreadable (injected): refused BUDGET_UNAVAILABLE — fail closed, no provider call', async (t) => {
  if (h.liveSkip(t, 'needs the local failpoints (LLM_LAB_FAILPOINTS) — fail-closed layer proven in the local run')) return;
  const simBefore = h.sim.stats.messages;
  const r = await h.ask('hi [[fail:budget-read]]', user.token);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BUDGET_UNAVAILABLE');
  assert.equal(h.sim.stats.messages, simBefore, 'provider never called');
  assert.equal((await h.usageRows(user.objectId)).length, 0, 'no row');
  h.record({
    id: 'F1', test: 'fail closed', persona: 'signed-in user, usage store read fails',
    attempt: 'askLlm with injected budget-read failure',
    status: r.status, code: 'BUDGET_UNAVAILABLE',
    body: 'refuses rather than spending unmetered', state: 'no row; provider call count unchanged',
  });
});

test('F2 usage row cannot be written (injected): refused USAGE_WRITE_FAILED — fail closed, no provider call', async (t) => {
  if (h.liveSkip(t, 'needs the local failpoints')) return;
  const simBefore = h.sim.stats.messages;
  const r = await h.ask('hi [[fail:usage-write]]', user.token);
  assert.equal(r.error.code, 'USAGE_WRITE_FAILED');
  assert.equal(h.sim.stats.messages, simBefore, 'the provider is NEVER called when spend cannot be recorded');
  assert.equal((await h.usageRows(user.objectId)).length, 0, 'no row');
  h.record({
    id: 'F2', test: 'fail closed', persona: 'signed-in user, usage write fails',
    attempt: 'askLlm with injected pre-call usage-write failure',
    status: r.status, code: 'USAGE_WRITE_FAILED',
    body: 'refuses; unrecordable spend is refused spend', state: 'no row; provider call count unchanged',
  });
});

test('F3 post-call usage update fails (injected): the pending row with its conservative estimate survives', async (t) => {
  if (h.liveSkip(t, 'needs the local failpoints')) return;
  const simBefore = h.sim.stats.messages;
  const r = await h.ask('hi [[fail:usage-update]] [[sim:out:4]]', user.token);
  assert.equal(r.error.code, 'USAGE_RECORD_FAILED');
  assert.equal(h.sim.stats.messages, simBefore + 1, 'the provider WAS called (spend happened)');
  const rows = await h.usageRows(user.objectId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'pending', 'row stays pending');
  assert.equal(rows[0].outputTokens, config.MAX_OUTPUT_TOKENS,
    'conservative cap estimate retained — spend is never under-recorded');
  h.record({
    id: 'F3', test: 'fail closed (aftermath)', persona: 'signed-in user, post-call update fails',
    attempt: 'askLlm with injected usage-update failure (provider answered ok)',
    status: r.status, code: 'USAGE_RECORD_FAILED',
    body: 'the answer is withheld; the client gets an error',
    state: 'pending row with the conservative cap estimate still counts against the budget',
  });
});

test('G1-local provider exceeds the proxy timeout: mapped envelope; the aftermath row EXISTS (timeout outcome)', async () => {
  const rowsBefore = (await h.usageRows(user.objectId)).length;
  const t0 = performance.now();
  const r = await h.ask('slow one [[sim:sleep:2000]]', user.token);
  const ms = performance.now() - t0;
  assert.equal(r.error.code, 'PROVIDER_TIMEOUT');
  assert.equal(r.error.timeoutMs, 600, 'envelope names the configured limit');
  assert.ok(ms < 1900, `aborted near the 600 ms limit, did not wait the provider out (took ${ms.toFixed(0)} ms)`);
  const rows = await h.usageRows(user.objectId);
  assert.equal(rows.length, rowsBefore + 1, 'the timed-out call still has a row (written pre-call)');
  const row = rows[rows.length - 1];
  assert.equal(row.outcome, 'timeout');
  assert.equal(row.outputTokens, config.MAX_OUTPUT_TOKENS, 'unknown output priced at the cap');
  h.observe('G1-local: client-visible timeout error after (ms)', ms.toFixed(0));
  h.record({
    id: 'G1a', test: 'timeout aftermath (LOCAL: the proxy\'s own limit; the platform\'s is live-phase G1)',
    persona: 'signed-in user',
    attempt: 'provider sleeps 2000 ms, proxy timeout 600 ms',
    status: r.status, code: 'PROVIDER_TIMEOUT',
    body: 'our envelope naming timeoutMs; no partial body',
    state: 'row outcome=timeout with conservative cap pricing — usage IS still recorded',
  });
});

test('G1b slow body (headers sent, body late) also hits the timeout mapping', async () => {
  const r = await h.ask('drip [[sim:slow-body:2000]]', user.token);
  assert.equal(r.error.code, 'PROVIDER_TIMEOUT', 'a slow BODY is a timeout too (fetch body read is inside the abort scope)');
  const rows = await h.usageRows(user.objectId);
  assert.equal(rows[rows.length - 1].outcome, 'timeout');
  h.record({
    id: 'G1b', test: 'timeout aftermath', persona: 'signed-in user',
    attempt: 'provider sends headers immediately, body after 2000 ms (timeout 600 ms)',
    status: r.status, code: 'PROVIDER_TIMEOUT',
    body: 'same mapped envelope as the no-answer case', state: 'row outcome=timeout',
  });
});

test('T18 global daily limit: the backstop multiple accounts cannot multiply past', async () => {
  const sybil1 = await h.signUp('sybil1');
  const sybil2 = await h.signUp('sybil2');
  // Fill the (tiny, env-shrunk) GLOBAL budget from one account, then watch a DIFFERENT account get refused
  // while still far under its own per-user budget.
  await h.seedSpend(sybil1.objectId, 0.01);
  const r = await h.ask('fresh account, fresh budget? [[sim:out:4]]', sybil2.token);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'GLOBAL_BUDGET_EXCEEDED');
  assert.equal(r.error.globalBudgetUsd, 0.01);
  assert.equal((await h.usageRows(sybil2.objectId)).length, 0, 'no row for the refused call');
  h.record({
    id: 'T18', test: 'global daily limit', persona: 'second account after the global budget is spent',
    attempt: 'askLlm from a fresh user with 0 personal spend',
    status: r.status, code: 'GLOBAL_BUDGET_EXCEEDED',
    body: 'envelope names the global budget and resetAt — N accounts do not multiply the exposure past it',
    state: 'no row; provider call count unchanged',
  });
});
