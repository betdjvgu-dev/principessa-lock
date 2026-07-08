import "server-only";

import { sendRemoteActionPush } from "@/lib/server/fcm";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

type SupabaseAdminClient = ReturnType<typeof getSupabaseAdminClient>;

/**
 * Queues a sync_config remote action for a device and pushes an FCM wake-up so a rule/config
 * change (session edits, unlock-request approval) reaches the device immediately instead of
 * waiting on its own periodic polling tick. Best-effort and silent on failure -- the device's
 * existing periodic sync/heartbeat loop is always the fallback delivery path regardless of
 * whether this queue+push succeeds.
 */
export async function queueSyncConfigPush(
  supabase: SupabaseAdminClient,
  { sessionId, deviceId, subId }: { sessionId: string; deviceId: string | null; subId: string | null },
): Promise<void> {
  if (!deviceId) {
    return;
  }

  try {
    await supabase.from("device_remote_actions").insert({
      action_type: "sync_config",
      device_id: deviceId,
      payload: {},
      session_id: sessionId,
      status: "pending",
      sub_id: subId,
    });

    const { data: device } = await supabase
      .from("devices")
      .select("fcm_token")
      .eq("id", deviceId)
      .maybeSingle<{ fcm_token: string | null }>();

    await sendRemoteActionPush(device?.fcm_token);
  } catch {
    // Swallow -- see comment above.
  }
}
