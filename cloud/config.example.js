// File: cloud/config.example.js · CommonJS · Parse Server 7.x (Back4app runs Cloud Code on Node 19 — no
// Node 20+ only features here).
//
// COMMITTED TEMPLATE. The real file is cloud/config.js (gitignored): copy this file there, and for a live
// deploy put the real provider key into THAT copy only, then upload it next to main.js and guards.js through
// the dashboard. The key therefore exists in exactly one place — the server — and never in the repository.
// scripts/dev-server.mjs and the test harness create cloud/config.js from this template automatically when it
// is missing, so local work needs no manual copy.
'use strict';

// ---------------------------------------------------------------------------------------------------------
// Switches
// ---------------------------------------------------------------------------------------------------------

// Setup helpers (setupSchema, testInspect, testCleanup in cloud/main.js). They run with the master key on
// behalf of a caller holding the App ID + REST/JS key AND the SETUP_TOKEN below (server-checked, so the
// public keys alone are not enough — the token is the admission ticket for the test-run helpers).
//   >>> Before the backend has real users: set SETUP_ENABLED = false, upload config.js again, Deploy. <<<
const SETUP_ENABLED = true;

// Server-checked admin setup token (brief amendments: gated pattern PLUS a token). Every 'setup'-guarded
// function requires params.setupToken === SETUP_TOKEN. Locally the fixed dev value below is fine (the server
// only listens on localhost); on a live deploy REPLACE IT in cloud/config.js with a fresh random string and
// put the same string into .env (SETUP_TOKEN) on the machine that runs the suite.
const SETUP_TOKEN = process.env.LLM_LAB_SETUP_TOKEN || 'llm-proxy-lab-dev-setup-token';

// The deliberately vulnerable "before" build (test T10): when true, scripts/build-client.mjs may bake the
// CANARY key below into the shipped client bundle, which then calls the provider directly. OFF by default and
// never in a default deploy; the extraction demo runs only against the lab's own page. The canary is a
// SYNTHETIC secret (provider key shape + recognizable marker) — extracting it proves extractability with
// nothing at risk. A real key never rides this flag.
const DEMO_KEY_IN_CLIENT = process.env.DEMO_KEY_IN_CLIENT === '1';

// Recognizable synthetic canary. Provider key shape (sk-ant-…), marker CANARY, zero value if leaked — it is
// committed on purpose so the extraction scripts can grep for it by exact value.
const CANARY_KEY = 'sk-ant-api03-CANARY-llm-proxy-lab-demo-key-DO-NOT-USE-00000000000000000000AA';

// Lab-only failure injection (amendments pt. 3): when enabled, a prompt may carry [[fail:…]] directives that
// make the usage-storage steps throw deterministically (budget-read, usage-write, usage-update), so the
// fail-closed rows of the matrix are testable. NEVER enabled on a default deploy: the local test harness sets
// the env var for its own throwaway server process only.
const FAILPOINTS_ENABLED = process.env.LLM_LAB_FAILPOINTS === '1';

// ---------------------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------------------

// The provider key. LIVE DEPLOY: paste the real key here, in cloud/config.js only (gitignored, uploaded
// through the dashboard — never committed, never in a client-reachable env var). The placeholder below keeps
// the same recognizable non-secret shape as the canary so the extraction scan can prove where it does NOT
// appear.
const LLM_API_KEY = process.env.LLM_API_KEY || 'sk-ant-api03-PLACEHOLDER-llm-proxy-lab-server-config-not-a-real-key-000000AA';

// Where askLlm sends provider calls. Default: the real provider. The local harness points it at the
// deterministic simulator (scripts/simulator.mjs) via LLM_PROVIDER_URL — Phase A never calls the real one.
const PROVIDER_URL = process.env.LLM_PROVIDER_URL || 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Hard wall-clock cap on one provider call, inside the platform's own function timeout (the timeout itself is
// a live-phase measurement, G1). The test harness lowers it to exercise the timeout path deterministically.
const PROVIDER_TIMEOUT_MS = Number(process.env.LLM_PROVIDER_TIMEOUT_MS || 20000);

// ---------------------------------------------------------------------------------------------------------
// Models, pricing, budget (budget is denominated in ESTIMATED COST, input and output priced separately —
// brief amendments pt. 2)
// ---------------------------------------------------------------------------------------------------------

// The server-chosen model. Clients cannot pick a model or a max_tokens — askLlm ignores those params (T7).
const MODEL = 'claude-haiku-5-5';

// Per-model prices in USD per million tokens. >>> PLACEHOLDER VALUES — the live phase MUST verify model ids
// and prices against the provider's live docs and pricing page ON THE MEASUREMENT DATE and record source+date
// in docs/evidence/ before any spend (amendments pt. 3). The local simulator makes no pricing claim; these
// numbers only exercise the arithmetic. <<<
const PRICES_USD_PER_MTOK = {
  'claude-haiku-5-5': { input: 1.0, output: 5.0, verified: null }, // verified: 'YYYY-MM-DD <url>' at live time
  'claude-sonnet-5': { input: 3.0, output: 15.0, verified: null },
};

