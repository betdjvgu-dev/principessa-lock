import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateSessionMessageInput, type SessionMessageInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

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
  const rateLimitError = await enforceAdminRateLimit(request, "sessions:messages:list");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
  }

  const { id } = await context.params;

  if (!id.trim()) {
    return jsonError(400, "Session id is required.");
  }

  const supabase = getSupabaseAdminClient();
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
    .eq("sender", "sub")
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
  const rateLimitError = await enforceAdminRateLimit(request, "sessions:messages:create");

  if (rateLimitError) {
    return rateLimitError;
  }

  const auth = await verifyAdminRequest(request);

  if (auth.error) {
    return auth.error;
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
  const { data: session, error: loadError } = await supabase
    .from("sessions")
    .select("id, sub_id")
    .eq("id", id)
    .maybeSingle<{ id: string; sub_id: string | null }>();

  if (loadError) {
    return jsonSupabaseError("Failed to load session.", loadError);
  }

  if (!session) {
    return jsonError(404, "Session not found.");
  }

  const { data: message, error } = await supabase
    .from("session_messages")
    .insert({
      body: validation.data.body,
      sender: "admin",
      session_id: id,
      sub_id: session.sub_id,
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
