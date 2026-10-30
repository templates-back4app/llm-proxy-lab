// File: cloud/main.js · CommonJS · Parse Server 7.x (Back4app runs Cloud Code on Node 19: global fetch, no
// Node 20+ only features).
//
// ONE function fronts the LLM provider: askLlm({prompt}). The provider key lives in cloud/config.js on the
// server and nowhere else; the client ships only the App ID + JS key + a session. The function's order of
// operations (each step owns one refusal, with its own error envelope — brief §4.2):
//
//   1. Auth        no session → UNAUTHENTICATED, before anything else runs.
//   2. Validation  prompt present, string, within MAX_PROMPT_CHARS. Client-supplied model/maxTokens/stream/
//                  system/temperature are NOT honored and NOT forwarded (T7/T8): the server's allowlist, caps
//                  and system prompt are the only ones.
//   3. Budget      BEST-EFFORT usage limiting, denominated in estimated USD (input and output tokens priced
//                  separately at cloud/config.js rates). Sums today's recorded rows for the user (and
//                  globally), checks the per-user concurrency cap. It is validation, NOT a database
//                  constraint: concurrent calls and an oversized final request can overspend — the tests
//                  measure the window (T14, oversized-final-request row). Atomic reservations + reconciliation
//                  are the upgrade path, described in the article, not built here.
//                  FAIL CLOSED: if usage storage cannot be read, askLlm refuses (BUDGET_UNAVAILABLE).
//   4. Record (pending) a conservative LlmUsage row (estimated input tokens, output priced at the cap) is
//                  written BEFORE the provider call. FAIL CLOSED: if that write fails, askLlm refuses
//                  (USAGE_WRITE_FAILED) and the provider is never called — unrecordable spend is refused
//                  spend. A timed-out call therefore still has a (conservative) row.
//   5. Provider    fetch to PROVIDER_URL with the server's key, model, caps, fixed system prompt,
//                  temperature 0, wall-clock cap PROVIDER_TIMEOUT_MS. Provider 429/5xx/timeouts/malformed
//                  bodies are mapped to OUR envelope, never passed through raw.
//   6. Finalize    the row is updated with the provider-reported usage and the real estimated cost. If THAT
//                  update fails, the row stays 'pending' with its conservative estimate (spend is never
//                  under-recorded) and the client gets USAGE_RECORD_FAILED.
//
// Guards: every function is registered through `define` (cloud/guards.js) and must be listed in the GUARDS
// table below; a forgotten guard fails the deploy, not the budget. The setup/inspect/cleanup helpers are
// gated by config.SETUP_ENABLED AND a server-checked admin setup token (config.SETUP_TOKEN).
//
// Error convention (same as the sibling repos): functions throw Parse.Error with a numeric Parse code and a
// JSON string message {"code":"BUDGET_EXCEEDED","message":"…", …extra}. Parse.Error only carries (number,
// string), so the string is the envelope; scripts/lib/rest.mjs parseCloudError() unwraps it.
'use strict';

const config = require('./config.js');
const guards = require('./guards.js');

const MASTER = { useMasterKey: true };
const PE = Parse.Error;

// ---------------------------------------------------------------------------------------------------------
// 1. Helpers
// ---------------------------------------------------------------------------------------------------------

function fail(code, message, extra, parseCode) {
  const payload = Object.assign({ code: code, message: message }, extra || {});
  throw new PE(parseCode || PE.VALIDATION_ERROR, JSON.stringify(payload));
}

function requireUser(request) {
  if (!request.user) {
    fail('UNAUTHENTICATED', 'Sign in before calling this function.', null, PE.INVALID_SESSION_TOKEN);
  }
  return request.user;
}

// 'YYYY-MM-DD' in UTC — the budget bucket. formatToParts, not toLocaleDateString('en-CA'): the en-CA format
// trick returns a different shape on some server ICU builds (observed in this workspace, 2026-10).
function utcDay(d) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d || new Date());
  const get = function (type) { return parts.find(function (p) { return p.type === type; }).value; };
  return get('year') + '-' + get('month') + '-' + get('day');
}

// Next UTC midnight, ISO — named in every budget refusal so the client knows when the bucket resets.
function nextUtcMidnightIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

