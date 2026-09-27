import "server-only";
import { sendSessionActivatedPush } from "./fcm";
import { getSupabaseAdminClient } from "./supabase-admin";

// Called only by the successful INSERT owner, never by activation recovery/retries.
// Notification delivery must not turn an already committed activation into an error.
export async function notifyAdminSessionActivated(session: {
  sessionId: string; deviceName: string; sessionDays: number; dailyLimitMinutes: number;
}) {
  try {
    const { data, error } = await getSupabaseAdminClient().from("admin_push_tokens")
      .select("fcm_token").maybeSingle<{ fcm_token: string | null }>();
    if (error) {
      console.warn("Session activated; admin push token lookup failed.");
      return false;
    }
    return await sendSessionActivatedPush(data?.fcm_token, session);
  } catch {
    console.warn("Session activated; admin notification delivery failed.");
    return false;
  }
}
