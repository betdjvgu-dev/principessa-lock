import { jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { getSuccessfullyCompletedDays } from "@/lib/server/leaderboard";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

type SessionDaysRow = {
  ends_at: string | null;
  session_days: number | null;
  starts_at: string | null;
  status: string | null;
  sub_id: string | null;
  subs: { username: string | null } | null;
};

export async function GET(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many leaderboard requests. Please wait before trying again.",
    limit: 30,
    request,
    routeKey: "leaderboard:read",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const supabase = getSupabaseAdminClient();
  const deviceAuth = await requireAuthenticatedDevice(request, supabase);

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const { data, error } = await supabase
    .from("sessions")
    .select("sub_id, session_days, starts_at, ends_at, status, subs(username)")
    .returns<SessionDaysRow[]>();

  if (error) {
    return jsonSupabaseError("Failed to load leaderboard.", error);
  }

  // Award only full days actually survived. Merely creating a long session cannot increase the
  // score, and revoked sessions do not count.
  const totalsBySubId = new Map<string, { totalDaysLocked: number; username: string }>();

  for (const row of data ?? []) {
    const username = row.subs?.username;

    if (!row.sub_id || !username || username.trim().toLocaleLowerCase("en-US") === "principessa") {
      continue;
    }

    const completedDays = getSuccessfullyCompletedDays(row);
    if (completedDays === 0) {
      continue;
    }

    const existing = totalsBySubId.get(row.sub_id);

    if (existing) {
      existing.totalDaysLocked += completedDays;
    } else {
      totalsBySubId.set(row.sub_id, { totalDaysLocked: completedDays, username });
    }
  }

  const entries = Array.from(totalsBySubId.entries())
    .map(([subId, entry]) => ({ subId, totalDaysLocked: entry.totalDaysLocked, username: entry.username }))
    .sort((left, right) => right.totalDaysLocked - left.totalDaysLocked)
    .map((entry, index) => ({
      isYou: entry.subId === deviceAuth.device.subId,
      rank: index + 1,
      totalDaysLocked: entry.totalDaysLocked,
      username: entry.username,
    }));

  return jsonOk({ entries, ok: true });
}
