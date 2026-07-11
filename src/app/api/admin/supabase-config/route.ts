import { getServerEnv, getSupabaseAnonKey } from "@/lib/env";
import { jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

// Lets an already-logged-in desktop admin backfill the Supabase Realtime config (added after
// that session was created) without needing to log out and back in -- see
// desktop-admin/src/App.tsx's bootstrap effect, which calls this once if supabaseUrl/anonKey are
// missing from cached settings.
export async function GET(request: Request) {
  const rateLimitError = await enforceAdminRateLimit(request, "admin:supabase-config");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  return jsonOk({
    ok: true,
    supabase: {
      anonKey: getSupabaseAnonKey(),
      url: getServerEnv().SUPABASE_URL,
    },
  });
}
