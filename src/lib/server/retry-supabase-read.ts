import { isTransientReadError } from "./transient-read-error";

/** Rebuild the query per attempt. Never use this for non-idempotent writes. */
export async function retrySupabaseRead<T extends { error: unknown; status?: number }>(
  operation: () => PromiseLike<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const result = await operation();
    if (attempt >= 2 || !isTransientReadError(result.error, result.status)) return result;
    console.warn("[database-read] Retrying transient failure", { retry: attempt + 1 });
    await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
  }
}
