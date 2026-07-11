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

  return jsonOk({
    ok: true,
    subs: data,
  });
}