function priceUsd(model, inputTokens, outputTokens) {
  const p = config.PRICES_USD_PER_MTOK[model];
  if (!p) fail('PRICE_MISSING', 'No price configured for model ' + model + ' (cloud/config.js).', { model: model }, PE.INTERNAL_SERVER_ERROR);
  return (inputTokens * p.input + outputTokens * p.output) / 1e6;
}

function estimateInputTokens(chars) {
  return Math.ceil(chars / config.CHARS_PER_TOKEN_ESTIMATE);
}

// Lab-only failure injection (amendments pt. 3): only when config.FAILPOINTS_ENABLED (never on a default
// deploy) a prompt may carry [[fail:budget-read]] / [[fail:usage-write]] / [[fail:usage-update]], making the
// corresponding storage step throw — that is how the fail-closed matrix rows are tested deterministically.
function failpoint(prompt, name) {
  if (config.FAILPOINTS_ENABLED && typeof prompt === 'string' && prompt.indexOf('[[fail:' + name + ']]') !== -1) {
    throw new Error('injected failpoint: ' + name);
  }
}

// Sum of estimatedCostUsd over today's rows (optionally one user's). Every recorded outcome counts: pending
// and unknown-output rows carry their conservative estimate, so unfinished or unparseable calls are never
// counted as free. Bounded paged reads; the brief's aggregate-pipeline wording is noted as the live-phase
// optimization in docs/notes/build-diary.md (the Postgres and MongoDB adapters disagree on aggregate key
// encoding, and a wrong pipeline here would turn into spurious fail-closed refusals).
async function sumSpentUsd(day, user) {
  let total = 0;
  let skip = 0;
  for (;;) {
    const q = new Parse.Query('LlmUsage');
    q.equalTo('day', day);
    if (user) q.equalTo('user', user);
    q.select('estimatedCostUsd');
    q.ascending('createdAt');
    q.limit(1000);
    q.skip(skip);
    const rows = await q.find(MASTER);
    for (const r of rows) total += r.get('estimatedCostUsd') || 0;
    if (rows.length < 1000) return total;
    skip += 1000;
  }
}

async function countPending(day, user) {
  const q = new Parse.Query('LlmUsage');
  q.equalTo('day', day);
  q.equalTo('user', user);
  q.equalTo('outcome', 'pending');
  return q.count(MASTER);
}

// ---------------------------------------------------------------------------------------------------------
// 2. Guard registration: the GUARDS table and the `define` wrapper
// ---------------------------------------------------------------------------------------------------------

const GUARDS = {
  askLlm: 'authenticated',
  setupSchema: 'setup',     // schema + CLPs without the master key leaving the dashboard (token-gated)
  testCreateUser: 'setup',  // signup is closed to the public (_User CLP); test users are created server-side
  testSeedUsage: 'setup',   // budget-edge fixtures for RUN-prefixed test users without real provider spend
  testInspect: 'setup',     // live test runs: master-key state read-backs
  testCleanup: 'setup',     // live test runs: delete ONLY what a suite run created (its run prefix, < 2 h old)
};

const registry = guards.createRegistry(GUARDS);

function define(name, spec) {
  registry.define(name, function (guard) {
    Parse.Cloud.define(name, async function (request) {
      if (guard === 'setup') {
        requireSetupEnabled(request);
        return spec.handler(request, {});
      }
      const user = requireUser(request);
      return spec.handler(request, { user: user });
    });
  });
}

// SETUP_ENABLED is the switch; the setup token is the server-checked credential on top of it (brief
// amendments: the gated pattern PLUS an admin setup token). Refusals do not reveal which of the two failed
// beyond their own code: the token comparison only runs while setup is enabled at all.
function requireSetupEnabled(request) {
  if (!config.SETUP_ENABLED) {
    fail('SETUP_DISABLED', 'Setup helpers are disabled (cloud/config.js: SETUP_ENABLED=false).', null, PE.OPERATION_FORBIDDEN);
  }
  const token = request.params && request.params.setupToken;
  if (typeof token !== 'string' || token !== config.SETUP_TOKEN) {
    fail('SETUP_TOKEN_INVALID', 'Missing or wrong setupToken (cloud/config.js SETUP_TOKEN).', null, PE.OPERATION_FORBIDDEN);
  }
}

