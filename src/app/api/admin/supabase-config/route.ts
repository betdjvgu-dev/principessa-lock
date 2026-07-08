import { getServerEnv, getSupabaseAnonKey } from "@/lib/env";
import { jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";

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
