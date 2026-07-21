import { jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

type PendingRequestRow = {
  always_allowed_package: string | null;
  approved_at: string | null;
  created_at: string;
  daily_limit_minutes: number;
  device_name: string;
  forced_sleep_enabled: boolean;
  full_discretion: boolean;
  gallery_access_enabled: boolean;
  id: string;
  requested_days: number;
  screen_time_enabled: boolean;
  status: string;
  sub_id: string | null;
  subs: { label: string } | { label: string }[] | null;
};

type RequestDeviceRow = {
  android_release: string | null;
  android_sdk_int: number | null;
  device_manufacturer: string | null;
  device_model: string | null;
  sub_id: string | null;
};

function extractSubLabel(value: PendingRequestRow["subs"]) {
  if (Array.isArray(value)) {
    return value[0]?.label ?? null;
  }

  return value?.label ?? null;
}

export async function GET(request: Request) {
  const rateLimitError = await enforceAdminRateLimit(request, "session-requests:list");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("session_requests")
    .select(
      "id, device_name, requested_days, daily_limit_minutes, screen_time_enabled, always_allowed_package, forced_sleep_enabled, full_discretion, gallery_access_enabled, status, created_at, approved_at, sub_id, subs(label)",
    )
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .returns<PendingRequestRow[]>();

  if (error) {
    return jsonSupabaseError("Failed to load pending session requests.", error);
  }

  const rows = data ?? [];
  const subIds = rows.map((row) => row.sub_id).filter((subId): subId is string => subId !== null);
  const deviceBySubId = new Map<string, RequestDeviceRow>();

  if (subIds.length > 0) {
    const { data: deviceRows, error: deviceError } = await supabase
      .from("devices")
      .select("sub_id, device_manufacturer, device_model, android_release, android_sdk_int")
      .in("sub_id", subIds)
      .returns<RequestDeviceRow[]>();

    if (deviceError) {
      return jsonSupabaseError("Failed to load device info for session requests.", deviceError);
    }

    for (const row of deviceRows ?? []) {
      if (row.sub_id) {
        deviceBySubId.set(row.sub_id, row);
      }
    }
  }

  return jsonOk({
    ok: true,
    requests: rows.map((row) => {
      const device = row.sub_id ? deviceBySubId.get(row.sub_id) : undefined;

      return {
        approved_at: row.approved_at,
        always_allowed_package: row.always_allowed_package,
        android_release: device?.android_release ?? null,
        android_sdk_int: device?.android_sdk_int ?? null,
        created_at: row.created_at,
        daily_limit_minutes: row.daily_limit_minutes,
        device_manufacturer: device?.device_manufacturer ?? null,
        device_model: device?.device_model ?? null,
        device_name: row.device_name,
        forced_sleep_enabled: row.forced_sleep_enabled,
        full_discretion: row.full_discretion,
        gallery_access_enabled: row.gallery_access_enabled,
        id: row.id,
        requested_days: row.requested_days,
        screen_time_enabled: row.screen_time_enabled,
        status: row.status,
        sub_id: row.sub_id,
        sub_label: extractSubLabel(row.subs),
      };
    }),
  });
}
