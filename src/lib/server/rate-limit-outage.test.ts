import { afterEach, beforeEach, expect, it, vi } from "vitest";

const options = {
  errorMessage: "Slow down",
  limit: 2,
  windowMs: 60_000,
  routeKey: "test",
  request: new Request("https://test.invalid", { headers: { "x-real-ip": "127.0.0.1" } }),
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T20:00:00Z"));
  delete (globalThis as typeof globalThis & { __principessa_lock_rate_limit_store__?: unknown }).__principessa_lock_rate_limit_store__;
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unused.invalid");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "unused");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("allows requests inside the window and returns 429 when the limit is reached", async () => {
  const { enforceRateLimit } = await import("./rate-limit");
  expect(await enforceRateLimit(options)).toBeNull();
  expect(await enforceRateLimit(options)).toBeNull();
  const limited = await enforceRateLimit(options);
  expect(limited?.status).toBe(429);
  expect(limited?.headers.get("Retry-After")).toBe("60");
  expect(await limited?.json()).toMatchObject({ ok: false, details: { retryAfterSeconds: 60 } });
});

it("keeps route keys and client addresses independent", async () => {
  const { enforceRateLimit } = await import("./rate-limit");
  expect(await enforceRateLimit(options)).toBeNull();
  expect(await enforceRateLimit(options)).toBeNull();
  expect(await enforceRateLimit({ ...options, routeKey: "other" })).toBeNull();
  const otherClient = new Request("https://test.invalid", { headers: { "x-forwarded-for": "10.0.0.1, 10.1.0.8" } });
  expect(await enforceRateLimit({ ...options, request: otherClient })).toBeNull();
});

it("resets a bucket after its window and drops expired entries", async () => {
  const { enforceRateLimit } = await import("./rate-limit");
  expect(await enforceRateLimit(options)).toBeNull();
  expect(await enforceRateLimit(options)).toBeNull();
  vi.advanceTimersByTime(60_000);
  expect(await enforceRateLimit(options)).toBeNull();
  const store = (globalThis as typeof globalThis & { __principessa_lock_rate_limit_store__?: Map<string, unknown> }).__principessa_lock_rate_limit_store__;
  expect(store?.size).toBe(1);
});

it("still rate limits in production when Upstash environment variables are present or absent", async () => {
  const { enforceRateLimit } = await import("./rate-limit");
  expect(await enforceRateLimit(options)).toBeNull();
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.resetModules();
  const { enforceRateLimit: withoutToken } = await import("./rate-limit");
  expect(await withoutToken({ ...options, routeKey: "plain" })).toBeNull();
});
