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
  ends_at: string;
  forced_sleep_enabled: boolean;
  id: string;
  session_days: number;
  starts_at: string;
  status: string;
  timezone: string | null;
};

export async function GET(_: Request, context: RouteContext) {
  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Session id is required.");
  }

  const supabase = getSupabaseAdminClient();
  const { data: session, error } = await supabase
    .from("sessions")
    .select("id, session_days, daily_limit_minutes, forced_sleep_enabled, timezone, starts_at, ends_at, status, activated_at")
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
    session: {
      activatedAt: session.activated_at,
      dailyLimitMinutes: session.daily_limit_minutes,
      endsAt: session.ends_at,
      forcedSleepEnabled: session.forced_sleep_enabled,
      id: session.id,
      sessionDays: session.session_days,
      startsAt: session.starts_at,
      status: session.status,
      timezone: session.timezone,
    },
  });
}
