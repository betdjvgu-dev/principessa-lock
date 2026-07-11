import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice, verifySessionOwnershipForDevice } from "@/lib/server/device-auth";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type UsageRow = {
  limit_minutes: number;
  local_date: string;
  used_minutes: number;
};

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Session id is required.");
  }

  const supabase = getSupabaseAdminClient();
  const deviceAuth = await requireAuthenticatedDevice(request, supabase);

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const sessionOwnership = await verifySessionOwnershipForDevice({
    authenticatedDeviceId: deviceAuth.device.id,
    sessionId: id,
    suppliedSupabase: supabase,
  });

  if (!sessionOwnership.ok) {
    return sessionOwnership.response;
  }

  const { data, error } = await supabase
    .from("session_daily_usage")
    .select("local_date, used_minutes, limit_minutes")
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
      usedMinutes: row.used_minutes,
    })),
    ok: true,
  });
}
