// File: test/streaming.test.mjs · H1-local: what streaming looks like through the function vs direct SSE —
// compared on BOTH time-to-first-usable-output and time-to-full-completion (amendments pt. 5). LOCAL +
// SIMULATOR numbers: they demonstrate the MECHANISM (a Cloud function returns one JSON payload after the
// whole generation; SSE delivers the first token at first-token time). The published H1 verdict and its
// numbers come from the live phase (scripts/measure-streaming.mjs against the platform); loopback timings
// here are mechanism evidence, never the article's numbers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.mjs';

let h; let user;
// 20 tokens at 20 tokens/s ≈ 1 s of "generation" — slow enough that first-token vs last-token separates
// cleanly even with timer jitter.
const GEN = '[[sim:out:20]] [[sim:tps:20]]';

before(async () => {
  h = await harness({ suite: 'streaming' });
  user = await h.signUp('stream_user');
});
after(async () => { await h.cleanup(); });

test('H1a through the function: stream:true is not forwarded; ONE JSON payload arrives after full generation', async () => {
  const t0 = performance.now();
  const r = await h.ask(`stream please ${GEN}`, user.token, { stream: true });
  const full = performance.now() - t0;
  assert.equal(r.ok, true);
  assert.equal(r.result.text.split(' ').length, 20, 'complete 20-token text in one piece');
  assert.ok(full >= 900, `nothing usable before full completion (took ${full.toFixed(0)} ms for ~1000 ms generation)`);
  h.observe('H1a function (non-stream): time-to-first-usable-output == time-to-full-completion (ms)', full.toFixed(0));
  h.record({
    id: 'H1a', test: 'streaming (mechanism)', persona: 'signed-in user',
    attempt: `askLlm({stream:true}) with ${GEN}`,
    status: 200, code: null,
    body: 'single JSON payload; first usable output = full completion',
    state: 'provider request carried no stream flag (see T8); one ok row',
  });
});

test('H1b direct SSE (simulator): first usable output arrives at first-token time, long before completion', async () => {
  const t0 = performance.now();
  let firstDelta = null; let done = null; let text = '';
  const res = await fetch(`${h.sim.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test-local', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: `stream ${GEN}` }] }),
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!data) continue;
      const msg = JSON.parse(data.slice(6));
      if (msg.type === 'content_block_delta') {
        if (firstDelta === null) firstDelta = performance.now() - t0;
        text += msg.delta.text;
      }
      if (msg.type === 'message_stop') done = performance.now() - t0;
    }
  }
  assert.equal(text.split(' ').length, 20, 'streamed text completes to the same deterministic 20 tokens');
  assert.ok(firstDelta !== null && done !== null);
  assert.ok(firstDelta < done / 3, `first token (${firstDelta.toFixed(0)} ms) arrives much earlier than completion (${done.toFixed(0)} ms)`);
  h.observe('H1b direct SSE: time-to-first-usable-output (ms)', firstDelta.toFixed(0));
  h.observe('H1b direct SSE: time-to-full-completion (ms)', done.toFixed(0));
  h.record({
    id: 'H1b', test: 'streaming (mechanism)', persona: 'direct caller (what the proxy gives up)',
    attempt: `POST /v1/messages stream:true with ${GEN} against the simulator`,
    status: 200, code: null,
    body: `SSE: first delta at ${firstDelta.toFixed(0)} ms, message_stop at ${done.toFixed(0)} ms; same final text and usage as non-streaming`,
    state: 'no backend involved (direct provider leg of the comparison)',
  });
});