// ---------------------------------------------------------------------------------------------------------
// 3. askLlm — the proxy
// ---------------------------------------------------------------------------------------------------------

define('askLlm', {
  handler: async function (request, ctx) {
    const user = ctx.user;
    const p = request.params || {};

    // --- 2. Validation. Client model/maxTokens/stream/system/temperature are deliberately IGNORED (T7/T8):
    // the server's body is the only body. The response names the model that actually ran.
    if (typeof p.prompt !== 'string' || p.prompt.length === 0) {
      fail('INVALID_ARGS', 'prompt must be a non-empty string.', { field: 'prompt' });
    }
    if (p.prompt.length > config.MAX_PROMPT_CHARS) {
      fail('INVALID_ARGS', 'prompt exceeds ' + config.MAX_PROMPT_CHARS + ' characters.', { field: 'prompt', chars: p.prompt.length, max: config.MAX_PROMPT_CHARS });
    }
    const prompt = p.prompt;
    const model = config.MODEL;
    const day = utcDay();
    const budgetUsd = user.get('isAdmin') ? config.ADMIN_DAILY_BUDGET_USD : config.DAILY_BUDGET_USD;

    // --- 3. Budget, global limit, concurrency — FAIL CLOSED on any storage error.
    let spentUsd; let globalUsd; let inFlight;
    try {
      failpoint(prompt, 'budget-read');
      spentUsd = await sumSpentUsd(day, user);
      globalUsd = await sumSpentUsd(day);
      inFlight = await countPending(day, user);
    } catch (e) {
      fail('BUDGET_UNAVAILABLE', 'Usage storage could not be read; refusing rather than spending unmetered.', { day: day }, PE.INTERNAL_SERVER_ERROR);
    }
    if (spentUsd >= budgetUsd) {
      fail('BUDGET_EXCEEDED', 'Daily budget reached. It resets at the UTC day boundary.', {
        budgetUsd: budgetUsd, spentUsd: round6(spentUsd), resetAt: nextUtcMidnightIso(),
      }, PE.OPERATION_FORBIDDEN);
    }
    if (globalUsd >= config.GLOBAL_DAILY_BUDGET_USD) {
      fail('GLOBAL_BUDGET_EXCEEDED', 'The global daily budget is exhausted. It resets at the UTC day boundary.', {
        globalBudgetUsd: config.GLOBAL_DAILY_BUDGET_USD, resetAt: nextUtcMidnightIso(),
      }, PE.OPERATION_FORBIDDEN);
    }
    if (inFlight >= config.MAX_CONCURRENT_PER_USER) {
      fail('CONCURRENCY_LIMIT', 'Too many calls in flight; wait for one to finish.', {
        maxConcurrent: config.MAX_CONCURRENT_PER_USER, inFlight: inFlight,
      }, PE.OPERATION_FORBIDDEN);
    }

    // --- 4. Record (pending), BEFORE the provider call — fail closed if it cannot be written. The row
    // carries the conservative estimate (input from chars, output priced at the cap) until real usage lands.
    const estIn = estimateInputTokens(prompt.length);
    const row = new Parse.Object('LlmUsage');
    row.set('user', user);
    row.set('day', day);
    row.set('model', model);
    row.set('inputTokens', estIn);
    row.set('outputTokens', config.MAX_OUTPUT_TOKENS);
    row.set('estimatedCostUsd', priceUsd(model, estIn, config.MAX_OUTPUT_TOKENS));
    row.set('outcome', 'pending');
    row.set('requestChars', prompt.length);
    try {
      failpoint(prompt, 'usage-write');
      await row.save(null, MASTER);
    } catch (e) {
      fail('USAGE_WRITE_FAILED', 'Usage could not be recorded; refusing rather than spending unmetered.', { day: day }, PE.INTERNAL_SERVER_ERROR);
    }

    // Finalize helper: never under-record. On unknown output the conservative cap estimate stays.
    async function finalize(outcome, usage) {
      row.set('outcome', outcome);
      if (usage) {
        row.set('inputTokens', usage.input_tokens);
        row.set('outputTokens', usage.output_tokens);
        row.set('estimatedCostUsd', priceUsd(model, usage.input_tokens, usage.output_tokens));
      }
      await row.save(null, MASTER);
    }

    // --- 5. Provider call. The key is attached HERE and nowhere else. 429/5xx/timeout/malformed are mapped
    // to our envelope — the raw provider body never reaches the client (it could differ per provider; the
    // envelope is ours).
    // The abort timer covers the WHOLE exchange — headers AND body. A provider that sends headers at once but
    // the body late (slow-body) is a timeout too, so clearTimeout only runs after the body is consumed.
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, config.PROVIDER_TIMEOUT_MS);
    const timedOut = async function () {
      clearTimeout(timer);
      await safely(function () { return finalize('timeout'); });
      fail('PROVIDER_TIMEOUT', 'The provider did not answer within ' + config.PROVIDER_TIMEOUT_MS + ' ms.', {
        timeoutMs: config.PROVIDER_TIMEOUT_MS,
      }, PE.SCRIPT_FAILED);
    };
    let res;
    try {
      res = await fetch(config.PROVIDER_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.LLM_API_KEY,
          'anthropic-version': config.ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: model,
          max_tokens: config.MAX_OUTPUT_TOKENS,
          temperature: config.TEMPERATURE,
          system: config.SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (e) {
      await timedOut();
    }

    if (res.status === 429) {
      clearTimeout(timer);
      // Decision 5: a call that reached the provider counts; no output was generated, so input estimate only.
      await safely(function () { return finalize('provider_error', { input_tokens: estIn, output_tokens: 0 }); });
      const retryAfter = res.headers.get('retry-after');
      fail('PROVIDER_RATE_LIMITED', 'The provider is rate-limiting; try again shortly.',
        retryAfter ? { retryAfterSeconds: Number(retryAfter) } : null, PE.SCRIPT_FAILED);
    }
    if (res.status >= 500) {
      clearTimeout(timer);
      await safely(function () { return finalize('provider_error', { input_tokens: estIn, output_tokens: 0 }); });
      fail('PROVIDER_ERROR', 'The provider answered HTTP ' + res.status + '.', { status: res.status }, PE.SCRIPT_FAILED);
    }
    let json = null; let text = null; let usage = null;
    try {
      json = await res.json(); // still under the abort timer: a slow body is a timeout, not a hang
      if (res.status === 200 && json && Array.isArray(json.content) && json.content[0] && typeof json.content[0].text === 'string'
        && json.usage && Number.isFinite(json.usage.input_tokens) && Number.isFinite(json.usage.output_tokens)) {
        text = json.content[0].text;
        usage = json.usage;
      }
    } catch (e) {
      if (controller.signal.aborted) await timedOut();
      /* malformed JSON → handled below */
    }
    clearTimeout(timer);
    if (text === null) {
      // Malformed or unexpected body: output size unknown → the conservative cap estimate stays on the row.
      await safely(function () { return finalize('provider_error'); });
      fail('PROVIDER_BAD_RESPONSE', 'The provider answered with an unexpected body (HTTP ' + res.status + ').', { status: res.status }, PE.SCRIPT_FAILED);
    }

    // --- 6. Finalize with the provider-reported usage. If this update fails the pending row (conservative
    // estimate) stays — spend is never under-recorded — and the client gets an error, not the text.
    try {
      failpoint(prompt, 'usage-update');
      await finalize('ok', usage);
    } catch (e) {
      fail('USAGE_RECORD_FAILED', 'The answer arrived but usage could not be recorded; the call was charged conservatively.', { day: day }, PE.INTERNAL_SERVER_ERROR);
    }

    const costUsd = priceUsd(model, usage.input_tokens, usage.output_tokens);
    return {
      text: text,
      model: model,
      usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
      estimatedCostUsd: round6(costUsd),
      budget: {
        dailyBudgetUsd: budgetUsd,
        spentTodayUsd: round6(spentUsd + costUsd),
        resetAt: nextUtcMidnightIso(),
      },
    };
  },
});

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

async function safely(fn) {
  try { await fn(); } catch (e) { console.log('llm-proxy-lab: usage finalize failed: ' + (e && e.message)); }
}

// ---------------------------------------------------------------------------------------------------------
// 4. Setup helpers (behind SETUP_ENABLED + SETUP_TOKEN)
// ---------------------------------------------------------------------------------------------------------

async function fetchSchema(className) {
  try {
    return await new Parse.Schema(className).get();
  } catch (e) {
    if (e && e.code === PE.INVALID_CLASS_NAME) return null; // 103: class does not exist
    throw e;
  }
}

function addFieldsTo(schema, fields) {
  Object.keys(fields).forEach(function (name) {
    const spec = fields[name];
    if (spec.type === 'Pointer') schema.addPointer(name, spec.targetClass);
    else schema.addField(name, spec.type);
  });
}

// setupSchema({setupToken, allowRerun?}) → {classes:[…]}. Creates LlmUsage with fields, CLP and indexes (or
// brings it up to date), closes PUBLIC SIGNUP by making _User create master-only (users are created
// server-side, matching the house pattern), and adds _User.isAdmin. Tripwire: refuses once LlmUsage holds
// rows unless {allowRerun:true} — a stray call on an app with data should be noisy, not silent.
define('setupSchema', {
  handler: async function (request) {
    const p = request.params || {};
    const usageCount = (await fetchSchema('LlmUsage')) ? await new Parse.Query('LlmUsage').count(MASTER) : 0;
    if (usageCount > 0 && p.allowRerun !== true) {
      fail('SETUP_LOCKED', 'LlmUsage already holds ' + usageCount + ' rows; pass {allowRerun:true} to re-apply the schema.', { usageCount: usageCount });
    }
    const classes = [];
    for (const def of config.SCHEMA) {
      const have = await fetchSchema(def.className);
      const schema = new Parse.Schema(def.className);
      schema.setCLP(def.classLevelPermissions);
      if (!have) {
        addFieldsTo(schema, def.fields);
        Object.keys(def.indexes || {}).forEach(function (name) { schema.addIndex(name, def.indexes[name]); });
        await schema.save();
        classes.push({ className: def.className, action: 'created', newFields: Object.keys(def.fields) });
        continue;
      }
      const newFields = {};
      Object.keys(def.fields).forEach(function (name) { if (!have.fields || !have.fields[name]) newFields[name] = def.fields[name]; });
      const haveIdx = have.indexes || {};
      const newIndexes = Object.keys(def.indexes || {}).filter(function (name) { return !haveIdx[name]; });
      addFieldsTo(schema, newFields);
      newIndexes.forEach(function (name) { schema.addIndex(name, def.indexes[name]); });
      await schema.update();
      classes.push({ className: def.className, action: 'updated', newFields: Object.keys(newFields) });
    }
    // _User: no public signup (create master-only), no client listing, self-update only via ACL; isAdmin is a
    // server-set field (the hook below refuses client writes to it even where an update is otherwise allowed).
    const userSchema = new Parse.Schema('_User');
    const haveUser = await fetchSchema('_User');
    if (!haveUser || !haveUser.fields || !haveUser.fields.isAdmin) userSchema.addField('isAdmin', 'Boolean');
    userSchema.setCLP({
      find: {}, get: {}, count: {},
      create: {},                                 // public sign-up disabled: users are created server-side
      update: { requiresAuthentication: true },   // a user updates themself (ACL scopes it to the own row)
      delete: {}, addField: {},
    });
    await userSchema.update();
    classes.push({ className: '_User', action: 'updated', newFields: (!haveUser || !haveUser.fields || !haveUser.fields.isAdmin) ? ['isAdmin'] : [] });
    return { classes: classes, usageCount: usageCount };
  },
});

// testCreateUser({setupToken, username, password, isAdmin?}) → {objectId, username}. Signup is closed to the
// public, so the suites create their personas through this helper. The run-prefix shape is enforced so the
// helper can only ever create disposable test users (and testCleanup can only ever sweep those).
define('testCreateUser', {
  handler: async function (request) {
    const p = request.params || {};
    if (typeof p.username !== 'string' || !/^zz[a-z0-9]/.test(p.username) || p.username.length > 80) {
      fail('INVALID_ARGS', 'username must start with the zz run prefix (disposable test users only).', { field: 'username' });
    }
    if (typeof p.password !== 'string' || p.password.length < 8) {
      fail('INVALID_ARGS', 'password must be a string of at least 8 characters.', { field: 'password' });
    }
    const user = new Parse.User();
    user.set('username', p.username);
    user.set('password', p.password);
    user.set('email', p.username + '@example.test');
    if (p.isAdmin === true) user.set('isAdmin', true);
    await user.save(null, MASTER);
    return { objectId: user.id, username: p.username, isAdmin: p.isAdmin === true };
  },
});

// testSeedUsage({setupToken, userId, costUsd, count?, outcome?}) → {created}. Seeds today's LlmUsage rows for
// ONE disposable test user so budget-edge rows (T5/T6, T14, oversized-final) do not need real spend to set
// up. Only works on RUN-prefixed usernames — the same containment as testCreateUser/testCleanup.
define('testSeedUsage', {
  handler: async function (request) {
    const p = request.params || {};
    const q = new Parse.Query('_User');
    q.equalTo('objectId', p.userId);
    const user = await q.first(MASTER);
    if (!user || !/^zz[a-z0-9]/.test(user.get('username') || '')) {
      fail('INVALID_ARGS', 'userId must name an existing zz-prefixed test user.', { field: 'userId' });
    }
    if (!(typeof p.costUsd === 'number' && p.costUsd >= 0)) fail('INVALID_ARGS', 'costUsd must be a non-negative number.', { field: 'costUsd' });
    const count = p.count === undefined ? 1 : p.count;
    if (!Number.isInteger(count) || count < 1 || count > 100) fail('INVALID_ARGS', 'count must be an integer in 1..100.', { field: 'count' });
    const day = utcDay();
    const rows = [];
    for (let i = 0; i < count; i++) {
      const row = new Parse.Object('LlmUsage');
      row.set('user', user);
      row.set('day', day);
      row.set('model', config.MODEL);
      row.set('inputTokens', 0);
      row.set('outputTokens', 0);
      row.set('estimatedCostUsd', p.costUsd);
      row.set('outcome', p.outcome || 'ok');
      row.set('requestChars', 0);
      rows.push(row);
    }
    await Parse.Object.saveAll(rows, MASTER);
    return { created: count, day: day, costUsdEach: p.costUsd };
  },
});

const INSPECT_CLASSES = config.SCHEMA.map(function (d) { return d.className; }).concat(['_User']);

function decodeParam(value) {
  if (value instanceof Parse.Object || value instanceof Date) return value;
  return Parse._decode(null, value);
}

function queryFromWhere(className, where) {
  const q = new Parse.Query(className);
  Object.keys(where).forEach(function (key) {
    const value = decodeParam(where[key]);
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Parse.Object) && !(value instanceof Date)) {
      fail('INVALID_ARGS', 'where.' + key + ' must be a plain value or a REST-encoded pointer/date (no operators)', { field: 'where.' + key });
    }
    q.equalTo(key, value);
  });
  return q;
}

