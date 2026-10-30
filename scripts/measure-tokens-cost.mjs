// File: scripts/measure-tokens-cost.mjs · Node 22+ ESM · §6.4: token cost of a fixed prompt set — 25 fixed
// prompts through askLlm; input/output tokens from the provider's own usage field (measured, not estimated);
// cost computed against cloud/config.js per-model prices. Reported per call and per 1,000 user actions.
//
// LOCAL runs exercise the PIPELINE against the simulator with the PLACEHOLDER prices in cloud/config.js — the
// output is explicitly labeled non-publishable. The live run (coordinator) must FIRST verify model ids and
// prices against the provider's live docs/pricing page on the measurement date, write source+date into
// PRICES_USD_PER_MTOK.verified, and only then run with --live (real provider; this is real money).
//
//   npm run measure:tokens-cost
//   node scripts/measure-tokens-cost.mjs --live        (provider = whatever the deployed cloud/config.js uses)
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { args, ROOT } from './lib/env.mjs';
import { setupContext, evidenceFile, nowIso, today } from './lib/measure.mjs';

const a = args();
const ctx = await setupContext({ live: !!a.live });
const config = createRequire(import.meta.url)('../cloud/config.js');
const price = config.PRICES_USD_PER_MTOK[config.MODEL];

if (a.live && !price.verified) {
  console.error(`REFUSING --live: PRICES_USD_PER_MTOK['${config.MODEL}'].verified is null — verify the model id and prices against the provider's live docs and pricing page ON THE MEASUREMENT DATE, record 'YYYY-MM-DD <url>' in the deployed cloud/config.js AND the local copy, then re-run (amendments pt. 3).`);
  await ctx.close();
  process.exit(2);
}

// 25 fixed prompts (deterministic, varied lengths — the realistic shape of a notes feature's traffic).
const PROMPTS = Array.from({ length: 25 }, (_, i) => {
  const filler = 'Note line about anvils, tunnels and roadrunner logistics. '.repeat((i % 5) + 1);
  return `Summarize note ${i + 1}: ${filler}`.trim();
});

const ev = evidenceFile(`tokens-cost-${ctx.target}-${today()}.md`);
const csvFile = path.join(ROOT, 'docs', 'evidence', `tokens-cost-${ctx.target}-${today()}.csv`);
ev.append(`# Token cost of the fixed prompt set (§6.4) — ${ctx.target.toUpperCase()} — ${nowIso()}

${ctx.target === 'local'
    ? '**LOCAL + SIMULATOR + PLACEHOLDER PRICES: pipeline evidence only — these dollar figures are labels, not costs, and must never be published.**'
    : `Prices verified: ${price.verified} (model ${config.MODEL}).`}

- Model: ${config.MODEL} · prices (USD/MTok): input ${price.input}, output ${price.output} · verified: ${price.verified || 'NO — placeholders'}
- ${PROMPTS.length} fixed prompts through askLlm; tokens from the provider's usage field.

`);

const csv = [['prompt_idx', 'prompt_chars', 'input_tokens', 'output_tokens', 'estimated_cost_usd']];
let totIn = 0; let totOut = 0; let totCost = 0;
for (let i = 0; i < PROMPTS.length; i++) {
  const r = await ctx.api.call('askLlm', { prompt: PROMPTS[i] }, { session: ctx.session });
  if (!r.ok) throw new Error(`askLlm failed on prompt ${i + 1}: ${JSON.stringify(r.error)}`);
  const u = r.result.usage;
  totIn += u.inputTokens; totOut += u.outputTokens; totCost += r.result.estimatedCostUsd;
  csv.push([i + 1, PROMPTS[i].length, u.inputTokens, u.outputTokens, r.result.estimatedCostUsd.toFixed(6)]);
}
writeFileSync(csvFile, csv.map((r) => r.join(',')).join('\n') + '\n');

const perCall = totCost / PROMPTS.length;
ev.append(`## Results (${nowIso()})

- Totals over ${PROMPTS.length} calls: ${totIn} input tokens, ${totOut} output tokens.
- Mean per call: ${(totIn / PROMPTS.length).toFixed(1)} in / ${(totOut / PROMPTS.length).toFixed(1)} out · ${perCall.toFixed(6)} USD${ctx.target === 'local' ? ' (PLACEHOLDER prices)' : ''}.
- Per 1,000 user actions: ${(perCall * 1000).toFixed(4)} USD${ctx.target === 'local' ? ' (PLACEHOLDER prices)' : ''}.
- Raw rows: ${path.basename(csvFile)}.
`);
console.log(`25 prompts: ${totIn} in / ${totOut} out tokens · per call ${perCall.toFixed(6)} USD · per 1000 actions ${(perCall * 1000).toFixed(4)} USD ${ctx.target === 'local' ? '(PLACEHOLDER prices, simulator)' : ''}`);
console.log(`evidence: ${ev.relative} + ${path.relative(ROOT, csvFile)}`);
await ctx.close();
