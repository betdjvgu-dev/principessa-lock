import { jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type ActiveSessionRow = {
  activated_at: string;
  daily_limit_minutes: number;
  device_id: string;
  device_name: string | null;
  ends_at: string;
  forced_sleep_enabled: boolean;
  id: string;
  request_id: string;
  session_days: number;
  starts_at: string;
  status: string;
  timezone: string | null;
};

type RawActiveSessionRow = {
  activated_at: string;
  daily_limit_minutes: number;
  device_id: string;
  devices: { device_name: string } | { device_name: string }[] | null;
  ends_at: string;
  forced_sleep_enabled: boolean;
  id: string;
  request_id: string;
  session_days: number;
  starts_at: string;
  status: string;
  timezone: string | null;
};

function extractDeviceName(value: RawActiveSessionRow["devices"]) {
  if (Array.isArray(value)) {
    return value[0]?.device_name ?? null;
  }

  return value?.device_name ?? null;
}

export async function GET(request: Request) {
  const authError = verifyAdminRequest(request);

  if (authError) {
    return authError;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("sessions")
    .select(
      "id, request_id, device_id, session_days, daily_limit_minutes, forced_sleep_enabled, timezone, starts_at, ends_at, status, activated_at, devices(device_name)",
    )
    .eq("status", "active")
    .order("activated_at", { ascending: false })
    .returns<RawActiveSessionRow[]>();

  if (error) {
    return jsonSupabaseError("Failed to load active sessions.", error);
  }

  const sessions: ActiveSessionRow[] = (data ?? []).map((session) => ({
    activated_at: session.activated_at,
    daily_limit_minutes: session.daily_limit_minutes,
    device_id: session.device_id,
    device_name: extractDeviceName(session.devices),
    ends_at: session.ends_at,
    forced_sleep_enabled: session.forced_sleep_enabled,
    id: session.id,
    request_id: session.request_id,
    session_days: session.session_days,
    starts_at: session.starts_at,
    status: session.status,
    timezone: session.timezone,
  }));

  return jsonOk({
    ok: true,
    sessions,
  });
}
