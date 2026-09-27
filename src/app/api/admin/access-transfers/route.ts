import { jsonError, jsonOk } from "@/lib/server/api-response";
import { verifyAdminRequest } from "@/lib/server/admin-auth";
import { enforceAdminRateLimit } from "@/lib/server/rate-limit";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { readJsonBody } from "@/lib/server/request-validation";
import { issueTransfer,transferUuid,transferError } from "@/lib/server/access-transfers";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await verifyAdminRequest(request); if(auth.error) return auth.error;
  const limited=await enforceAdminRateLimit(request,"access-transfers:list"); if(limited) return limited;
  const db=getSupabaseAdminClient();
  const transfers=await db.from("access_transfers").select("id,status,source_sub_id,source_device_id,target_sub_id,target_device_id,created_at,expires_at,requested_at,decided_at,source_username,source_device_name,target_username,target_device_name").order("created_at",{ascending:false}).limit(100);
  if(transfers.error) return transferError(transfers.error);
  const events=await db.from("access_transfer_events").select("id,transfer_id,event_type,actor,created_at").order("created_at",{ascending:false}).limit(200);
  if(events.error) return transferError(events.error);
  const sources=await db.from("devices").select("id,sub_id,device_name,subs!inner(username,status)").is("access_revoked_at",null).eq("subs.status","active").order("created_at",{ascending:false}).limit(1000);
  if(sources.error) return transferError(sources.error);
  return jsonOk({ok:true,transfers:(transfers.data??[]).map(t=>({...t,
    status:['issued','pending'].includes(t.status)&&Date.parse(t.expires_at)<=Date.now()?'expired':t.status})),events:events.data??[],
    eligibleSources:(sources.data??[]).map(d=>({id:d.id,sub_id:d.sub_id,device_name:d.device_name,
      username:(Array.isArray(d.subs)?d.subs[0]:d.subs)?.username??null}))}, {headers:{"Cache-Control":"no-store"}});
}
export async function POST(request: Request) {
  const auth=await verifyAdminRequest(request); if(auth.error) return auth.error;
  const limited=await enforceAdminRateLimit(request,"access-transfers:issue"); if(limited) return limited;
  const body=await readJsonBody<{sourceDeviceId?:unknown}>(request); if(!body.ok) return body.response;
  if(!transferUuid(body.data?.sourceDeviceId)) return jsonError(400,"A valid sourceDeviceId is required.");
  return issueTransfer(body.data.sourceDeviceId,`admin:${auth.identity.id}`);
}
