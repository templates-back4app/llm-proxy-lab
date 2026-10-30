# llm-proxy-lab

Companion lab for the Back4app blog post **How to Call an LLM API Without Exposing Your API Key**
(slug `call-llm-from-app-without-api-key`). One Cloud function, `askLlm`, fronts the LLM provider: the
provider key lives in `cloud/config.js` on the server and nowhere else; the shipped client holds only the
App ID, the JS key and a session token. Every claim in the post reproduces from this repo as a test or a
measurement script — in the same family as `tenant-lab`.

**Phase A (this state of the repo) is LOCAL ONLY:** every provider call is served by a deterministic local
simulator. No real LLM provider is called, no remote backend is touched, and every number in
`docs/evidence/` is labeled LOCAL and simulator-based — mechanism evidence, never the article's numbers.
The live phase (Back4app + real provider) is run later by the coordinator with the same scripts.

## What the function does (each step owns one refusal)

1. **Auth** — no session → `UNAUTHENTICATED` (Parse 209 class) before anything else runs.
2. **Validation** — prompt present, within `MAX_PROMPT_CHARS`. Client-supplied `model`, `maxTokens`,
   `stream`, `system`, `temperature` are **not honored and not forwarded**: the server's allowlist, caps,
   fixed system prompt and temperature 0 are the only ones (T7/T8).
3. **Budget** — **best-effort usage limiting, denominated in estimated USD** (input and output tokens priced
   separately at `cloud/config.js` rates): per-user daily budget (admins get a larger one, never an
   unlimited one), a **global daily limit** and a **per-user concurrency cap** as the backstops multiple
   accounts cannot multiply past. **Fail closed:** if usage storage cannot be read, `askLlm` refuses
   (`BUDGET_UNAVAILABLE`).
4. **Record (pending)** — a conservative `LlmUsage` row is written **before** the provider call; if that
   write fails, `askLlm` refuses (`USAGE_WRITE_FAILED`) and the provider is never called. A timed-out call
   therefore still has a row.
5. **Provider call** — raw `fetch`, the key attached here and nowhere else; 429/5xx/timeouts/malformed
   bodies map to our envelope, never passed through raw.
6. **Finalize** — the row is updated with the provider-reported usage. If that update fails, the pending
   row's conservative estimate stays (spend is never under-recorded) and the client gets
   `USAGE_RECORD_FAILED`, not the text.

**The budget limits expected spend; it is not a hard spending bound.** Check-then-call is validation, not a
database constraint: concurrent calls (T14) and an oversized final request (T16) overspend, and the tests
measure and report the window instead of denying it. Atomic reservations + reconciliation are the upgrade
path (described in the article, not built here).

## Layout

```
cloud/main.js            askLlm + token-gated setup/test helpers + hooks (the second guard)
cloud/config.example.js  committed template: switches, prices (PLACEHOLDERS until verified), budgets, schema
cloud/config.js          gitignored working copy — the LIVE deploy puts the real key in THIS file only
cloud/guards.js          the GUARDS registry: a function without a declared guard fails the DEPLOY
scripts/simulator.mjs    deterministic provider simulator (Claude Messages shape, SSE + JSON, [[sim:…]] directives)
scripts/dev-server.mjs   local parse-server ^7 (port 1343, Postgres 5433, database llm_dev)
scripts/build-client.mjs the ACME client builds: default (proxy) and demo-key-in-client (off by default, canary only)
scripts/inspect-surfaces.mjs  the extraction search: bundle, source maps, /config.js, error responses, logs,
                              evidence files, full git history — claim: "no key found in these inspected surfaces"
scripts/measure-*.mjs    §6.1/§6.3/§6.4 measurement scripts (margins registered BEFORE runs; --live for later)
test/*.test.mjs          P/T/F/G/H suites; every row asserts body AND database state
docs/evidence/           generated evidence, labeled by target (local / back4app)
docs/notes/build-diary.md  decisions, findings, the computed request budget, live-phase TODOs
```

Port map: tenant-lab 1341 · chat-lab 1342 · **this lab 1343 (parse-server) + 1344 (simulator)** · Postgres
5433, databases `llm_dev` / `llm_test`.

## Run it locally

Needs Node ≥22 and Postgres 17 on port 5433 (`brew install postgresql@17`; databases are created on demand).

