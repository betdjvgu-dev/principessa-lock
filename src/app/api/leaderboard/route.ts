import { jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type SessionPriceRow = {
  price_usd: number | null;
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
    .select("sub_id, price_usd, subs(username)")
    .returns<SessionPriceRow[]>();

  if (error) {
    return jsonSupabaseError("Failed to load leaderboard.", error);
  }

  // Only subs who have set a username show up -- there's nothing to rank them by/as otherwise.
  const totalsBySubId = new Map<string, { totalUsd: number; username: string }>();

  for (const row of data ?? []) {
    const username = row.subs?.username;

    if (!row.sub_id || !username) {
      continue;
    }

    const priceUsd = row.price_usd ?? 0;
    const existing = totalsBySubId.get(row.sub_id);

    if (existing) {
      existing.totalUsd += priceUsd;
    } else {
      totalsBySubId.set(row.sub_id, { totalUsd: priceUsd, username });
    }
  }

  const entries = Array.from(totalsBySubId.entries())
    .map(([subId, entry]) => ({ subId, totalTributeUsd: entry.totalUsd, username: entry.username }))
    .sort((left, right) => right.totalTributeUsd - left.totalTributeUsd)
    .map((entry, index) => ({
      isYou: entry.subId === deviceAuth.device.subId,
      rank: index + 1,
      totalTributeUsd: entry.totalTributeUsd,
      username: entry.username,
    }));

  return jsonOk({ entries, ok: true });
}
