import { jsonError, jsonOk } from "@/lib/server/api-response";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type SessionRow = {
  activated_at: string;
  daily_limit_minutes: number;
  device_id: string;
  ends_at: string;
  forced_sleep_enabled: boolean;
  id: string;
  session_days: number;
  sleep_end_time: string;
  sleep_start_time: string;
  starts_at: string;
  status: string;
  timezone: string | null;
  updated_at: string;
};

export async function GET(_: Request, context: RouteContext) {
  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Session id is required.");
  }

  const supabase = getSupabaseAdminClient();
  const { data: session, error } = await supabase
    .from("sessions")
    .select("id, device_id, session_days, daily_limit_minutes, forced_sleep_enabled, sleep_start_time, sleep_end_time, timezone, starts_at, ends_at, status, activated_at, updated_at")
    .eq("id", id)
    .maybeSingle<SessionRow>();

  if (error) {
    return jsonSupabaseError("Failed to load session.", error);
  }

  if (!session) {
    return jsonError(404, "Session not found.");
  }

  return jsonOk({
    ok: true,
    activatedAt: session.activated_at,
    dailyLimitMinutes: session.daily_limit_minutes,
    deviceId: session.device_id,
    endsAt: session.ends_at,
    forcedSleepEnabled: session.forced_sleep_enabled,
    sessionDays: session.session_days,
    sessionId: session.id,
    sleepEndTime: session.sleep_end_time,
    sleepStartTime: session.sleep_start_time,
    startsAt: session.starts_at,
    status: session.status,
    timezone: session.timezone,
    updatedAt: session.updated_at,
  });
}
