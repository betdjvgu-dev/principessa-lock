import "server-only";
import { getSupabaseAdminClient } from "./supabase-admin";
import { jsonSupabaseError } from "./supabase-errors";
import { jsonError } from "./api-response";

// Call only after the existing ADMIN_EMAIL verification, with its authenticated Auth user ID.
export async function registerRealtimeAdmin(userId: string) {
  try {
    const { error } = await getSupabaseAdminClient().rpc("set_lock_realtime_admin", { p_user_id: userId });
    return error ? jsonSupabaseError("Admin authorization setup failed. Apply the hardening migration.", error) : null;
  } catch {
    return jsonError(503, "Admin authorization setup is temporarily unavailable. Please retry.");
  }
}
