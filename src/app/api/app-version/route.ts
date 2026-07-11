import { jsonError, jsonOk } from "@/lib/server/api-response";
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
  platform: string;
  release_notes: string | null;
  storage_path: string;
  updated_at: string;
  version_code: number;
  version_name: string;
};

// Public and unauthenticated -- an app checking for an update (or someone about to download it
// for the very first time, before any device secret exists) can't attach a device bearer token.
// Nothing sensitive is returned here, just a version number and a fixed download URL.
export async function GET(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many version checks. Please wait before trying again.",
    limit: 30,
    request,
    routeKey: "app-version:read",
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
    .select("platform, version_code, version_name, release_notes, storage_path, updated_at")
    .eq("platform", platform)
    .maybeSingle<AppReleaseRow>();

  if (error) {
    return jsonSupabaseError("Failed to load the latest release.", error);
  }

  if (!data) {
    return jsonError(404, "No release has been published for this platform yet.");
  }

  return jsonOk({
    downloadUrl: `${new URL(request.url).origin}/api/app-download?platform=${encodeURIComponent(platform)}`,
    ok: true,
    platform: data.platform,
    releaseNotes: data.release_notes,
    updatedAt: data.updated_at,
    versionCode: data.version_code,
    versionName: data.version_name,
  });
}
