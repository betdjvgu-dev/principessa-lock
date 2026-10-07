import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { transferUuid } from "@/lib/server/access-transfers";
import { recoveryError } from "@/lib/server/device-recovery";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string; decision: string }> }) {
  const auth = await verifyAdminRequest(request);
  if (auth.error) return auth.error;
  const limited = await enforceAdminRateLimit(request, "device:recovery:decide");
  if (limited) return limited;
  const { id, decision } = await context.params;
  if (!transferUuid(id) || !["approve", "reject"].includes(decision)) return jsonError(400, "Invalid recovery decision.");
  const { error } = await getSupabaseAdminClient().rpc("decide_device_recovery", {
    p_id: id, p_approve: decision === "approve", p_actor: `admin:${auth.identity.id}`,
  });
  return error ? recoveryError(error) : jsonOk({ ok: true });
}