```bash
npm install
npm test                    # 37 tests: positive controls, the attack matrix, fail-closed rows, the race,
                            # streaming mechanism, the extraction search — all against the simulator
npm run measure:overhead    # §6.1 against the controlled endpoint (margin registered before the run)
npm run measure:streaming   # §6.3 TTFUO + TTFC, three legs
npm run measure:tokens-cost # §6.4 pipeline (placeholder prices — labeled, refuses --live until verified)
npm run inspect:surfaces    # the T2/T11 extraction search, writes docs/evidence/extraction-local-<date>.md
npm run dev:server          # http://localhost:1343/parse   (fixed local keys; see scripts/lib/env.mjs)
npm run simulator           # http://localhost:1344         (POST /v1/messages)
```

The deliberately vulnerable "before" build is **off by default, twice**:
`DEMO_KEY_IN_CLIENT=1 npm run build:client -- --demo-key-in-client`. It bakes a **synthetic canary**
(`sk-ant-api03-CANARY-…`, committed on purpose, zero value) into the bundle — extracting it proves
extractability with nothing at risk. A real key never rides this flag, and the default build strips the
direct-provider code path entirely (T2b).

## Deploying to Back4app (live phase — coordinator-run)

1. Create the backend app; copy the keys into `.env` (never committed). Set a fresh random `SETUP_TOKEN`
   in both `.env` and your `cloud/config.js` copy.
2. Put the real provider key into `cloud/config.js` (the gitignored copy) — never into the repo, never into
   a Containers env var that reaches `/config.js`.
3. **Upload Cloud Code: `cloud/main.js`, `cloud/config.js`, `cloud/guards.js`** (`cloud/package.json` is
   not needed). Mind the deploy quirk: on a fresh backend the first Deploy can report Success while shipping
   nothing, and a Deploy clicked without the "Files pending deploy (N)" badge ships nothing. Re-dirty each
   file, confirm the badge, Deploy — then **prove it with a request, never the dialog**:

   ```text
   $ curl -s -X POST https://parseapi.back4app.com/functions/askLlm \
       -H "X-Parse-Application-Id: $APP_ID" -H "X-Parse-REST-API-Key: $REST_KEY" \
       -H "Content-Type: application/json" -d '{}'
   {"code":209,"error":"…UNAUTHENTICATED…"}        ← Cloud Code is live
   {"code":141,"error":"Invalid function: \"askLlm\""}  ← not deployed yet
   ```

   `npm run setup -- --live` applies the schema through the token-gated `setupSchema` and runs this probe.
4. Deploy the simulator as a Containers app for the controlled-endpoint measurements; point the deployed
   `cloud/config.js` `LLM_PROVIDER_URL` at it for the matrix run, at the real provider for the counted
   real runs.
5. Before any real spend: verify model ids and prices against the provider's live docs and pricing page ON
   THE MEASUREMENT DATE, record `verified: 'YYYY-MM-DD <url>'` in `PRICES_USD_PER_MTOK`
   (`measure:tokens-cost --live` refuses to run while `verified` is null).
6. When the backend gets real users: set `SETUP_ENABLED = false` in the deployed `cloud/config.js` and
   re-deploy.

## Guarantees and limits (do not overstate them)

- The budget is **best-effort**: it limits expected spend and is not a hard bound. The measured windows
  (T14 race, T16 oversized final request) are in `docs/evidence/`.
- Hooks are validation, not database constraints; `LlmUsage` is closed to clients (CLP + hook), and
  `_User.isAdmin` is server-set, but cross-record invariants under concurrency are not guaranteed.
- Public sign-up is disabled (`_User` create is master-only); users are created server-side through the
  token-gated helper. Session theft is bounded (best-effort) by that user's daily budget — T12 states it
  honestly.
- The extraction claim is exactly **"no key found in these inspected surfaces"** (listed in the evidence
  file), never "no key anywhere".
- Local numbers are loopback + simulator mechanism evidence. Platform timeout (G1), real latency, costs,
  rate-limit interplay (H5) and quota math (H7) are live-phase measurements.

## Never

- Never commit `.env`, `.env.live` or `cloud/config.js`; never print the master key, a provider key or the
  setup token into chat, logs, commits or screenshots.
- Never deploy the `demo-key-in-client` build, and never put a real key into it — the canary exists so
  there is never a reason to.
- Never run the measurement scripts with `--live` from Phase A: the live phase is the coordinator's, with
  the owner's key and spend ceiling.
