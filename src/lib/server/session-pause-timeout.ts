import { getSupabaseAdminClient } from "./supabase-admin";
import { jsonSupabaseError } from "./supabase-errors";

// Database time is authoritative; the scheduled job uses this same atomic function.
export async function revokeTimedOutPauses(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  sessionId: string | null = null,
) {
  const { error } = await supabase.rpc("revoke_timed_out_session_pauses", { target_session_id: sessionId });
  return error ? jsonSupabaseError("Failed to check session pause deadline.", error) : null;
}
