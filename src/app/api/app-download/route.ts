import { jsonError } from "@/lib/server/api-response";
import { getServerEnv } from "@/lib/env";
import { resolveAppReleaseDownloadUrl } from "@/lib/server/app-release";
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
  download_url: string | null;
  storage_path: string | null;
};

// Public and unauthenticated, same reasoning as /api/app-version -- this is the one fixed URL
// the keyholder shares once. New releases redirect to a public GitHub Release asset. The legacy
// Supabase Storage path remains a fallback while existing release metadata is migrated.
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
    .select("download_url, storage_path")
    .eq("platform", platform)
    .maybeSingle<AppReleaseRow>();

  if (error) {
    return jsonSupabaseError("Failed to load the latest release.", error);
  }

  if (!data) {
    return jsonError(404, "No release has been published for this platform yet.");
  }

  const { SUPABASE_URL } = getServerEnv();
  const publicUrl = resolveAppReleaseDownloadUrl(data, SUPABASE_URL);
  if (!publicUrl) {
    return jsonError(503, "The latest release does not have a valid download URL.");
  }

  return Response.redirect(publicUrl, 302);
}
