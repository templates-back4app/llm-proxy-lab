// File: test/guards.test.mjs · unit tests for cloud/guards.js (no Parse, no server): the registry that makes
// a forgotten guard fail the DEPLOY instead of the budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createRegistry, GUARD_NAMES } = createRequire(import.meta.url)('../cloud/guards.js');

test('guard names are the two the lab uses', () => {
  assert.deepEqual(GUARD_NAMES, ['authenticated', 'setup']);
});

test('an unknown guard name in the table throws at load', () => {
  assert.throws(() => createRegistry({ askLlm: 'wide-open' }), /unknown guard "wide-open"/);
});

test('registering a function missing from the table throws', () => {
  const r = createRegistry({ askLlm: 'authenticated' });
  assert.throws(() => r.define('sneakyFn', () => {}), /not listed in the GUARDS table/);
});

test('double registration throws', () => {
  const r = createRegistry({ askLlm: 'authenticated' });
  r.define('askLlm', () => {});
  assert.throws(() => r.define('askLlm', () => {}), /registered twice/);
});

test('a table entry that is never registered fails assertAllRegistered', () => {
  const r = createRegistry({ askLlm: 'authenticated', forgotten: 'setup' });
  r.define('askLlm', () => {});
  assert.throws(() => r.assertAllRegistered(), /never registered: forgotten/);
});

test('the happy path hands the guard name to the registrar', () => {
  const r = createRegistry({ askLlm: 'authenticated', setupSchema: 'setup' });
  const seen = {};
  r.define('askLlm', (g) => { seen.askLlm = g; });
  r.define('setupSchema', (g) => { seen.setupSchema = g; });
  r.assertAllRegistered();
  assert.deepEqual(seen, { askLlm: 'authenticated', setupSchema: 'setup' });
});
