# Build diary — llm-proxy-lab

## 2026-10-30 — Phase A built and green locally (37 tests, 0 failed, 0 skipped)

Built against `brief-llm-api-key-backend-blog-post-v1.md` + its amendments (amendments win). **LOCAL ONLY:**
parse-server 7.5.4 (Postgres 17 on :5433, databases `llm_dev`/`llm_test`), Node 25 (engines ≥22), ports 1343
(parse) / 1344 (simulator). Every provider call in every test and measurement was served by the deterministic
simulator (`scripts/simulator.mjs`). No Back4app backend was touched and no real LLM provider was called.

### Decisions

- **Best-effort budget, denominated in estimated USD** (amendments pt. 1+2): the check sums recorded
  `LlmUsage.estimatedCostUsd` for user and globally before the call; input and output tokens are priced
  separately from `PRICES_USD_PER_MTOK` (**placeholders** until verified on the measurement date). The check
  does NOT pre-charge the current request (brief §4.2 step 3 wording: "sum ≥ budget → refused"), which is
  exactly what makes the oversized-final-request window (T16) real and measurable. Atomic reservations are
  the described upgrade path, not built.
- **Fail closed** (amendments pt. 2): budget unreadable → `BUDGET_UNAVAILABLE`; pending usage row unwritable
  → `USAGE_WRITE_FAILED` and the provider is never called (F1/F2 assert the simulator's call counter is
  unchanged). The pending row is written BEFORE the provider call with a conservative estimate (input from
  chars/4, output priced at the cap), so a timeout still leaves recorded spend (G1a) and a failed post-call
  update leaves the conservative row rather than under-recording (F3).
- **Pending rows double as the concurrency ledger**: `countPending(day, user)` enforces
  `MAX_CONCURRENT_PER_USER` (T17) with a 150 ms stagger in the test for determinism — the cap itself is
  check-then-act and therefore best-effort too, same honesty rule as the budget.
- **Backstops multiple accounts cannot multiply past** (amendments pt. 2): `GLOBAL_DAILY_BUDGET_USD` (T18
  shows a second, personally-unspent account refused once the global bucket is full) and the concurrency cap.
  Public sign-up is disabled (`_User` create master-only); test personas come from the token-gated
  `testCreateUser` (zz-prefix enforced). `_User.isAdmin` is server-set (hook refuses client writes, T6b);
  admins get the LARGER budget, never an unlimited one (decision 4: no exemptions, T6).
- **Setup helpers = SETUP_ENABLED + server-checked SETUP_TOKEN** (amendments: gated pattern PLUS a token):
  `setupSchema`, `testCreateUser`, `testSeedUsage`, `testInspect`, `testCleanup` all require
  `params.setupToken === config.SETUP_TOKEN`. `testSeedUsage` exists so budget-edge rows need no real spend
  to set up, local or live.
- **Deterministic simulator instead of ad-hoc mocks** (amendments pt. 3): Claude Messages shape, JSON and
  SSE, `[[sim:429]] / [[sim:500]] / [[sim:sleep:ms]] / [[sim:slow-body:ms]] / [[sim:malformed]] /
  [[sim:out:N]] / [[sim:tps:N]]` directives, deterministic token math (in = chars/4, out = min(cap,
  directive)), `/__last-request` introspection (how T7/T8 prove the server-side body is the only body) and
  `/__stats` (the provider-call counter the request budget uses). Usage-write failures cannot be simulated by
  a provider, so those are lab-only `[[fail:…]]` failpoints behind `LLM_LAB_FAILPOINTS=1` — set only by the
  test harness for its own throwaway server, never a default deploy.
- **Canary, not a real key, in the demo build** (amendments pt. 4): `DEMO_KEY_IN_CLIENT` requires the env var
  AND the build flag (T10b); the bundle gets the committed synthetic
  `sk-ant-api03-CANARY-…` whose exact value the extraction scripts grep for. The default build STRIPS the
  direct-provider code path (T2b) instead of leaving dead code with key-shaped placeholders.
- **Extraction search widened** (amendments pt. 4): bundle + source map (with sourcesContent) + served
  `/config.js` + captured error responses + logs/ + docs/evidence/ + `git log -p --all`. Hits are classified
  `synthetic-known` (committed canary/placeholder) vs `UNKNOWN` (always a failure). Redaction in reports
  breaks the key shape on purpose so evidence files can never self-poison later scans. Claim wording: "no key
  found in these inspected surfaces", surfaces listed.
- **§6.1 per amendments pt. 5**: overhead measured against the CONTROLLED endpoint only (direct vs via
  function, same vantage, interleaved legs), margin registered in the evidence file BEFORE the timed runs
  (25 ms default), contemporaneous baseline in the same session. §6.3 reports BOTH time-to-first-usable-output
  and time-to-full-completion. All worded "observed in these tests".
