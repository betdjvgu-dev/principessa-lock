import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { jsonSupabaseError } from "@/lib/server/supabase-errors";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const auth = await verifyAdminRequest(request);
  if (auth.error) return auth.error;
  const limited = await enforceAdminRateLimit(request, "subs:reject-all");
  if (limited) return limited;
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError(400, "Invalid JSON body."); }
  const ids = body && typeof body === "object" && "ids" in body ? body.ids : null;
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 ||
      ids.some(id => typeof id !== "string" || !UUID.test(id))) {
    return jsonError(400, "Provide between 1 and 1000 valid registration ids.");
  }
  // Snapshot-scoped delete: concurrent approvals and new requests are protected.
  const { data, error } = await getSupabaseAdminClient().from("subs")
    .delete().in("id", [...new Set(ids)]).eq("status", "invited").select("id");
  if (error) return jsonSupabaseError("Failed to reject pending access requests.", error);
  return jsonOk({ ok: true, rejectedIds: (data ?? []).map(row => row.id) });
}