// testInspect({setupToken, className, where?, limit?, count?}) → {results:[toJSON…]} or {count}. Master-rights
// read of one whitelisted class, equality-where only — the live suite's state assertions run through this so
// the master key never leaves the dashboard.
define('testInspect', {
  handler: async function (request) {
    const p = request.params || {};
    if (INSPECT_CLASSES.indexOf(p.className) === -1) {
      fail('INVALID_ARGS', 'className must be one of ' + INSPECT_CLASSES.join(', '), { field: 'className' });
    }
    const where = p.where === undefined ? {} : p.where;
    if (!where || typeof where !== 'object' || Array.isArray(where)) fail('INVALID_ARGS', 'where must be an object', { field: 'where' });
    const q = queryFromWhere(p.className, where);
    if (p.count === true) return { className: p.className, count: await q.count(MASTER) };
    const limit = p.limit === undefined ? 100 : p.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('INVALID_ARGS', 'limit must be an integer in 1..1000', { field: 'limit' });
    q.limit(limit);
    q.ascending('createdAt');
    const rows = await q.find(MASTER);
    return { className: p.className, results: rows.map(function (r) { return r.toJSON(); }) };
  },
});

// testCleanup({setupToken, runPrefix}) → {users, sessions, usageRows}. Deletes ONLY what one suite run
// created: every _User whose username starts with the prefix AND is < 2 hours old (plus its sessions and its
// LlmUsage rows). The prefix shape is enforced (zz + ≥8 base36 chars, as test/helpers.mjs generates) so a
// stray call can never sweep real users. Parallel runs have distinct prefixes and never touch each other.
define('testCleanup', {
  handler: async function (request) {
    const p = request.params || {};
    if (typeof p.runPrefix !== 'string' || !/^zz[a-z0-9]{8,32}$/.test(p.runPrefix)) {
      fail('INVALID_ARGS', 'runPrefix must match ^zz[a-z0-9]{8,32}$ (the suite run prefix)', { field: 'runPrefix' });
    }
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const counts = { users: 0, sessions: 0, usageRows: 0 };
    for (;;) {
      const uq = new Parse.Query('_User');
      uq.startsWith('username', p.runPrefix);
      uq.greaterThan('createdAt', cutoff);
      uq.limit(100);
      const users = await uq.find(MASTER);
      if (!users.length) break;
      const sq = new Parse.Query('_Session');
      sq.containedIn('user', users);
      sq.limit(1000);
      const sessions = await sq.find(MASTER);
      if (sessions.length) await Parse.Object.destroyAll(sessions, MASTER);
      counts.sessions += sessions.length;
      for (;;) {
        const rq = new Parse.Query('LlmUsage');
        rq.containedIn('user', users);
        rq.limit(1000);
        const rows = await rq.find(MASTER);
        if (!rows.length) break;
        await Parse.Object.destroyAll(rows, MASTER);
        counts.usageRows += rows.length;
      }
      await Parse.Object.destroyAll(users, MASTER);
      counts.users += users.length;
    }
    return counts;
  },
});

