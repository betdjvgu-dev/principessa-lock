import { jsonError, jsonOk } from "@/lib/server/api-response";
import { requireAuthenticatedDevice, verifySessionOwnershipForDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateSessionMessageInput, type SessionMessageInput } from "@/lib/server/request-validation";
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

type MessageRow = {
  body: string;
  created_at: string;
  id: string;
  sender: string;
};

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
    .from("session_messages")
    .select("id, sender, body, created_at")
    .eq("session_id", id)
    .order("created_at", { ascending: true })
    .limit(100)
    .returns<MessageRow[]>();

  if (error) {
    return jsonSupabaseError("Failed to load messages.", error);
  }

  await supabase
    .from("session_messages")
    .update({ read_at: new Date().toISOString() })
    .eq("session_id", id)
    .eq("sender", "admin")
    .is("read_at", null);

  return jsonOk({
    ok: true,
    messages: (data ?? []).map((row) => ({
      id: row.id,
      sender: row.sender,
      body: row.body,
      createdAt: row.created_at,
    })),
  });
}

export async function POST(request: Request, context: RouteContext) {
  const rateLimitError = await enforceRateLimit({
    errorMessage: "Too many messages sent. Please wait before trying again.",
    limit: 20,
    request,
    routeKey: "sessions:messages:create",
    windowMs: 15 * 60 * 1000,
  });

  if (rateLimitError) {
    return rateLimitError;
  }

  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Session id is required.");
  }

  const bodyResult = await readJsonBody<SessionMessageInput>(request);

  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const validation = validateSessionMessageInput(bodyResult.data);

  if (!validation.ok) {
    return validation.response;
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

  const { data: message, error } = await supabase
    .from("session_messages")
    .insert({
      body: validation.data.body,
      sender: "sub",
      session_id: id,
      sub_id: deviceAuth.device.subId,
    })
    .select("id, sender, body, created_at")
    .maybeSingle<MessageRow>();

  if (error) {
    return jsonSupabaseError("Failed to send message.", error);
  }

  if (!message) {
    return jsonError(500, "Message was not created.");
  }

  return jsonOk(
    {
      ok: true,
      message: {
        id: message.id,
        sender: message.sender,
        body: message.body,
        createdAt: message.created_at,
      },
    },
    { status: 201 },
  );
}
