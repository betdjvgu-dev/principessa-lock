import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { jsonRateLimited } from "@/lib/server/api-response";

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type RateLimitOptions = {
  errorMessage: string;
  limit: number;
  request: Request;
  routeKey: string;
  windowMs: number;
};

const RATE_LIMIT_STORE_KEY = "__principessa_lock_rate_limit_store__";
const RATE_LIMITER_CACHE_KEY = "__principessa_lock_rate_limiter_cache__";

function getRateLimitStore() {
  const globalState = globalThis as typeof globalThis & {
    [RATE_LIMIT_STORE_KEY]?: Map<string, RateLimitBucket>;
  };

  if (!globalState[RATE_LIMIT_STORE_KEY]) {
    globalState[RATE_LIMIT_STORE_KEY] = new Map<string, RateLimitBucket>();
  }

  return globalState[RATE_LIMIT_STORE_KEY];
}

function getClientIdentifier(request: Request) {
  // `x-real-ip` and the last hop of `x-forwarded-for` are set by Vercel's edge network
  // itself (the true connecting IP), unlike earlier `x-forwarded-for` entries which are
  // client-supplied and trivially spoofable to bypass rate limiting.
  const realIp = request.headers.get("x-real-ip")?.trim();

  if (realIp) {
    return realIp;
  }

  const forwardedFor = request.headers.get("x-forwarded-for");

  if (forwardedFor) {
    const ips = forwardedFor
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const lastForwardedIp = ips.at(-1);

    if (lastForwardedIp) {
      return lastForwardedIp;
    }
  }

  return "unknown-client";
}

function pruneExpiredBuckets(store: Map<string, RateLimitBucket>, now: number) {
  for (const [key, bucket] of store.entries()) {
    if (bucket.resetAt <= now) {
      store.delete(key);
    }
  }
}

let cachedRedis: Redis | null | undefined;

function isProductionEnvironment() {
  return process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
}

function getUpstashRedis(): Redis | null {
  if (cachedRedis !== undefined) {
    return cachedRedis;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    if (isProductionEnvironment()) {
      // The in-memory fallback below is per-serverless-instance only, so on a real
      // multi-instance production deployment it doesn't actually rate-limit anything across
      // instances -- fail loudly here rather than silently running with no effective
      // protection. Local/dev (no VERCEL_ENV, NODE_ENV !== "production") still falls back.
      throw new Error(
        "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set in production -- the in-memory rate limit fallback does not work across multiple serverless instances.",
      );
    }

    cachedRedis = null;
    return cachedRedis;
  }

  cachedRedis = new Redis({ token, url });
  return cachedRedis;
}

function getRateLimiterCache() {
  const globalState = globalThis as typeof globalThis & {
    [RATE_LIMITER_CACHE_KEY]?: Map<string, Ratelimit>;
  };

  if (!globalState[RATE_LIMITER_CACHE_KEY]) {
    globalState[RATE_LIMITER_CACHE_KEY] = new Map<string, Ratelimit>();
  }

  return globalState[RATE_LIMITER_CACHE_KEY];
}

/**
 * Returns an Upstash-backed limiter (shared across serverless instances/regions) when
 * `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are configured, otherwise `null` so
 * callers fall back to the in-memory, per-instance-only limiter (fine for local dev, but
 * throws instead in a production environment -- see getUpstashRedis).
 */
function getUpstashLimiter(limit: number, windowMs: number): Ratelimit | null {
  const redis = getUpstashRedis();

  if (!redis) {
    return null;
  }

  const cacheKey = `${limit}:${windowMs}`;
  const cache = getRateLimiterCache();
  const cached = cache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const limiter = new Ratelimit({
    limiter: Ratelimit.slidingWindow(limit, `${windowMs} ms`),
    prefix: "principessa_lock_rate_limit",
    redis,
  });

  cache.set(cacheKey, limiter);
  return limiter;
}

/**
 * Shared, generous rate limit for authenticated admin routes. Bearer tokens here are
 * high-entropy Supabase Auth sessions (not brute-forceable), so this is defense-in-depth
 * against a leaked/compromised token being used for rapid abuse, not the primary control.
 */
export async function enforceAdminRateLimit(request: Request, routeKey: string) {
  return enforceRateLimit({
    errorMessage: "Too many admin requests. Please wait before trying again.",
    limit: 120,
    request,
    routeKey: `admin:${routeKey}`,
    windowMs: 15 * 60 * 1000,
  });
}

export async function enforceRateLimit(options: RateLimitOptions) {
  const { errorMessage, limit, request, routeKey, windowMs } = options;
  const bucketKey = `${routeKey}:${getClientIdentifier(request)}`;

  const upstashLimiter = getUpstashLimiter(limit, windowMs);

  if (upstashLimiter) {
    const result = await upstashLimiter.limit(bucketKey);

    if (!result.success) {
      const retryAfterSeconds = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
      return jsonRateLimited(errorMessage, retryAfterSeconds);
    }

    return null;
  }

  const now = Date.now();
  const store = getRateLimitStore();
  pruneExpiredBuckets(store, now);

  const existingBucket = store.get(bucketKey);

  if (!existingBucket || existingBucket.resetAt <= now) {
    store.set(bucketKey, {
      count: 1,
      resetAt: now + windowMs,
    });
    return null;
  }

  if (existingBucket.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existingBucket.resetAt - now) / 1000));
    return jsonRateLimited(errorMessage, retryAfterSeconds);
  }

  existingBucket.count += 1;
  return null;
}
