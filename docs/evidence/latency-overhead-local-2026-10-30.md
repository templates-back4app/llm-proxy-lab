# Proxy overhead (§6.1) — LOCAL, controlled endpoint — 2026-10-30T14:01:21.519Z

**LOCAL mechanism evidence (simulator + in-process parse-server on loopback): numbers demonstrate the protocol, never the platform.**

## Registered BEFORE the run (practical-equivalence margin, amendments C2)

- Hypothesis H3: the hop costs latency; it counts as negligible only if median overhead (b−a) ≤ 25 ms.
- Protocol: 20 warm-ups discarded per leg, 100 timed runs per leg, one fixed prompt, fixed 8-token
  deterministic response, sequential requests, legs interleaved run-by-run so drift hits both equally.
- Baseline is contemporaneous: leg (a) is measured in this same session (amendments C1).

## Results (2026-10-30T14:01:22.011Z)

| Leg | n | p50 ms | p95 ms | min | max |
|---|---|---|---|---|---|
| (a) direct → controlled endpoint | 100 | 0.2 | 0.3 | 0.2 | 0.4 |
| (b) → askLlm → controlled endpoint | 100 | 3.6 | 5.3 | 2.7 | 5.8 |

- Median hop overhead (b−a, p50): **3.4 ms** — WITHIN the registered 25 ms margin (observed in these tests, 2026-10-30, target local).
- p95 overhead: 5.0 ms. Raw runs: latency-overhead-local-2026-10-30.csv.
- Note: the hop includes the platform's auth + the budget read + the pending usage write + the final update —
  billable-operation accounting is §6.6 (live phase).
