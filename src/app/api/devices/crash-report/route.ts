import { jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateCrashReportInput, type CrashReportInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// A crash can happen before a registration is even approved (e.g. during onboarding), so this
// allows a pending sub too -- otherwise the exact crashes most worth knowing about (ones that
// happen to brand new installs) would be the ones this endpoint refuses to accept.
export async function POST(request: Request) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many crash reports. Please wait before trying again.",
    limit: 10,
    request,
    routeKey: "devices:crash-report",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const supabase = getSupabaseAdminClient();
  const deviceAuth = await requireAuthenticatedDevice(request, supabase, { allowPendingSub: true });

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const bodyResult = await readJsonBody<CrashReportInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateCrashReportInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  const { error } = await supabase.from("crash_reports").insert({
    app_version_code: validation.data.appVersionCode ?? null,
    app_version_name: validation.data.appVersionName ?? null,
    device_id: deviceAuth.device.id,
    device_model: validation.data.deviceModel ?? null,
    exception_summary: validation.data.exceptionSummary,
    os_version: validation.data.osVersion ?? null,
    platform: "android",
    stack_trace: validation.data.stackTrace ?? null,
    sub_id: deviceAuth.device.subId,
  });

  if (error) {
    return jsonSupabaseError("Failed to store crash report.", error);
  }

  return jsonOk({ ok: true });
}
