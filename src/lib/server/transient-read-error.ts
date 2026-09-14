const transientCodes = new Set([
  "PGRST000", "PGRST001", "PGRST002", "PGRST003",
  "08000", "08001", "08003", "08006", "08007", "08P01",
  "53300", "53400", "57014", "57P01", "57P02", "57P03",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN",
]);

/** Only retry reads. Schema/auth errors need intervention, not another identical query. */
export function isTransientReadError(error: unknown, status?: number): boolean {
  if (!error) return false;
  const details = error as { code?: string; message?: string };
  if (transientCodes.has(details.code ?? "")) return true;
  if (details.code) return false;
  if (status === 0 || status === 502 || status === 503 || status === 504) return true;
  // supabase-js represents a rejected fetch as a PostgrestError with an empty code.
  return /^(?:TypeError: )?fetch failed$|networkerror when attempting to fetch resource|failed to fetch/i
    .test(details.message ?? "");
}
