import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { jsonError, jsonOk } from "@/lib/server/api-response";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { transferError,transferUuid } from "@/lib/server/access-transfers";
export const dynamic = "force-dynamic";
export async function POST(request:Request,context:{params:Promise<{id:string;decision:string}>}) {
  const auth=await verifyAdminRequest(request); if(auth.error) return auth.error;
  const limited=await enforceAdminRateLimit(request,"access-transfers:decide"); if(limited) return limited;
  const {id,decision}=await context.params;
  if(!transferUuid(id)||!['approve','reject'].includes(decision)) return jsonError(400,"Invalid transfer decision.");
  const {error}=await getSupabaseAdminClient().rpc("decide_access_transfer",{p_id:id,p_approve:decision==='approve',p_actor:`admin:${auth.identity.id}`});
  if(error) return transferError(error);
  return jsonOk({ok:true});
}
