import { expect, it, vi, beforeEach } from "vitest";
const m = vi.hoisted(() => ({ results: [] as unknown[], rpc: vi.fn() }));
vi.mock("@/lib/server/rate-limit", () => ({ enforceRateLimit: async () => null }));
vi.mock("@/lib/server/device-auth", () => ({ requireAuthenticatedDevice: async () => ({ ok:true, device:{id:"phone"} }) }));
vi.mock("@/lib/server/session-activation-notification", () => ({ notifyAdminSessionActivated: async () => {} }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({
  rpc:m.rpc, from:() => {
    const q:Record<string,unknown> = {};
    for (const key of ["select","eq","order","limit","maybeSingle","update"]) q[key]=()=>q;
    q.then=(resolve:(v:unknown)=>void)=>Promise.resolve(m.results.shift()).then(resolve);
    return q;
  }
}) }));
import { GET, POST } from "@/app/api/activate/route";
import { ownSessionRequest, type OwnSessionRequestRow } from "./own-session-request";
const send = () => POST(new Request("https://example.test/api/activate", {method:"POST", body:JSON.stringify({})}));
const row = {id:"previous", device_id:"phone",status:"active",activated_at:"2025-01-01",updated_at:"2025-01-01",starts_at:"2025-01-01",ends_at:"2025-01-02",paused_at:null};
beforeEach(()=>{m.results.length=0; m.rpc.mockReset();});
const restore = () => GET(new Request("https://example.test/api/activate?requestId=20000000-0000-4000-8000-000000000001"));
it("automatic restore without a matching session does not activate an outstanding approval",async()=>{
  m.results.push({data:null});
  m.rpc.mockResolvedValue({data:{session:{...row,id:"new-session"},created:true}});
  expect((await restore()).status).toBe(410);
  expect(m.rpc).not.toHaveBeenCalled();
});
it("restore must not return a past-ended unpaused session as successful",async()=>{
  m.results.push({data:null},{data:row});
  expect((await send()).status).not.toBe(200);
});
it("an approval with no expiry should not be advertised as ready when activation cannot accept it",async()=>{
  const legacy = {id:"legacy",status:"approved",activation_code_expires_at:null};
  m.results.push({data:legacy},{data:null});
  expect((await send()).status).toBe(410);
  expect(ownSessionRequest(legacy as OwnSessionRequestRow).status).not.toBe("approved");
});
it("a recently paused session remains restorable past its nominal end, without activating anything", async () => {
  m.results.push({data:{...row,paused_at:new Date().toISOString()}});
  expect(await (await restore()).json()).toEqual({ok:true,sessionId:row.id});
  expect(m.rpc).not.toHaveBeenCalled();
});
it.each([{...row,status:"revoked"},{...row,paused_at:"2025-01-01"},row])("ended or overdue paused rows cannot restore", async data => {
  m.results.push({data});
  expect((await restore()).status).toBe(410);
});
