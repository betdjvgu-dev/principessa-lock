import "server-only";

import { sendRemoteActionPush } from "@/lib/server/fcm";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

type SupabaseAdminClient = ReturnType<typeof getSupabaseAdminClient>;

/**
 * Queues a sync_config remote action for a device and pushes an FCM wake-up so a rule/config
 * change (session edits, unlock-request approval) reaches the device immediately instead of
 * waiting on its own periodic polling tick. Best-effort with explicit delivery diagnostics -- the device's
 * existing periodic sync/heartbeat loop is always the fallback delivery path regardless of
 * whether this queue+push succeeds.
 */
export async function queueSyncConfigPush(
  supabase: SupabaseAdminClient,
  { sessionId, deviceId, subId }: { sessionId: string; deviceId: string | null; subId: string | null },
): Promise<{ queued: boolean; pushSent: boolean }> {
  if (!deviceId) {
    console.warn("Config delivery has no target device; periodic sync remains available.");
    return { queued: false, pushSent: false };
  }

  let queued = false;
  try {
    const { error } = await supabase.from("device_remote_actions").insert({
      action_type: "sync_config",
      device_id: deviceId,
      payload: {},
      session_id: sessionId,
      status: "pending",
      sub_id: subId,
    });
    queued = !error;
    if (error) console.error("Failed to queue config delivery.", { code: error.code });
  } catch {
    console.error("Config delivery queue connection failed.");
  }

  try {
    const { data: device, error } = await supabase
      .from("devices")
      .select("fcm_token")
      .eq("id", deviceId)
      .maybeSingle<{ fcm_token: string | null }>();

    if (error) {
      console.error("Failed to load config delivery target.", { code: error.code });
      return { queued, pushSent: false };
    }
    const pushSent = await sendRemoteActionPush(device?.fcm_token);
    if (!pushSent) console.warn("Config wake-up not sent; queued action/periodic sync remains available.");
    return { queued, pushSent };
  } catch {
    console.error("Config wake-up failed; periodic sync remains available.");
    return { queued, pushSent: false };
  }
}
