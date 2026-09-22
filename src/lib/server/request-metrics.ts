// Opt-in aggregate diagnostics. No Redis writes, IPs, tokens, bodies or device IDs.
type Metric = "request" | "limiter_attempt" | "circuit_skip" | "limiter_error";
let startedAt = Date.now();
const counters = new Map<string, number>();

export function recordRequestMetric(routeKey: string, metric: Metric) {
  if (process.env.REQUEST_METRICS_ENABLED !== "true") return;
  // Only static route labels are retained. Bound both length and cardinality.
  const route = /^[a-z][a-z:_-]{0,79}$/.test(routeKey) ? routeKey : "other";
  const key = `${route}|${metric}`;
  try {
    if (Date.now() - startedAt >= 60_000 && counters.size) {
      console.info("[request-metrics]", JSON.stringify({
        windowStart: new Date(startedAt).toISOString(), windowEnd: new Date().toISOString(),
        scope: "one-server-instance", counts: Object.fromEntries(counters),
      }));
      counters.clear();
      startedAt = Date.now();
    }
    const boundedKey = counters.has(key) || counters.size < 240 ? key : `other|${metric}`;
    counters.set(boundedKey, (counters.get(boundedKey) ?? 0) + 1);
  } catch { /* Measurement must never break an API request. */ }
}
