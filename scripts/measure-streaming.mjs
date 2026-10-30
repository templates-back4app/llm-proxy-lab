// File: scripts/measure-streaming.mjs · Node 22+ ESM · §6.3/H1 (amendments pt. 5): streaming vs non-streaming
// compared on BOTH time-to-first-usable-output (TTFUO) AND time-to-full-completion (TTFC). Three legs, same
// session, same deterministic generation (N tokens at a paced tokens/second so "generation time" exists):
//
//   (s) direct, stream:true   → TTFUO = first content_block_delta, TTFC = message_stop
//   (n) direct, non-streaming → TTFUO = TTFC = the single JSON body
//   (f) through askLlm        → TTFUO = TTFC = the single JSON result (H1: a Cloud function returns one
//                               payload; the simulator confirms no stream flag was forwarded)
//
// 20 runs per leg after 5 warm-ups (house §6.3 count). Margins registered before the run. LOCAL runs are
// mechanism evidence on the simulator; --live is the coordinator's (deployed simulator for the controlled
// comparison; the real-provider streaming numbers are their own counted set).
//
//   npm run measure:streaming
//   node scripts/measure-streaming.mjs --live --provider-url https://<sim-app>.b4a.run [--runs 20]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { args, ROOT } from './lib/env.mjs';
import { setupContext, evidenceFile, quantiles, fmt, nowIso, today } from './lib/measure.mjs';

const a = args();
const RUNS = Number(a.runs || 20);
const WARMUPS = Number(a.warmups || 5);
const TOKENS = 20; const TPS = 20; // ≈1 s of paced generation
const PROMPT = `Streaming probe. [[sim:out:${TOKENS}]] [[sim:tps:${TPS}]]`;

const ctx = await setupContext({ live: !!a.live, providerUrl: a['provider-url'] });
if (!ctx.providerUrl) { console.error('--live needs --provider-url <deployed controlled endpoint>'); process.exit(2); }
const ev = evidenceFile(`streaming-h1-${ctx.target}-${today()}.md`);
const csvFile = path.join(ROOT, 'docs', 'evidence', `streaming-h1-${ctx.target}-${today()}.csv`);

ev.append(`# Streaming vs non-streaming (§6.3, H1) — ${ctx.target.toUpperCase()} — ${nowIso()}

${ctx.target === 'local' ? '**LOCAL mechanism evidence (deterministic simulator, loopback): demonstrates the protocol and the H1 mechanism, never the platform\'s numbers.**' : 'Live run.'}

## Registered BEFORE the run (amendments C2)

- Generation: ${TOKENS} tokens paced at ${TPS} tok/s (≈${(TOKENS / TPS).toFixed(1)} s) — one factor (delivery mode) varies.
- H1 expectation to test: through the Cloud function, TTFUO == TTFC (one JSON payload); direct SSE delivers
  TTFUO at roughly first-token time. TTFC of all three legs counts as equivalent within 15% of the direct
  non-streaming median; TTFUO(s) counts as a real streaming win only if its median is under half of TTFC(s).
- ${WARMUPS} warm-ups discarded per leg, ${RUNS} timed runs per leg, legs interleaved.

`);

const body = (stream) => JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 64, stream, messages: [{ role: 'user', content: PROMPT }] });
const headers = { 'content-type': 'application/json', 'x-api-key': 'sk-measure-controlled', 'anthropic-version': '2023-06-01' };

async function directStream() {
  const t0 = performance.now();
  let ttfuo = null;
  const res = await fetch(`${ctx.providerUrl}/v1/messages`, { method: 'POST', headers, body: body(true) });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (ttfuo === null && buf.includes('content_block_delta')) ttfuo = performance.now() - t0;
  }
  return { ttfuo, ttfc: performance.now() - t0 };
}

async function directJson() {
  const t0 = performance.now();
  const res = await fetch(`${ctx.providerUrl}/v1/messages`, { method: 'POST', headers, body: body(false) });
  await res.json();
  const t = performance.now() - t0;
  return { ttfuo: t, ttfc: t };
}

async function viaFunction() {
  const t0 = performance.now();
  const r = await ctx.api.call('askLlm', { prompt: PROMPT, stream: true }, { session: ctx.session });
  if (!r.ok) throw new Error(`askLlm failed: ${JSON.stringify(r.error)}`);
  const t = performance.now() - t0;
  return { ttfuo: t, ttfc: t };
}

console.log(`margins registered in ${ev.relative}; warming up…`);
for (let i = 0; i < WARMUPS; i++) { await directStream(); await directJson(); await viaFunction(); }

const legs = { 'direct-stream': [], 'direct-json': [], 'via-function': [] };
const csv = [['leg', 'run', 'ttfuo_ms', 'ttfc_ms']];
for (let i = 0; i < RUNS; i++) {
  for (const [name, fn] of [['direct-stream', directStream], ['direct-json', directJson], ['via-function', viaFunction]]) {
    const r = await fn();
    legs[name].push(r);
    csv.push([name, i + 1, r.ttfuo.toFixed(1), r.ttfc.toFixed(1)]);
  }
}
writeFileSync(csvFile, csv.map((r) => r.join(',')).join('\n') + '\n');

const rows = Object.entries(legs).map(([name, rs]) => {
  const ttfuo = quantiles(rs.map((r) => r.ttfuo));
  const ttfc = quantiles(rs.map((r) => r.ttfc));
  return { name, ttfuo, ttfc };
});
ev.append(`## Results (${nowIso()})

| Leg | n | TTFUO p50 ms | TTFUO p95 ms | TTFC p50 ms | TTFC p95 ms |
|---|---|---|---|---|---|
${rows.map((r) => `| ${r.name} | ${r.ttfuo.n} | ${fmt(r.ttfuo.p50)} | ${fmt(r.ttfuo.p95)} | ${fmt(r.ttfc.p50)} | ${fmt(r.ttfc.p95)} |`).join('\n')}

- Both dimensions reported, per amendments pt. 5: the streaming win is TTFUO; TTFC is what every mode pays.
- H1 verdict for the ARTICLE comes from the live phase; this file ${ctx.target === 'local' ? 'is the local mechanism record' : 'is the live record'}. Raw runs: ${path.basename(csvFile)}.
`);
for (const r of rows) console.log(`${r.name.padEnd(14)} TTFUO p50 ${fmt(r.ttfuo.p50)} ms · TTFC p50 ${fmt(r.ttfc.p50)} ms`);
console.log(`evidence: ${ev.relative} + ${path.relative(ROOT, csvFile)}`);
await ctx.close();
