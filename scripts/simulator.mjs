// File: scripts/simulator.mjs · Node 22+ ESM · the DETERMINISTIC PROVIDER SIMULATOR (brief amendments pt. 3).
//
// A local HTTP server that speaks the Claude Messages API shape (POST /v1/messages, non-streaming AND SSE
// streaming) with fully deterministic behavior, so every failure row of the matrix — 429s, timeouts, slow and
// malformed bodies — reproduces byte-for-byte without touching the real provider. Phase A runs EVERYTHING
// against it; the live phase validates representative behaviors against the real provider with a small
// counted set of calls (coordinator-run).
//
//   npm run simulator     → http://localhost:1344 (fixed lab port; the parse-server dev port is 1343)
//
// The suites start their own instance on a free port and point cloud/config.js at it via LLM_PROVIDER_URL.
//
// Determinism contract:
//   input_tokens  = ceil((system.length + prompt.length) / 4)
//   output_tokens = min(max_tokens, directive [[sim:out:N]], default 16)
//   text          = 'w0 w1 w2 …' (one deterministic word per output token, joined by spaces)
//
// Directives — the FIRST [[sim:…]] markers found in the user prompt steer the response (anywhere in the
// prompt; the proxy forwards prompts verbatim, so tests put them in the prompt they send):
//   [[sim:429]]          HTTP 429, provider-shaped rate_limit_error body, retry-after: 7
//   [[sim:500]]          HTTP 500, provider-shaped api_error body
//   [[sim:sleep:MS]]     wait MS ms before sending ANYTHING (exercises the caller's timeout)
//   [[sim:slow-body:MS]] send headers immediately, the body only after MS ms (slow body ≠ no answer)
//   [[sim:malformed]]    HTTP 200 with a truncated JSON body
//   [[sim:out:N]]        output_tokens = min(N, max_tokens)
//   [[sim:tps:N]]        generation speed, tokens/second: non-streaming delays the whole body by
//                        output_tokens/N seconds; streaming paces one content_block_delta per token at N/s
//                        (that asymmetry is exactly what time-to-first-usable-output vs time-to-full-
//                        completion measures)
//
// Lab introspection (never part of the provider surface):
//   GET  /healthz        {ok:true}
//   GET  /__last-request the last request's body and auth-relevant headers — how T8 proves the server-side
//                        body is the only body and T2-class checks prove which key was attached
//   GET  /__stats        request counters (how many provider calls a suite run makes — feeds the request
//                        budget in docs/notes/build-diary.md)
//   POST /__reset        zero the counters
import http from 'node:http';
import { SIM_PORT } from './lib/env.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function directive(prompt, name) {
  const m = String(prompt).match(new RegExp('\\[\\[sim:' + name + '(?::(\\d+))?\\]\\]'));
  return m ? (m[1] === undefined ? true : Number(m[1])) : null;
}

function deterministicText(outputTokens) {
  return Array.from({ length: outputTokens }, (_, i) => 'w' + i).join(' ');
}

export async function startSimulator({ port = 0, quiet = true } = {}) {
  const stats = { requests: 0, messages: 0, byStatus: {}, streamed: 0 };
  let lastRequest = null;

  const server = http.createServer(async (req, res) => {
    stats.requests++;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');

    const send = (status, body, headers) => {
      stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true });
    if (req.method === 'GET' && req.url === '/__stats') return send(200, stats);
    if (req.method === 'GET' && req.url === '/__last-request') return send(200, lastRequest || {});
    if (req.method === 'POST' && req.url === '/__reset') {
      stats.messages = 0; stats.streamed = 0; stats.byStatus = {}; stats.requests = 1; lastRequest = null;
      return send(200, { ok: true });
    }
    if (req.method !== 'POST' || req.url !== '/v1/messages') return send(404, { type: 'error', error: { type: 'not_found_error', message: 'Not found' } });

    stats.messages++;
    let body;
    try { body = JSON.parse(raw); } catch { return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'body is not JSON' } }); }
    lastRequest = {
      body,
      headers: {
        'x-api-key': req.headers['x-api-key'] || null,
        'anthropic-version': req.headers['anthropic-version'] || null,
        'content-type': req.headers['content-type'] || null,
      },
    };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userMsg = messages.filter((m) => m && m.role === 'user').pop();
    const prompt = userMsg && typeof userMsg.content === 'string' ? userMsg.content : '';
    const system = typeof body.system === 'string' ? body.system : '';
    const maxTokens = Number.isFinite(body.max_tokens) ? body.max_tokens : 0;

    if (!req.headers['x-api-key']) {
      return send(401, { type: 'error', error: { type: 'authentication_error', message: 'x-api-key header is required' } });
    }
    if (!body.model || !maxTokens || !prompt) {
      return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'model, max_tokens and a user message are required' } });
    }

    const sleepMs = directive(prompt, 'sleep');
    if (sleepMs) await sleep(sleepMs);
    if (directive(prompt, '429')) {
      return send(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Simulated rate limit' } }, { 'retry-after': '7' });
    }
    if (directive(prompt, '500')) {
      return send(500, { type: 'error', error: { type: 'api_error', message: 'Simulated internal error' } });
    }
    if (directive(prompt, 'malformed')) {
      return send(200, '{"content":[{"type":"text","te'); // truncated on purpose
    }

    const inputTokens = Math.ceil((system.length + prompt.length) / 4);
    const outDirective = directive(prompt, 'out');
    const outputTokens = Math.max(1, Math.min(maxTokens, outDirective === null ? 16 : outDirective));
    const tps = directive(prompt, 'tps'); // tokens per second, null = instant
    const text = deterministicText(outputTokens);
    const id = 'msg_sim_' + stats.messages;
    const usage = { input_tokens: inputTokens, output_tokens: outputTokens };

    if (body.stream === true) {
      // Anthropic-shaped SSE: message_start → content_block_start → one content_block_delta per token
      // (paced at tps when given) → content_block_stop → message_delta (usage) → message_stop.
      stats.streamed++;
      stats.byStatus[200] = (stats.byStatus[200] || 0) + 1;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      ev('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: inputTokens, output_tokens: 0 } } });
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      const words = text.split(' ');
      for (let i = 0; i < words.length; i++) {
        if (tps) await sleep(1000 / tps);
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: (i ? ' ' : '') + words[i] } });
      }
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } });
      ev('message_stop', { type: 'message_stop' });
      return res.end();
    }

    // Non-streaming: the whole generation time passes BEFORE the body is sent (tps), or a fixed slow-body
    // delay — then one JSON message.
    if (tps) await sleep((outputTokens / tps) * 1000);
    const slowBody = directive(prompt, 'slow-body');
    if (slowBody) {
      stats.byStatus[200] = (stats.byStatus[200] || 0) + 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      await sleep(slowBody);
      return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage }));
    }
    return send(200, { id, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}`;
  if (!quiet) console.log(`provider simulator on ${url} (POST /v1/messages, GET /healthz, /__last-request, /__stats)`);
  return {
    url, port: actualPort, stats,
    close: () => new Promise((r) => server.close(r)),
  };
}

if (process.argv[1] && process.argv[1].endsWith('simulator.mjs')) {
  startSimulator({ port: Number(process.env.SIM_PORT || SIM_PORT), quiet: false }).catch((e) => { console.error(e); process.exit(1); });
}
