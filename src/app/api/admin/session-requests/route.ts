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

  return jsonOk({
    ok: true,
    requests: (data ?? []).map((row) => ({
      approved_at: row.approved_at,
      always_allowed_package: row.always_allowed_package,
      created_at: row.created_at,
      daily_limit_minutes: row.daily_limit_minutes,
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
    })),
  });
}
