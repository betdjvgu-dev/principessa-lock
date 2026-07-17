import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice, verifySessionOwnershipForDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateAppUnlockRequestInput, type AppUnlockRequestInput } from "@/lib/server/request-validation";
import { calculateAppUnlockPriceUsd } from "@/lib/server/session-pricing";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

// Every route here talks to Supabase via fetch() under the hood, which Next.js's Route
// Handler caching can silently memoize even though these are always meant to be live reads
// -- observed firsthand as an admin dashboard endpoint intermittently returning a stale/empty
// snapshot until a later request happened to bypass the cache. force-dynamic opts every
// request here out of that cache entirely.
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type SessionRow = {
  blocked_packages: string[];
  ends_at: string;
  session_days: number;
  status: string;
};

type UnlockRequestRow = {
  approved_at: string | null;
  created_at: string;
  expires_at: string | null;
  id: string;
  package_name: string;
  price_usd: number;
  rejected_at: string | null;
  status: string;
};

export async function POST(request: Request, context: RouteContext) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many unlock requests. Please wait before trying again.",
    limit: 10,
    request,
    routeKey: "unlock-requests:create",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Session id is required.");
  }

  const supabase = getSupabaseAdminClient();
  const deviceAuth = await requireAuthenticatedDevice(request, supabase);

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const sessionOwnership = await verifySessionOwnershipForDevice({
    authenticatedDeviceId: deviceAuth.device.id,
    sessionId: id,
    suppliedSupabase: supabase,
  });

  if (!sessionOwnership.ok) {
    return sessionOwnership.response;
  }

  const bodyResult = await readJsonBody<AppUnlockRequestInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateAppUnlockRequestInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
  }

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("session_days, blocked_packages, ends_at, status")
    .eq("id", id)
    .maybeSingle<SessionRow>();

  if (sessionError) {
    return jsonSupabaseError("Failed to load session.", sessionError);
  }

  if (!session) {
    return jsonError(404, "Session not found.");
  }

  if (session.status !== "active") {
    return jsonError(409, "Session is not active.");
  }

  if (!session.blocked_packages.includes(validation.data.packageName)) {
    return jsonError(400, "That app is not currently blocked.");
  }

  const nowIso = new Date().toISOString();
  const { data: existing, error: existingError } = await supabase
    .from("app_unlock_requests")
    .select("id, status, expires_at")
    .eq("session_id", id)
    .eq("package_name", validation.data.packageName)
    .in("status", ["pending", "approved"])
    .returns<{ id: string; status: string; expires_at: string | null }[]>();

  if (existingError) {
    return jsonSupabaseError("Failed to check existing unlock requests.", existingError);
  }

  const hasActiveOrPendingRequest = (existing ?? []).some(
    (row) => row.status === "pending" || (row.status === "approved" && row.expires_at && row.expires_at > nowIso),
  );

  if (hasActiveOrPendingRequest) {
    return jsonError(409, "An unlock request for this app is already pending or active.");
  }

  // Priced (and charged) at the moment the sub requests it, not at approval time -- the sub needs
  // to know the real price before deciding whether it's worth asking for, and shouldn't end up
  // owing more or less than what they saw just because the keyholder took a while to approve it.
  const priceUsd = calculateAppUnlockPriceUsd(new Date(session.ends_at).getTime() - Date.now());

  const { data: created, error: insertError } = await supabase
    .from("app_unlock_requests")
    .insert({
      device_id: deviceAuth.device.id,
      package_name: validation.data.packageName,
      price_usd: priceUsd,
      session_id: id,
      sub_id: deviceAuth.device.subId,
    })
    .select("id, package_name, status, price_usd, requested_at, approved_at, rejected_at, expires_at, created_at")
    .single<UnlockRequestRow & { requested_at: string }>();

  if (insertError) {
    return jsonSupabaseError("Failed to create unlock request.", insertError);
  }

  return jsonOk(
    {
      ok: true,
      request: {
        approvedAt: created.approved_at,
        createdAt: created.created_at,
        expiresAt: created.expires_at,
        id: created.id,
        packageName: created.package_name,
        priceUsd: created.price_usd,
        rejectedAt: created.rejected_at,
        status: created.status,
      },
    },
    { status: 201 },
  );
}

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Session id is required.");
  }

  const supabase = getSupabaseAdminClient();
  const deviceAuth = await requireAuthenticatedDevice(request, supabase);

  if (!deviceAuth.ok) {
    return deviceAuth.response;
  }

  const sessionOwnership = await verifySessionOwnershipForDevice({
    authenticatedDeviceId: deviceAuth.device.id,
    sessionId: id,
    suppliedSupabase: supabase,
  });

  if (!sessionOwnership.ok) {
    return sessionOwnership.response;
  }

  const { data, error } = await supabase
    .from("app_unlock_requests")
    .select("id, package_name, status, price_usd, requested_at, approved_at, rejected_at, expires_at, created_at")
    .eq("session_id", id)
    .order("created_at", { ascending: false })
    .returns<(UnlockRequestRow & { requested_at: string })[]>();

  if (error) {
    return jsonSupabaseError("Failed to load unlock requests.", error);
  }

  return jsonOk({
    ok: true,
    requests: (data ?? []).map((row) => ({
      approvedAt: row.approved_at,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      id: row.id,
      packageName: row.package_name,
      priceUsd: row.price_usd,
      rejectedAt: row.rejected_at,
      status: row.status,
    })),
  });
}
