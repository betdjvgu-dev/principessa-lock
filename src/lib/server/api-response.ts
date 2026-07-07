import { NextResponse } from "next/server";

export function jsonOk<T extends Record<string, unknown>>(body: T, init?: ResponseInit) {
  return NextResponse.json(body, init);
}

export function jsonError(status: number, error: string, details?: Record<string, unknown>) {
  return NextResponse.json(
    {
      ok: false,
      error,
      ...(details ? { details } : {}),
    },
    { status },
  );
}

export function jsonRateLimited(error: string, retryAfterSeconds: number) {
  return NextResponse.json(
    {
      ok: false,
      error,
      details: {
        retryAfterSeconds,
      },
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}
