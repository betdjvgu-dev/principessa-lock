import "server-only";

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
  const forwardedFor = request.headers.get("x-forwarded-for");

  if (forwardedFor) {
    const firstForwardedIp = forwardedFor
      .split(",")
      .map((value) => value.trim())
      .find(Boolean);

    if (firstForwardedIp) {
      return firstForwardedIp;
    }
  }

  const realIp = request.headers.get("x-real-ip")?.trim();

  if (realIp) {
    return realIp;
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

export function enforceRateLimit(options: RateLimitOptions) {
  const { errorMessage, limit, request, routeKey, windowMs } = options;
  const now = Date.now();
  const store = getRateLimitStore();

  pruneExpiredBuckets(store, now);

  const bucketKey = `${routeKey}:${getClientIdentifier(request)}`;
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
