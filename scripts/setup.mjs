// File: scripts/setup.mjs · Node 22+ ESM
// Creates or updates the LlmUsage class (fields, master-only CLP, indexes) and the _User policy (public
// sign-up disabled: create master-only; isAdmin field added). Idempotent. Two paths, same definition:
//   - MASTER_KEY available (the LOCAL dev server, whose fixed keys include one): schema REST API directly.
//   - no MASTER_KEY (Back4app, where the key stays in the dashboard): calls the Cloud function setupSchema
//     with the REST key + SETUP_TOKEN; Cloud Code must be deployed first and config.SETUP_ENABLED still true.
// Usage: npm run setup [-- --local | --live] [-- --allow-rerun]
import { createRequire } from 'node:module';
import { target, args, ensureCloudConfig } from './lib/env.mjs';
import { makeClient } from './lib/rest.mjs';

ensureCloudConfig();
const config = createRequire(import.meta.url)('../cloud/config.js');

// The CLI part only runs when invoked directly (the tests import applySchema without side effects).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const a = args();
  const env = target(a);
  const api = makeClient(env, { retry: true });
  let failed = false;
  if (env.MASTER_KEY) {
    await applySchema(env);
    for (const def of config.SCHEMA) {
      const r = await api.request('GET', `/schemas/${def.className}`, { master: true });
      console.log(`schema ${def.className}: ok (${Object.keys((r.json && r.json.fields) || {}).length} fields, indexes: ${Object.keys((r.json && r.json.indexes) || {}).join(', ') || 'none'})`);
    }
    console.log('schema _User: sign-up closed (create master-only), isAdmin added');
  } else {
    console.log(`no MASTER_KEY — applying the schema through the Cloud function setupSchema at ${env.SERVER_URL}`);
    const r = await api.call('setupSchema', { setupToken: env.SETUP_TOKEN, allowRerun: !!a['allow-rerun'] });
    if (!r.ok) {
      failed = true;
      console.error(`setupSchema failed: HTTP ${r.status} ${JSON.stringify(r.error)}`);
      if (r.error.code === 'SETUP_DISABLED') console.error('cloud/config.js has SETUP_ENABLED=false on that backend.');
      if (r.error.code === 'SETUP_TOKEN_INVALID') console.error('SETUP_TOKEN in .env does not match the deployed cloud/config.js.');
    } else {
      for (const c of r.result.classes) console.log(`schema ${c.className}: ${c.action} (${c.newFields.length} new field(s))`);
    }
  }

  // Smoke-test that Cloud Code is live: an anonymous call to askLlm must be rejected by the function itself
  // (UNAUTHENTICATED), not with "Invalid function" (141). Prove deploys with a request, never with a dialog
  // (the Cloud Code deploy quirk — see README).
  const probe = await api.call('askLlm', {});
  if (!probe.ok && probe.error.code === 'UNAUTHENTICATED') console.log('cloud code: live (askLlm rejects anonymous calls)');
  else if (!probe.ok && /Invalid function/.test(probe.error.message || '')) { failed = true; console.error('cloud code: NOT deployed (Invalid function "askLlm") — upload cloud/main.js, cloud/config.js and cloud/guards.js, confirm the "Files pending deploy" badge, Deploy, and verify with this probe again.'); }
  else console.log(`cloud code: unexpected probe result ${JSON.stringify({ status: probe.status, error: probe.error })}`);
  process.exit(failed ? 1 : 0);
}

export async function applySchema(targetEnv) {
  const client = makeClient(targetEnv, { retry: true });
  for (const def of config.SCHEMA) {
    const existing = await client.request('GET', `/schemas/${def.className}`, { master: true });
    if (existing.status === 200) {
      const have = existing.json;
      const newFields = {};
      for (const [name, spec] of Object.entries(def.fields)) if (!have.fields || !have.fields[name]) newFields[name] = spec;
      const haveIdx = have.indexes || {};
      const newIndexes = {};
      for (const [name, key] of Object.entries(def.indexes || {})) if (!haveIdx[name]) newIndexes[name] = key;
      const body = { className: def.className, fields: newFields, classLevelPermissions: def.classLevelPermissions };
      if (Object.keys(newIndexes).length) body.indexes = newIndexes;
      const r = await client.request('PUT', `/schemas/${def.className}`, { master: true, body });
      if (r.status !== 200) throw new Error(`schema ${def.className}: update failed ${r.status} ${JSON.stringify(r.json)}`);
    } else if (existing.status === 400 && existing.json && existing.json.code === 103) {
      const body = { className: def.className, fields: def.fields, classLevelPermissions: def.classLevelPermissions, indexes: def.indexes };
      const r = await client.request('POST', `/schemas/${def.className}`, { master: true, body });
      if (r.status !== 200 && r.status !== 201) throw new Error(`schema ${def.className}: create failed ${r.status} ${JSON.stringify(r.json)}`);
    } else {
      throw new Error(`schema ${def.className}: GET failed ${existing.status} ${JSON.stringify(existing.json)}`);
    }
  }
  // _User: public sign-up disabled (create master-only), reads master-only, self-update via session + ACL.
  const haveUser = await client.request('GET', '/schemas/_User', { master: true });
  const userBody = {
    className: '_User',
    classLevelPermissions: {
      find: {}, get: {}, count: {},
      create: {},
      update: { requiresAuthentication: true },
      delete: {}, addField: {},
    },
  };
  if (haveUser.status !== 200 || !haveUser.json.fields || !haveUser.json.fields.isAdmin) {
    userBody.fields = { isAdmin: { type: 'Boolean' } };
  }
  const u = await client.request('PUT', '/schemas/_User', { master: true, body: userBody });
  if (u.status !== 200) throw new Error(`schema _User: update failed ${u.status} ${JSON.stringify(u.json)}`);
}
