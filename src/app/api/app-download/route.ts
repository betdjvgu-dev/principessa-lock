import { jsonError } from "@/lib/server/api-response";
import { getServerEnv } from "@/lib/env";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

type AppReleaseRow = {
  storage_path: string;
};

// Public and unauthenticated, same reasoning as /api/app-version -- this is the one fixed URL
// the keyholder shares once. Publishing a new release overwrites the same storage object (see
// scripts/publish-android-release.js), so this always redirects to whatever's current without
// the app or the keyholder ever needing to know the underlying storage path changed.
export async function GET(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many download requests. Please wait before trying again.",
    limit: 30,
    request,
    routeKey: "app-download:read",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const { searchParams } = new URL(request.url);
  const platform = searchParams.get("platform") ?? "android";

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("app_releases")
    .select("storage_path")
    .eq("platform", platform)
    .maybeSingle<AppReleaseRow>();

  if (error) {
    return jsonSupabaseError("Failed to load the latest release.", error);
  }

  if (!data) {
    return jsonError(404, "No release has been published for this platform yet.");
  }

  const { SUPABASE_URL } = getServerEnv();
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/app-releases/${data.storage_path}`;

  return Response.redirect(publicUrl, 302);
}