- **Budget-read implementation**: paged `find` + sum (bounded `select`, 1000/page) instead of the brief's
  aggregate pipeline — the Postgres and MongoDB adapters disagree on aggregate key encoding for pointers, and
  a wrong pipeline would surface as spurious fail-closed refusals. Flagged as a live-phase check: if Plan
  Usage (H7) shows the paged sum is materially more expensive, switch to an aggregate on the live backend and
  re-run the matrix. Semantics are identical.

### Findings while running it locally

- `"type": "module"` in the root package.json silently turns `cloud/*.js` into ESM and the server dies with
  `require is not defined` — fixed with `cloud/package.json` (`{"type":"commonjs"}`), same as tenant-lab.
  Not uploaded to Back4app.
- **The abort timer must cover the BODY, not just the headers** (caught by writing G1b before the fix): the
  first implementation cleared the timeout in the fetch `finally`, so a provider that sends headers instantly
  and the body late ([[sim:slow-body:2000]]) would have HUNG past the configured limit and then succeeded.
  Now `res.json()` runs under the same AbortController and a body-read abort maps to `PROVIDER_TIMEOUT`.
- UTC day via `Intl.DateTimeFormat('en-US', {timeZone:'UTC'}).formatToParts` — the `en-CA` shortcut returns a
  different shape on some server ICU builds (observed in this workspace on Back4app Cloud Code, 2026-10;
  cashflow-tracker commit d84029d).
- **T14 (race) distribution, local**: at N=2 and N=5 every concurrent call passed the budget check
  (overspend = N·cost − ε); at N=10, runs showed partial refusals (overspend 0.002628–0.003310 "USD" at
  placeholder prices) — some calls finished and recorded spend before others checked. The window scales with
  effective concurrency; the live run will re-measure on real network latencies. Raw:
  `docs/evidence/race-t14-local-2026-10-30.csv`.
- **T16 oversized final request, local**: a user 0.0001 under budget ran the full 512-token cap and overspent
  by ≈0.0026 "USD" (placeholder prices) ≈ one maximum response — the next call was refused. Matches the
  designed window exactly.
- **H1 mechanism, local (simulator, 20 tokens paced at 20 tok/s)**: direct SSE TTFUO p50 ≈ 53 ms vs TTFC
  ≈ 1022 ms; via the function TTFUO = TTFC ≈ 1017 ms (one JSON payload; T8 proves `stream:true` is not
  forwarded). TTFC across all three legs within the registered 15% margin. These are loopback mechanism
  numbers; the article's H1 verdict comes from the live phase.
- **Hop overhead, local (controlled endpoint, 100 runs after 20 warm-ups)**: direct p50 0.2 ms, via function
  p50 3.6 ms → hop ≈ 3.4 ms on loopback — within the registered 25 ms margin, and a protocol rehearsal more
  than a finding (the live hop includes real network + platform).
- Parse CLP refusals on the master-only `LlmUsage`: observed codes recorded in the T3/T9 matrix rows.
- `parse-server` deprecation warnings (`encodeParseObjectInCloudFunction`, insecure auth adapters) are noise
  at 7.5.4; revisit at the live run.

### Request budget, computed from the real test inventory (amendments C4)

Instrumented in `scripts/lib/rest.mjs` (every suite prints its inventory) and the simulator's `/__stats`.
One full local `npm test` (37 tests):

| Suite | Backend HTTP requests | Provider calls (simulator) |
|---|---|---|
| positive | 15 | 3 |
| matrix | 66 | 11 |
| failure | 23 | 3 |
| race | 90 | 43 |
| streaming | 6 | 2 (1 streamed) |
| extraction | 9 | 1 (+2 direct, not via backend) |
| **total** | **209** | **63** |

Top endpoints: `askLlm` 84 · setup/test helper functions 37 · master read-backs 40 (live: these become
`testInspect` calls, so the live total stays ≈200–250) · logins 22 · local-only purges 18.

Measurement scripts (local run of each):
- `measure:overhead`: 120 `askLlm` backend requests (20 warm + 100 timed) + 120 direct controlled-endpoint
  calls + ~6 setup requests.
- `measure:streaming`: 25 `askLlm` + 50 direct (25 streamed) + setup.
- `measure:tokens-cost`: 25 `askLlm` + setup.

**HTTP requests vs billable operations** (amendments C4): one `askLlm` call is ONE HTTP request but ~6
platform operations — the function invocation, two budget-sum queries (user + global), the pending count,
the pending insert, the final update. Whether internal Cloud Code operations count against the plan quota is
exactly H7, measured live via Plan Usage before/after a counted batch — do not assume either way.

