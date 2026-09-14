import { getSupabaseAdminClient } from "./supabase-admin";
import { jsonSupabaseReadError } from "./supabase-errors";
import { retrySupabaseRead } from "./retry-supabase-read";

// Database time is authoritative; the scheduled job uses this same atomic function.
export async function revokeTimedOutPauses(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  sessionId: string | null = null,
) {
  // This RPC only revokes active overdue pauses; a repeated call cannot extend or
  // re-revoke a session. Unlike general mutations it is safe to retry.
  const { error } = await retrySupabaseRead(() =>
    supabase.rpc("revoke_timed_out_session_pauses", { target_session_id: sessionId }));
  return error ? jsonSupabaseReadError("Failed to check session pause deadline.", error) : null;
}
