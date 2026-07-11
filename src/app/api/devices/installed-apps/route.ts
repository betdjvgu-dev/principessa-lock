import { jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import {
  readJsonBody,
  validateInstalledAppsReportInput,
  type InstalledAppsReportInput,
} from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many installed-app reports. Please wait before trying again.",
    limit: 10,
    request,
    routeKey: "devices:installed-apps",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const bodyResult = await readJsonBody<InstalledAppsReportInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateInstalledAppsReportInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  const supabase = getSupabaseAdminClient();
  const deviceAuth = await requireAuthenticatedDevice(request, supabase);

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const { error: updateError } = await supabase
    .from("devices")
    .update({ installed_apps: validation.data.apps })
    .eq("id", deviceAuth.device.id);

  if (updateError) {
    return jsonSupabaseError("Failed to store installed apps.", updateError);
  }

  return jsonOk({ ok: true });
}
