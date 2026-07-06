import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type SessionRow = {
  id: string;
  status: string;
};

export async function POST(request: Request, context: RouteContext) {
  const authError = verifyAdminRequest(request);

  if (authError) {
    return authError;
  }

  const { id } = await context.params;
  const supabase = getSupabaseAdminClient();
  const { data: session, error: loadError } = await supabase
    .from("sessions")
    .select("id, status")
    .eq("id", id)
    .maybeSingle<SessionRow>();

  if (loadError) {
    return jsonSupabaseError("Failed to load session.", loadError);
  }

  if (!session) {
    return jsonError(404, "Session not found.");
  }

  if (session.status !== "active") {
    return jsonError(409, "Only active sessions can be canceled.");
  }

  const { data: updatedSession, error: updateError } = await supabase
    .from("sessions")
    .update({
      ends_at: new Date().toISOString(),
      status: "revoked",
    })
    .eq("id", id)
    .eq("status", "active")
    .select("id, status")
    .maybeSingle<SessionRow>();

  if (updateError) {
    return jsonSupabaseError("Failed to cancel session.", updateError);
  }

  if (!updatedSession) {
    return jsonError(409, "Session is no longer active.");
  }

  return jsonOk({
    ok: true,
    session: {
      id: updatedSession.id,
      status: updatedSession.status,
    },
  });
}
