// File: test/positive.test.mjs · P-series: positive controls (house rule: a matrix of refusals proves nothing
// if the allowed path is also broken). Asserts response bodies AND database state (LlmUsage read back with
// master rights), never just status codes. LOCAL + SIMULATOR: the "provider" is scripts/simulator.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.mjs';

let h; let alice; let bob;
before(async () => {
  h = await harness({ suite: 'positive' });
  alice = await h.signUp('alice');
  bob = await h.signUp('bob');
});
after(async () => { await h.cleanup(); });

test('P1 signed-in user, valid prompt: text + usage returned; one LlmUsage row matching the body', async () => {
  const r = await h.ask('Summarize: anvils are heavy. [[sim:out:12]]', alice.token);
  assert.equal(r.ok, true, `askLlm failed: ${JSON.stringify(r.error)}`);
  assert.ok(typeof r.result.text === 'string' && r.result.text.length > 0, 'body has text');
  assert.ok(r.result.usage.inputTokens > 0 && r.result.usage.outputTokens === 12, 'body has non-zero usage');
  assert.ok(r.result.estimatedCostUsd > 0, 'cost computed from both token counts');
  assert.equal(r.result.model, 'claude-haiku-5-5', 'the SERVER-chosen model ran');
  assert.ok(r.result.budget.resetAt.endsWith('T00:00:00.000Z'), 'budget reset is the UTC day boundary');

  const rows = await h.usageRows(alice.objectId);
  assert.equal(rows.length, 1, 'exactly one LlmUsage row');
  assert.equal(rows[0].outcome, 'ok');
  assert.equal(rows[0].inputTokens, r.result.usage.inputTokens, 'row tokens match the body');
  assert.equal(rows[0].outputTokens, 12);
  assert.equal(rows[0].estimatedCostUsd, r.result.estimatedCostUsd);
  h.record({
    id: 'P1', test: 'positive control', persona: 'signed-in user',
    attempt: 'askLlm({prompt}) with a valid prompt',
    status: 200, code: null,
    body: 'text + usage (in>0, out=12) + estimatedCostUsd + budget.resetAt at UTC midnight; model is the server\'s',
    state: 'one LlmUsage row, outcome=ok, tokens and cost equal to the body',
  });
});

test('P2 same user, second call same UTC day: succeeds; budget sum reflects both rows', async () => {
  const first = (await h.usageRows(alice.objectId)).reduce((s, r) => s + r.estimatedCostUsd, 0);
  const r = await h.ask('And now a second note. [[sim:out:8]]', alice.token);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.result.budget.spentTodayUsd - (first + r.result.estimatedCostUsd)) < 1e-9,
    'spentTodayUsd = previous spend + this call');
  const rows = await h.usageRows(alice.objectId);
  assert.equal(rows.length, 2, 'two rows for two calls');
  h.record({
    id: 'P2', test: 'positive control', persona: 'same user, same UTC day',
    attempt: 'second askLlm call',
    status: 200, code: null,
    body: 'budget.spentTodayUsd equals the sum of both calls',
    state: 'two LlmUsage rows attributed to the user',
  });
});

test('P3 a second user calls on the same day: budgets are per user, rows attributed correctly', async () => {
  const r = await h.ask('Bob\'s first note. [[sim:out:4]]', bob.token);
  assert.equal(r.ok, true);
  assert.equal(r.result.budget.spentTodayUsd, r.result.estimatedCostUsd,
    'bob\'s spend starts at his own call, not alice\'s');
  const bobRows = await h.usageRows(bob.objectId);
  const aliceRows = await h.usageRows(alice.objectId);
  assert.equal(bobRows.length, 1, 'bob has exactly his own row');
  assert.equal(aliceRows.length, 2, 'alice\'s rows untouched');
  h.record({
    id: 'P3', test: 'positive control', persona: 'second user, same day',
    attempt: 'askLlm by another user',
    status: 200, code: null,
    body: 'spentTodayUsd counts only this user\'s calls',
    state: 'rows attributed to the right users (1 vs 2)',
  });
});
