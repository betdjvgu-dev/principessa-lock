import "server-only";

import { jsonRateLimited } from "@/lib/server/api-response";
import { recordRequestMetric } from "./request-metrics";

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
const MAX_BUCKETS = 10_000;

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

  if (store.size <= MAX_BUCKETS) {
    return;
  }

  const oldestFirst = [...store.entries()].sort((left, right) => left[1].resetAt - right[1].resetAt);
  for (const [key] of oldestFirst) {
    if (store.size <= MAX_BUCKETS) {
      break;
    }
    store.delete(key);
  }
}

/**
 * Shared, generous rate limit for authenticated admin routes. Bearer tokens here are
 * high-entropy Supabase Auth sessions (not brute-forceable), so this is defense-in-depth
 * against a leaked/compromised token being used for rapid abuse, not the primary control.
 *
 * Counters live in this instance's memory. A cold start resets them. That is enough for
 * one admin desktop and paired devices; a distributed store is not used.
 *
 * 1200/15min (8/min) was too tight for how the desktop admin actually behaves: its dashboard
 * reload fires 5 parallel calls (subs, sessions, requests, device-status, unlock-requests) on
 * every trigger, and it's retriggered by its own Supabase Realtime subscription. That easily
 * exceeded the old budget within 15 minutes, so whichever endpoint happened to hit the ceiling
 * first would silently fail for that reload.
 */
export async function enforceAdminRateLimit(request: Request, routeKey: string) {
  return enforceRateLimit({
    errorMessage: "Too many admin requests. Please wait before trying again.",
    limit: 1200,
    request,
    routeKey: `admin:${routeKey}`,
    windowMs: 15 * 60 * 1000,
  });
}

export async function enforceRateLimit(options: RateLimitOptions) {
  const { errorMessage, limit, request, routeKey, windowMs } = options;
  recordRequestMetric(routeKey, "request");
  const bucketKey = `${routeKey}:${getClientIdentifier(request)}`;
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
