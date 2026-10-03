import "server-only";
import { getSupabaseAdminClient } from "./supabase-admin";

export async function notifyAdminDevices(send: (token: string) => Promise<unknown>) {
  try {
    const { data, error } = await getSupabaseAdminClient().from("admin_push_tokens").select("fcm_token").limit(100);
    if (error) return false;
    const tokens = [...new Set((data ?? []).map(row => row.fcm_token as string).filter(Boolean))];
    const results = await Promise.allSettled(tokens.map(send));
    return results.some(result => result.status === "fulfilled" && result.value !== false);
  } catch { return false; }
}
