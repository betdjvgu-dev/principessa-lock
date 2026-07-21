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

type SubRow = {
  created_at: string;
  id: string;
  label: string;
  status: string;
};

type SubDeviceRow = {
  android_release: string | null;
  android_sdk_int: number | null;
  device_manufacturer: string | null;
  device_model: string | null;
  sub_id: string | null;
};

// Subs are now created only via self-registration (/api/register) -- there is no admin-facing
// "create a sub" action anymore, so this route is read-only.
export async function GET(request: Request) {
  const rateLimitError = await enforceAdminRateLimit(request, "subs:list");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("subs")
    .select("id, label, status, created_at")
    .order("created_at", { ascending: false })
    .returns<SubRow[]>();

  if (error) {
    return jsonSupabaseError("Failed to load subs.", error);
  }

  const subs = data ?? [];

  if (subs.length === 0) {
    return jsonOk({ ok: true, subs: [] });
  }

  // Separate query + in-memory merge (same pattern as the heartbeat merge in
  // admin/sessions/route.ts) rather than a join -- a sub can exist with no device row yet
  // (registration failed after the subs insert) and PostgREST embeds turn that into null-shaped
  // noise that's more awkward to unpack than just merging by sub_id here.
  const { data: deviceRows, error: deviceError } = await supabase
    .from("devices")
    .select("sub_id, device_manufacturer, device_model, android_release, android_sdk_int")
    .in(
      "sub_id",
      subs.map((sub) => sub.id),
    )
    .returns<SubDeviceRow[]>();

  if (deviceError) {
    return jsonSupabaseError("Failed to load device info for subs.", deviceError);
  }

  const deviceBySubId = new Map<string, SubDeviceRow>();
  for (const row of deviceRows ?? []) {
    if (row.sub_id) {
      deviceBySubId.set(row.sub_id, row);
    }
  }

  return jsonOk({
    ok: true,
    subs: subs.map((sub) => {
      const device = deviceBySubId.get(sub.id);

      return {
        ...sub,
        android_release: device?.android_release ?? null,
        android_sdk_int: device?.android_sdk_int ?? null,
        device_manufacturer: device?.device_manufacturer ?? null,
        device_model: device?.device_model ?? null,
      };
    }),
  });
}
