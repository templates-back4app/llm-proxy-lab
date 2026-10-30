# Streaming vs non-streaming (§6.3, H1) — LOCAL — 2026-10-30T14:01:30.634Z

**LOCAL mechanism evidence (deterministic simulator, loopback): demonstrates the protocol and the H1 mechanism, never the platform's numbers.**

## Registered BEFORE the run (amendments C2)

- Generation: 20 tokens paced at 20 tok/s (≈1.0 s) — one factor (delivery mode) varies.
- H1 expectation to test: through the Cloud function, TTFUO == TTFC (one JSON payload); direct SSE delivers
  TTFUO at roughly first-token time. TTFC of all three legs counts as equivalent within 15% of the direct
  non-streaming median; TTFUO(s) counts as a real streaming win only if its median is under half of TTFC(s).
- 5 warm-ups discarded per leg, 20 timed runs per leg, legs interleaved.

## Results (2026-10-30T14:02:46.735Z)

| Leg | n | TTFUO p50 ms | TTFUO p95 ms | TTFC p50 ms | TTFC p95 ms |
|---|---|---|---|---|---|
| direct-stream | 20 | 52.8 | 53.9 | 1022.4 | 1027.3 |
| direct-json | 20 | 1002.3 | 1003.5 | 1002.3 | 1003.5 |
| via-function | 20 | 1016.9 | 1021.3 | 1016.9 | 1021.3 |

- Both dimensions reported, per amendments pt. 5: the streaming win is TTFUO; TTFC is what every mode pays.
- H1 verdict for the ARTICLE comes from the live phase; this file is the local mechanism record. Raw runs: streaming-h1-local-2026-10-30.csv.
