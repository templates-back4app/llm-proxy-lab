// File: scripts/measure-overhead.mjs · Node 22+ ESM · §6.1 redesigned (amendments pt. 5): PROXY OVERHEAD IS
// MEASURED AGAINST THE CONTROLLED ENDPOINT, never by subtracting real-LLM latencies (geography and generation
// variance confound those). Two legs, same vantage, same session, one factor apart — the function hop:
//
//   (a) baseline:   this machine → controlled endpoint (the deterministic simulator), direct POST /v1/messages
//   (b) proxied:    this machine → askLlm (Cloud function) → the same controlled endpoint
//
// Fixed deterministic response ([[sim:out:8]], no pacing), temperature-free by construction. House protocol:
// 20 warm-ups discarded per leg, 100 timed runs, p50/p95. The practical-equivalence margin is REGISTERED IN
// THE EVIDENCE FILE BEFORE the timed runs (amendments C2); the verdict is within/outside margin or
// inconclusive. Real-LLM end-to-end numbers are a SEPARATE live-phase report (what users experience), never
// labeled "the hop".
//
//   npm run measure:overhead                      → LOCAL (simulator + in-process server; mechanism evidence)
//   node scripts/measure-overhead.mjs --live --provider-url https://<sim-app>.b4a.run \
//        [--margin-ms 25] [--runs 100] [--warmups 20]                    → live phase, coordinator-run ONLY
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { args, ROOT } from './lib/env.mjs';
import { setupContext, evidenceFile, quantiles, fmt, nowIso, today } from './lib/measure.mjs';

const a = args();
const RUNS = Number(a.runs || 100);
const WARMUPS = Number(a.warmups || 20);
const MARGIN_MS = Number(a['margin-ms'] || 25);
const PROMPT = 'Fixed overhead probe. [[sim:out:8]]';

const ctx = await setupContext({ live: !!a.live, providerUrl: a['provider-url'] });
if (!ctx.providerUrl) { console.error('--live needs --provider-url <deployed controlled endpoint>'); process.exit(2); }
const ev = evidenceFile(`latency-overhead-${ctx.target}-${today()}.md`);
const csvFile = path.join(ROOT, 'docs', 'evidence', `latency-overhead-${ctx.target}-${today()}.csv`);

// ---- margin registered BEFORE anything is timed --------------------------------------------------------
ev.append(`# Proxy overhead (§6.1) — ${ctx.target.toUpperCase()}, controlled endpoint — ${nowIso()}

${ctx.target === 'local' ? '**LOCAL mechanism evidence (simulator + in-process parse-server on loopback): numbers demonstrate the protocol, never the platform.**' : 'Live run against the deployed controlled endpoint.'}

## Registered BEFORE the run (practical-equivalence margin, amendments C2)

- Hypothesis H3: the hop costs latency; it counts as negligible only if median overhead (b−a) ≤ ${MARGIN_MS} ms.
- Protocol: ${WARMUPS} warm-ups discarded per leg, ${RUNS} timed runs per leg, one fixed prompt, fixed 8-token
  deterministic response, sequential requests, legs interleaved run-by-run so drift hits both equally.
- Baseline is contemporaneous: leg (a) is measured in this same session (amendments C1).

`);

async function directCall() {
  const t0 = performance.now();
  const res = await fetch(`${ctx.providerUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-measure-controlled', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 64, messages: [{ role: 'user', content: PROMPT }] }),
  });
  await res.json();
  if (res.status !== 200) throw new Error(`controlled endpoint answered ${res.status}`);
  return performance.now() - t0;
}

async function proxiedCall() {
  const t0 = performance.now();
  const r = await ctx.api.call('askLlm', { prompt: PROMPT }, { session: ctx.session });
  if (!r.ok) throw new Error(`askLlm failed: ${JSON.stringify(r.error)}`);
  return performance.now() - t0;
}

console.log(`margin registered in ${ev.relative}; warming up (${WARMUPS} per leg)…`);
for (let i = 0; i < WARMUPS; i++) { await directCall(); await proxiedCall(); }

const legA = []; const legB = [];
const csv = [['leg', 'run', 'ms']];
for (let i = 0; i < RUNS; i++) {
  legA.push(await directCall()); // interleaved: drift hits both legs equally
  legB.push(await proxiedCall());
  csv.push(['direct', i + 1, legA[i].toFixed(2)], ['proxied', i + 1, legB[i].toFixed(2)]);
}
writeFileSync(csvFile, csv.map((r) => r.join(',')).join('\n') + '\n');

const qa = quantiles(legA); const qb = quantiles(legB);
const overheadP50 = qb.p50 - qa.p50;
const verdict = overheadP50 <= MARGIN_MS ? `WITHIN the registered ${MARGIN_MS} ms margin` : `OUTSIDE the registered ${MARGIN_MS} ms margin`;

ev.append(`## Results (${nowIso()})

| Leg | n | p50 ms | p95 ms | min | max |
|---|---|---|---|---|---|
| (a) direct → controlled endpoint | ${qa.n} | ${fmt(qa.p50)} | ${fmt(qa.p95)} | ${fmt(qa.min)} | ${fmt(qa.max)} |
| (b) → askLlm → controlled endpoint | ${qb.n} | ${fmt(qb.p50)} | ${fmt(qb.p95)} | ${fmt(qb.min)} | ${fmt(qb.max)} |

- Median hop overhead (b−a, p50): **${fmt(overheadP50)} ms** — ${verdict} (observed in these tests, ${today()}, target ${ctx.target}).
- p95 overhead: ${fmt(qb.p95 - qa.p95)} ms. Raw runs: ${path.basename(csvFile)}.
- Note: the hop includes the platform's auth + the budget read + the pending usage write + the final update —
  billable-operation accounting is §6.6 (live phase).
`);

console.log(`leg (a) direct   p50 ${fmt(qa.p50)} ms · p95 ${fmt(qa.p95)} ms`);
console.log(`leg (b) proxied  p50 ${fmt(qb.p50)} ms · p95 ${fmt(qb.p95)} ms`);
console.log(`hop overhead p50 ${fmt(overheadP50)} ms — ${verdict}`);
console.log(`evidence: ${ev.relative} + ${path.relative(ROOT, csvFile)}`);
await ctx.close();
