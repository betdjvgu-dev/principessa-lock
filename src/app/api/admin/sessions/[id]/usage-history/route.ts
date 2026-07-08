import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type UsageRow = {
  limit_minutes: number;
  local_date: string;
  per_app_minutes: Record<string, number> | null;
  step_bonus_minutes_earned: number | null;
  steps_recorded: number | null;
  used_minutes: number;
};

export async function GET(request: Request, context: RouteContext) {
  const rateLimitError = await enforceAdminRateLimit(request, "sessions:usage-history");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Session id is required.");
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("session_daily_usage")
    .select("local_date, used_minutes, limit_minutes, steps_recorded, step_bonus_minutes_earned, per_app_minutes")
    .eq("session_id", id)
    .order("local_date", { ascending: false })
    .limit(30)
    .returns<UsageRow[]>();

  if (error) {
    return jsonSupabaseError("Failed to load usage history.", error);
  }

  return jsonOk({
    days: (data ?? []).map((row) => ({
      dailyLimitMinutes: row.limit_minutes,
      localDate: row.local_date,
      perAppMinutes: row.per_app_minutes ?? {},
      stepBonusMinutesEarned: row.step_bonus_minutes_earned,
      stepsRecorded: row.steps_recorded,
      usedMinutes: row.used_minutes,
    })),
    ok: true,
  });
}