// Per-user daily budgets in estimated USD, UTC day boundary. BEST-EFFORT usage limiting, not a hard spending
// bound (amendments pt. 1): the check sums recorded usage before calling the provider, so concurrent calls
// and an oversized final request can overspend — the tests measure and report the window. Admins get a larger
// budget, never an unlimited one (brief decision 4: no exemptions).
const DAILY_BUDGET_USD = Number(process.env.LLM_DAILY_BUDGET_USD || 0.50);
const ADMIN_DAILY_BUDGET_USD = Number(process.env.LLM_ADMIN_DAILY_BUDGET_USD || 2.00);

// Backstops multiple accounts cannot multiply past (amendments pt. 2): a global daily spend limit across all
// users, and a per-user cap on concurrent in-flight calls.
const GLOBAL_DAILY_BUDGET_USD = Number(process.env.LLM_GLOBAL_DAILY_BUDGET_USD || 10.00);
const MAX_CONCURRENT_PER_USER = Number(process.env.LLM_MAX_CONCURRENT_PER_USER || 2);

// Fixed server-side system prompt and temperature 0: the server's body is the only body (T8) and test runs
// are reproducible. Clients cannot override either.
const SYSTEM_PROMPT = 'You are the ACME notes assistant. Answer briefly and factually.';
const TEMPERATURE = 0;

// Validation caps.
const MAX_PROMPT_CHARS = 4000;
const MAX_OUTPUT_TOKENS = 512; // the server's max_tokens; worded "completed in these tests", never a deadline
const CHARS_PER_TOKEN_ESTIMATE = 4; // input-token estimate for pending rows; real counts come from usage

// ---------------------------------------------------------------------------------------------------------
// Schema: LlmUsage is CLOSED to clients (CLP master-only; T3/T9) — one row per provider call, written only by
// Cloud Code. The budget check reads it; the pending→final row lifecycle is what makes refusals fail-closed.
// ---------------------------------------------------------------------------------------------------------

const CLP_MASTER_ONLY = {};
const CLP_ALL_MASTER = {
  find: CLP_MASTER_ONLY, get: CLP_MASTER_ONLY, count: CLP_MASTER_ONLY,
  create: CLP_MASTER_ONLY, update: CLP_MASTER_ONLY, delete: CLP_MASTER_ONLY, addField: CLP_MASTER_ONLY,
};

const SCHEMA = [
  {
    className: 'LlmUsage',
    why: 'one row per provider call: who spent what, when, with which outcome. Clients never read or write it.',
    fields: {
      user: { type: 'Pointer', targetClass: '_User' },
      day: { type: 'String' },            // 'YYYY-MM-DD' UTC — the budget bucket
      model: { type: 'String' },
      inputTokens: { type: 'Number' },    // provider-reported; estimated while pending
      outputTokens: { type: 'Number' },   // provider-reported; cap-conservative when unknown
      estimatedCostUsd: { type: 'Number' },
      outcome: { type: 'String' },        // 'pending' | 'ok' | 'provider_error' | 'timeout' | 'record_failed'
      requestChars: { type: 'Number' },
    },
    classLevelPermissions: CLP_ALL_MASTER,
    indexes: {
      llmusage_user_day: { user: 1, day: 1 },
      llmusage_day: { day: 1 },
    },
  },
];

module.exports = {
  SETUP_ENABLED: SETUP_ENABLED,
  SETUP_TOKEN: SETUP_TOKEN,
  DEMO_KEY_IN_CLIENT: DEMO_KEY_IN_CLIENT,
  CANARY_KEY: CANARY_KEY,
  FAILPOINTS_ENABLED: FAILPOINTS_ENABLED,
  LLM_API_KEY: LLM_API_KEY,
  PROVIDER_URL: PROVIDER_URL,
  ANTHROPIC_VERSION: ANTHROPIC_VERSION,
  PROVIDER_TIMEOUT_MS: PROVIDER_TIMEOUT_MS,
  MODEL: MODEL,
  SYSTEM_PROMPT: SYSTEM_PROMPT,
  TEMPERATURE: TEMPERATURE,
  PRICES_USD_PER_MTOK: PRICES_USD_PER_MTOK,
  DAILY_BUDGET_USD: DAILY_BUDGET_USD,
  ADMIN_DAILY_BUDGET_USD: ADMIN_DAILY_BUDGET_USD,
  GLOBAL_DAILY_BUDGET_USD: GLOBAL_DAILY_BUDGET_USD,
  MAX_CONCURRENT_PER_USER: MAX_CONCURRENT_PER_USER,
  MAX_PROMPT_CHARS: MAX_PROMPT_CHARS,
  MAX_OUTPUT_TOKENS: MAX_OUTPUT_TOKENS,
  CHARS_PER_TOKEN_ESTIMATE: CHARS_PER_TOKEN_ESTIMATE,
  SCHEMA: SCHEMA,
};
