// File: test/race.test.mjs · T14: the budget race window, OBSERVED AND REPORTED (amendments pt. 1 — the
// budget is best-effort; check-then-call is not a database constraint, so N concurrent calls at the budget
// edge can all pass the check before any of them records spend). N ∈ {2, 5, 10}, 3 runs each locally (the
// live phase re-runs with its own counts); the distribution lands in docs/evidence/race-t14-<target>-<date>.csv.
// The per-user concurrency cap is raised for this suite (env, own process) so T14 measures the BUDGET window,
// one factor at a time — the cap has its own row (T17).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { harness, TARGET } from './helpers.mjs';
import { ROOT } from '../scripts/lib/env.mjs';

let h; let config;
const RUNS = 3;
const NS = [2, 5, 10];
const csvRows = [['date', 'n_concurrent', 'run', 'successes', 'refused', 'spent_after_usd', 'overspend_usd']];

before(async () => {
  h = await harness({ suite: 'race', env: { LLM_MAX_CONCURRENT_PER_USER: 50 } });
  config = createRequire(import.meta.url)('../cloud/config.js');
});
after(async () => {
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(ROOT, 'docs', 'evidence', `race-t14-${TARGET}-${date}.csv`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, csvRows.map((r) => r.join(',')).join('\n') + '\n');
  console.log(`race: wrote ${path.relative(ROOT, file)} (${csvRows.length - 1} runs; placeholder prices — labels, not dollars)`);
  await h.cleanup();
});

test('T14 budget race: N concurrent calls just under the limit — overspend measured, not denied', async () => {
  const overspends = {};
  for (const n of NS) {
    overspends[n] = [];
    for (let run = 1; run <= RUNS; run++) {
      const u = await h.signUp(`race${n}x${run}`);
      await h.seedSpend(u.objectId, config.DAILY_BUDGET_USD - 0.0001); // one call's room left
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) => h.ask(`race ${i} [[sim:out:64]]`, u.token)),
      );
      const successes = results.filter((r) => r.ok).length;
      const refused = results.filter((r) => !r.ok && r.error.code === 'BUDGET_EXCEEDED').length;
      assert.equal(successes + refused, n, 'every call either succeeded or was budget-refused');
      assert.ok(successes >= 1, 'at least the one permitted call goes through (positive control inside the race)');
      const rows = await h.usageRows(u.objectId);
      const spentAfter = rows.reduce((s, r) => s + r.estimatedCostUsd, 0);
      const overspend = Math.max(0, spentAfter - config.DAILY_BUDGET_USD);
      overspends[n].push(overspend);
      csvRows.push([new Date().toISOString().slice(0, 10), n, run, successes, refused, spentAfter.toFixed(6), overspend.toFixed(6)]);
    }
    const sorted = [...overspends[n]].sort((a, b) => a - b);
    h.observe(`T14 overspend USD at N=${n} (min/med/max over ${RUNS} runs, placeholder prices)`,
      `${sorted[0].toFixed(6)} / ${sorted[Math.floor(sorted.length / 2)].toFixed(6)} / ${sorted[sorted.length - 1].toFixed(6)}`);
  }
  // The honest headline: under full concurrency the window scales with N — that is WHY the claim is
  // "limits expected spend", never "hard bound". Atomic reservations are the upgrade path, not built.
  const maxOver = Math.max(...NS.flatMap((n) => overspends[n]));
  assert.ok(maxOver > 0, 'the window exists and is reported');
  h.record({
    id: 'T14', test: 'budget race window', persona: `user at budget-0.0001 with N∈{${NS.join(',')}} concurrent calls`,
    attempt: `${RUNS} runs per N, fully concurrent askLlm (concurrency cap raised for this suite)`,
    status: 'mixed', code: 'ok / BUDGET_EXCEEDED',
    body: 'every response is a success or the budget envelope',
    state: `overspend distribution recorded in race-t14-${TARGET}-<date>.csv; max observed ${maxOver.toFixed(6)} USD (placeholder prices) — best-effort stated`,
  });
});
