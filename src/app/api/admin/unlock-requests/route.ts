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

type PendingUnlockRequestRow = {
  approved_at: string | null;
  created_at: string;
  device_id: string;
  expires_at: string | null;
  id: string;
  package_name: string;
  price_usd: number;
  rejected_at: string | null;
  requested_at: string;
  session_id: string;
  status: string;
  sub_id: string | null;
  subs: { label: string } | { label: string }[] | null;
};

function extractSubLabel(value: PendingUnlockRequestRow["subs"]) {
  if (Array.isArray(value)) {
    return value[0]?.label ?? null;
  }

  return value?.label ?? null;
}

export async function GET(request: Request) {
  const rateLimitError = await enforceAdminRateLimit(request, "unlock-requests:list");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("app_unlock_requests")
    .select(
      "id, session_id, device_id, sub_id, package_name, status, price_usd, requested_at, approved_at, rejected_at, expires_at, created_at, subs(label)",
    )
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .returns<PendingUnlockRequestRow[]>();

  if (error) {
    return jsonSupabaseError("Failed to load pending unlock requests.", error);
  }

  return jsonOk({
    ok: true,
    requests: (data ?? []).map((row) => ({
      approvedAt: row.approved_at,
      createdAt: row.created_at,
      deviceId: row.device_id,
      expiresAt: row.expires_at,
      id: row.id,
      packageName: row.package_name,
      priceUsd: row.price_usd,
      rejectedAt: row.rejected_at,
      requestedAt: row.requested_at,
      sessionId: row.session_id,
      status: row.status,
      subId: row.sub_id,
      subLabel: extractSubLabel(row.subs),
    })),
  });
}
