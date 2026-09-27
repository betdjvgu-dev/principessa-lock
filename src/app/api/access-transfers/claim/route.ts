import { jsonError, jsonOk } from "@/lib/server/api-response";
import { hashDeviceSecret } from "@/lib/server/device-auth";
import { normalizeTransferCode, transferCodeHash, transferError } from "@/lib/server/access-transfers";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody, validateRegisterInput } from "@/lib/server/request-validation";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const limited = await enforceRateLimit({request,routeKey:"transfer:claim",limit:10,windowMs:15*60*1000,
    errorMessage:"Too many transfer attempts. Please wait."});
  if (limited) return limited;
  const body = await readJsonBody<Record<string,unknown>>(request);
  if (!body.ok) return body.response;
  const code = normalizeTransferCode(body.data?.code);
  if (!code) return jsonError(400,"Enter a valid transfer code.");
  const input = validateRegisterInput(body.data);
  if (!input.ok) return input.response;
  const { deviceSecret, ...details } = input.data;
  if (!details.username || !deviceSecret || !/^[0-9a-fA-F]{64}$/.test(details.hardwareIdHash ?? "") || details.deviceName.length>100) {
    return jsonError(400,"Username, device identity and a secure device credential are required.");
  }
  const { data,error } = await getSupabaseAdminClient().rpc("claim_access_transfer", {
    p_code_hash: transferCodeHash(code), p_secret_hash: hashDeviceSecret(deviceSecret), p_input: details,
  });
  if (error) return transferError(error);
  return jsonOk({ok:true,transferId:data.transferId,subId:data.subId,username:data.username,status:data.status,
    device:{id:data.deviceId,deviceSecret}}, {headers:{"Cache-Control":"no-store"}});
}