registry.assertAllRegistered();

// askLlm relies on global fetch (Node 18+; Back4app Cloud Code runs Node 19). Log — never throw — when it is
// missing, so a deploy on an older runtime degrades that one function instead of the whole app.
if (typeof fetch !== 'function') {
  console.log('llm-proxy-lab warning: global fetch is not available in this Cloud Code runtime — askLlm will fail.');
}

// ---------------------------------------------------------------------------------------------------------
// 5. Hooks: the second guard. They run for EVERY write, master key included, so a future function that forgot
// a check still cannot corrupt the usage ledger, and no client ever writes it (T9: forged budget reset).
// ---------------------------------------------------------------------------------------------------------

function hookFail(code, message, extra) {
  throw new PE(PE.OPERATION_FORBIDDEN, JSON.stringify(Object.assign({ code: code, message: message }, extra || {})));
}

Parse.Cloud.beforeSave('LlmUsage', function (request) {
  if (!request.master) hookFail('CLOUD_CODE_ONLY', 'LlmUsage rows are written by Cloud Code only.');
  const obj = request.object;
  if (!obj.get('user')) hookFail('INVALID_ROW', 'LlmUsage rows must carry a user pointer.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(obj.get('day') || '')) hookFail('INVALID_ROW', 'LlmUsage.day must be YYYY-MM-DD (UTC).');
  if (['pending', 'ok', 'provider_error', 'timeout', 'record_failed'].indexOf(obj.get('outcome')) === -1) {
    hookFail('INVALID_ROW', 'LlmUsage.outcome must be pending|ok|provider_error|timeout|record_failed.');
  }
  if (!(obj.get('estimatedCostUsd') >= 0)) hookFail('INVALID_ROW', 'LlmUsage.estimatedCostUsd must be a non-negative number.');
  obj.setACL(new Parse.ACL()); // no client reads usage rows, ever (the CLP already says so; this is the second guard)
});

Parse.Cloud.beforeDelete('LlmUsage', function (request) {
  if (!request.master) hookFail('CLOUD_CODE_ONLY', 'LlmUsage rows are deleted by Cloud Code only.');
});

// isAdmin is a server-set field: a client holding a session may update their own _User row, but never this
// field (it selects the LARGER budget — decision 4: admins get a bigger budget, not an unlimited one).
Parse.Cloud.beforeSave(Parse.User, function (request) {
  if (!request.master && request.object.dirty('isAdmin')) {
    hookFail('FIELD_PROTECTED', '_User.isAdmin is set server-side only.', { field: 'isAdmin' });
  }
});
