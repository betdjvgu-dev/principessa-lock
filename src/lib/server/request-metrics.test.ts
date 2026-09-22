import { afterEach, beforeEach, expect, it, vi } from "vitest";
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-21T20:00:00Z"));
  vi.stubEnv("REQUEST_METRICS_ENABLED", "true"); vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("counts requests separately from limiter attempts and skipped circuit calls without extra IO", async () => {
  const { recordRequestMetric: record } = await import("./request-metrics");
  record("admin:subs:list", "request"); record("admin:subs:list", "limiter_attempt");
  record("admin:subs:list", "request"); record("admin:subs:list", "circuit_skip");
  expect(console.info).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000); record("heartbeat", "request");
  const data = JSON.parse(vi.mocked(console.info).mock.calls[0][1]);
  expect(data.counts).toEqual({ "admin:subs:list|request": 2, "admin:subs:list|limiter_attempt": 1, "admin:subs:list|circuit_skip": 1 });
});
it("disabled metrics produce no logs and dynamic route identifiers are redacted", async () => {
  const { recordRequestMetric: record } = await import("./request-metrics");
  vi.stubEnv("REQUEST_METRICS_ENABLED", "false");
  record("admin:subs:list", "request"); vi.advanceTimersByTime(60_000);
  record("admin:subs:list", "request"); expect(console.info).not.toHaveBeenCalled();
  vi.stubEnv("REQUEST_METRICS_ENABLED", "true");
  record("sessions/private-id-123?token=secret", "request"); vi.advanceTimersByTime(60_000);
  record("heartbeat", "request");
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("secret");
  expect(JSON.parse(vi.mocked(console.info).mock.calls[0][1]).counts).toEqual({ "other|request": 1 });
});
