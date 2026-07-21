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

type CrashReportRow = {
  app_version_code: number | null;
  app_version_name: string | null;
  crashed_during_feature: string | null;
  crashed_during_stage: string | null;
  created_at: string;
  device_id: string | null;
  device_model: string | null;
  devices: { device_name: string } | { device_name: string }[] | null;
  exception_summary: string;
  id: string;
  occurred_at: string;
  os_version: string | null;
  platform: string;
  stack_trace: string | null;
  sub_id: string | null;
  subs: { label: string } | { label: string }[] | null;
};

function extractDeviceName(value: CrashReportRow["devices"]) {
  return (Array.isArray(value) ? value[0] : value)?.device_name ?? null;
}

function extractSubLabel(value: CrashReportRow["subs"]) {
  return (Array.isArray(value) ? value[0] : value)?.label ?? null;
}

export async function GET(request: Request) {
  const rateLimitError = await enforceAdminRateLimit(request, "crash-reports:list");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("crash_reports")
    .select(
      "id, device_id, sub_id, platform, app_version_code, app_version_name, device_model, os_version, exception_summary, stack_trace, occurred_at, created_at, crashed_during_feature, crashed_during_stage, devices(device_name), subs(label)",
    )
    .order("created_at", { ascending: false })
    .limit(100)
    .returns<CrashReportRow[]>();

  if (error) {
    return jsonSupabaseError("Failed to load crash reports.", error);
  }

  return jsonOk({
    ok: true,
    reports: (data ?? []).map((row) => ({
      appVersionCode: row.app_version_code,
      appVersionName: row.app_version_name,
      crashedDuringFeature: row.crashed_during_feature,
      crashedDuringStage: row.crashed_during_stage,
      createdAt: row.created_at,
      deviceModel: row.device_model,
      deviceName: extractDeviceName(row.devices),
      exceptionSummary: row.exception_summary,
      id: row.id,
      occurredAt: row.occurred_at,
      osVersion: row.os_version,
      platform: row.platform,
      stackTrace: row.stack_trace,
      subLabel: extractSubLabel(row.subs),
    })),
  });
}
