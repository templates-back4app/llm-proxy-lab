// File: public/app.js · the ACME notes client, raw fetch, no SDK. scripts/build-client.mjs turns this into
// dist/<variant>/app.bundle.js (+ source map). The client holds ONLY the App ID, the JS key and (after sign-in)
// a session token — in the default build the string __LLM_CALL__ below becomes a call to the Cloud function
// askLlm, and no provider key exists anywhere in the shipped bytes (tests T2/T11 grep every byte to prove it).
//
// The DEMO_KEY_IN_CLIENT build (off by default, never deployed) replaces __LLM_CALL__ with a DIRECT provider
// call and bakes the synthetic canary key into this bundle — the "before" picture test T10 extracts.
/* global LAB_CONFIG */
(function () {
  'use strict';
  var session = null;

  function $(id) { return document.getElementById(id); }

  function parseHeaders() {
    return {
      'Content-Type': 'application/json',
      'X-Parse-Application-Id': LAB_CONFIG.APP_ID,
      'X-Parse-Javascript-Key': LAB_CONFIG.JS_KEY,
    };
  }

  $('login').addEventListener('click', function () {
    fetch(LAB_CONFIG.SERVER_URL + '/login', {
      method: 'POST',
      headers: parseHeaders(),
      body: JSON.stringify({ username: $('username').value, password: $('password').value }),
    }).then(function (r) { return r.json(); }).then(function (json) {
      if (!json.sessionToken) { $('answer').textContent = 'login failed: ' + JSON.stringify(json); return; }
      session = json.sessionToken;
      $('auth').hidden = true;
      $('ask').hidden = false;
    });
  });

  $('send').addEventListener('click', function () {
    $('answer').textContent = '…';
    __LLM_CALL__($('prompt').value).then(function (out) {
      $('answer').textContent = out.text;
      if (out.budget) $('budget').textContent = 'spent today: $' + out.budget.spentTodayUsd + ' of $' + out.budget.dailyBudgetUsd + ' (resets ' + out.budget.resetAt + ')';
    }).catch(function (e) {
      $('answer').textContent = 'error: ' + (e && e.message ? e.message : String(e));
    });
  });

  // Default build: the key lives on the server; the client sends the prompt and a session token to askLlm.
  function askViaCloudFunction(prompt) {
    var h = parseHeaders();
    h['X-Parse-Session-Token'] = session;
    return fetch(LAB_CONFIG.SERVER_URL + '/functions/askLlm', {
      method: 'POST', headers: h, body: JSON.stringify({ prompt: prompt }),
    }).then(function (r) { return r.json(); }).then(function (json) {
      if (!json.result) throw new Error(json.error || 'askLlm failed');
      return json.result;
    });
  }

  // DEMO build only ("before" picture): the key ships in this bundle and the browser calls the provider
  // directly — which is exactly why it must never happen with a real key. The canary below is synthetic.
  function askProviderDirectly(prompt) {
    return fetch(LAB_CONFIG.PROVIDER_URL + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': '__DEMO_PROVIDER_KEY__',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: '__DEMO_MODEL__', max_tokens: 256, messages: [{ role: 'user', content: prompt }] }),
    }).then(function (r) { return r.json(); }).then(function (json) {
      if (!json.content) throw new Error('provider error: ' + JSON.stringify(json));
      return { text: json.content[0].text, budget: null };
    });
  }

  void askViaCloudFunction; void askProviderDirectly; // the build keeps exactly one of them wired in
})();
