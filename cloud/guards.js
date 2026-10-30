// File: cloud/guards.js · CommonJS · no Parse dependency (so the test suite can load it directly).
//
// Same mechanical backstop as the sibling repos (tenant-lab): every Cloud function registered in main.js must
// be listed in the GUARDS table there, stating which guard wraps it, and the server REFUSES TO START (throws
// while loading cloud/main.js) if a function is registered without an entry, with an entry naming an unknown
// guard, twice, or if an entry in the table never gets registered. A forgotten guard therefore fails the
// deploy, not the user whose budget it would have skipped.
'use strict';

// Guard names the registry accepts. What each one means is enforced in cloud/main.js, where `define` wraps
// the handler with the corresponding check before Parse ever sees it:
//   'authenticated'  requireUser: any signed-in user (askLlm — the budget check comes after, per user).
//   'setup'          requireSetupEnabled: cloud/config.js SETUP_ENABLED must be true AND params.setupToken
//                    must equal config.SETUP_TOKEN (server-checked admin setup token). Unauthenticated by
//                    design — the token is the credential.
const GUARD_NAMES = ['authenticated', 'setup'];

/**
 * createRegistry(guards) → { define, assertAllRegistered }
 *   guards: { functionName: guardName } — the GUARDS table from main.js.
 *   define(name, register): refuses unlisted names, unknown guards and double registration, and otherwise
 *     calls register(guardName).
 *   assertAllRegistered(): throws if any table entry was never registered (e.g. a typo in a define call).
 */
function createRegistry(guards) {
  const registered = {};
  Object.keys(guards).forEach(function (name) {
    if (GUARD_NAMES.indexOf(guards[name]) === -1) {
      throw new Error('GUARDS["' + name + '"] names unknown guard "' + guards[name] + '" (known: ' + GUARD_NAMES.join(', ') + ')');
    }
  });
  return {
    define: function (name, register) {
      const guard = guards[name];
      if (!guard) {
        throw new Error('Cloud function "' + name + '" is not listed in the GUARDS table (cloud/main.js). ' +
          'Every function must declare its guard; the server does not start without it.');
      }
      if (registered[name]) throw new Error('Cloud function "' + name + '" registered twice.');
      registered[name] = guard;
      register(guard);
    },
    assertAllRegistered: function () {
      const missing = Object.keys(guards).filter(function (name) { return !registered[name]; });
      if (missing.length) {
        throw new Error('GUARDS lists function(s) that were never registered: ' + missing.join(', ') +
          ' — remove the stale entries or add the define() calls.');
      }
    },
  };
}

module.exports = { createRegistry: createRegistry, GUARD_NAMES: GUARD_NAMES };
