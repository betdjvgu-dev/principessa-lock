import { requireAuthenticatedDevice } from "@/lib/server/device-auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { issueTransfer } from "@/lib/server/access-transfers";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const limited = await enforceRateLimit({request,routeKey:"transfer:issue",limit:5,windowMs:15*60*1000,
    errorMessage:"Too many transfer code requests. Please wait."});
  if (limited) return limited;
  const auth = await requireAuthenticatedDevice(request);
  if (!auth.ok) return auth.response;
  return issueTransfer(auth.device.id, `device:${auth.device.id}`);
}