**Live-phase spend plan derived from this inventory** (to be re-confirmed against verified prices before any
real call; the withdrawn "~400 calls" guess is replaced by this computation):
- Matrix + race suites against the DEPLOYED SIMULATOR: ≈63 provider-sim calls, **zero provider dollars**.
- Real-provider counted sets: tokens-cost 25 (haiku, ≤512 out) · streaming real 2×(5+20)=50 (haiku, small) ·
  real end-to-end latency (reported separately from the hop) 2×(20+100)=240 (haiku, 8-token outputs) ·
  G1 real timeout probe ≈10 long generations (sonnet, large max_tokens) · T13 real-429 burst ≤60 (tier
  stated). ≈ **375 haiku-class calls + ≈10 sonnet long generations**; dollar ceiling computed on the
  measurement date from the verified prices and written here BEFORE the first real call.
- T15/H5 platform-throttle runs point `askLlm` at the simulator (the throttle binds on backend requests, not
  provider spend): zero provider dollars, but they consume plan requests — run last.

### Live-phase TODO checklist (verified-on-date; nothing below is assumed from the brief)

- [ ] Verify model id `claude-haiku-5-5` and `claude-sonnet-5` against the provider's live docs on the
      measurement date; record URL + date here.
- [ ] Verify input/output USD/MTok for both models on the provider's pricing page on the measurement date;
      write `verified: 'YYYY-MM-DD <url>'` into `PRICES_USD_PER_MTOK` in BOTH the deployed `cloud/config.js`
      and the local copy (`measure:tokens-cost --live` refuses while `verified` is null).
- [ ] Owner provides: a provider API key (server-side only, into the deployed `cloud/config.js`) and the
      spend ceiling; record the ceiling here before the first real call.
- [ ] Compute and record the dollar ceiling for the ≈375+10 real calls above from the verified prices.
- [ ] Decide (owner): is the direct-to-provider "before" call shown with a real throwaway key (created at
      minimum limit, revoked same day, creation+revocation logged in the evidence file), or does the canary
      extraction suffice? Phase A's T10 works with the canary alone.
- [ ] G1: measure the platform's function timeout (binary-searched delay via the simulator's
      `[[sim:sleep:ms]]`), the client-visible error, and whether the pending row is finalized or left
      pending — then the real-provider version on `claude-sonnet-5`; publish the `max_tokens` envelope as
      "completed in these tests".
- [ ] H5/H7: 155-throttle interplay and Plan Usage quota math (billable ops per `askLlm`).
- [ ] H6: a key stored in dashboard config parameters without the master-key-only restriction — one raw
      request to prove readability.
- [ ] Extraction search against the DEPLOYED client surfaces (the served bundle/config.js of the Containers
      app, not just the local build) + `--live` label; keep the claim scoped to the listed surfaces.
- [ ] Set `SETUP_ENABLED = false` + fresh `SETUP_TOKEN` rotation once real users exist.

### Exact live-phase command list (coordinator)

```bash
# after creating the backend app, filling .env.live (APP_ID, JS_KEY, REST_KEY, SETUP_TOKEN, SERVER_URL),
# uploading cloud/main.js + cloud/config.js + cloud/guards.js (badge! then probe), deploying the simulator
# Containers app, and pointing the deployed config's LLM_PROVIDER_URL at it:
npm run setup -- --live                                   # schema via setupSchema + the askLlm 209-vs-141 probe
TEST_SERVER_URL=https://parseapi.back4app.com npm test    # full matrix; evidence lands as matrix-back4app-<date>.md
node scripts/measure-overhead.mjs  --live --provider-url https://<sim-app>.b4a.run
node scripts/measure-streaming.mjs --live --provider-url https://<sim-app>.b4a.run
# flip the deployed LLM_PROVIDER_URL to the real provider for the counted real sets, then:
node scripts/measure-tokens-cost.mjs --live               # refuses until PRICES…verified is set
npm run inspect:surfaces -- --live                        # plus the deployed-surface fetch (checklist above)
# demo build for the article's screenshots (canary only, never deployed):
DEMO_KEY_IN_CLIENT=1 npm run build:client -- --demo-key-in-client
```

### Evidence written this session (all LOCAL, simulator-based)

`matrix-local-2026-10-30.md` (31 rows) · `race-t14-local-2026-10-30.csv` ·
`extraction-local-2026-10-30.md` · `latency-overhead-local-2026-10-30.{md,csv}` ·
`streaming-h1-local-2026-10-30.{md,csv}` · `tokens-cost-local-2026-10-30.{md,csv}`
