import { beforeEach, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({q:{select:vi.fn(),eq:vi.fn(),maybeSingle:vi.fn(),update:vi.fn()},limit:vi.fn(),push:vi.fn(),auth:vi.fn()}));
vi.mock("@/lib/server/rate-limit",()=>({enforceRateLimit:m.limit}));
vi.mock("@/lib/server/supabase-admin",()=>({getSupabaseAdminClient:()=>({from:()=>m.q})}));
vi.mock("@/lib/server/fcm",()=>({sendNewRegistrationPush:m.push}));
vi.mock("@/lib/server/device-auth",async original=>({...await original<typeof import("./device-auth")>(),requireAuthenticatedDevice:m.auth}));
import { POST, GET } from "@/app/api/register/route";
import { hashDeviceSecret } from "./device-auth";
const secret="plock_"+"a".repeat(43);
const row={id:"device",sub_id:"sub",access_revoked_at:null,transfer_protected:true,device_secret_hash:hashDeviceSecret(secret),subs:{status:"active",username:"owner",access_transfer_id:"transfer"}};
const req=(deviceSecret?:string)=>new Request("http://localhost/api/register",{method:"POST",body:JSON.stringify({deviceName:"Phone",username:"owner",hardwareIdHash:"b".repeat(64),deviceSecret})});
beforeEach(()=>{vi.resetAllMocks();m.limit.mockResolvedValue(null);m.q.select.mockReturnValue(m.q);m.q.eq.mockReturnValue(m.q);m.q.update.mockReturnValue(m.q);m.q.maybeSingle.mockResolvedValue({data:row,error:null});});
it.each([undefined,"plock_"+"z".repeat(43)])("hardware ID cannot recover transferred access without original secret",async value=>{
  expect((await POST(req(value))).status).toBe(403);expect(m.q.update).not.toHaveBeenCalled();
});
it("even the former correct secret cannot recover a revoked source",async()=>{
  m.q.maybeSingle.mockResolvedValue({data:{...row,access_revoked_at:"2026-09-28T00:00:00Z",subs:{status:"archived"}},error:null});
  expect((await POST(req(secret))).status).toBe(403);expect(m.q.update).not.toHaveBeenCalled();
});
it("an archived pending recipient cannot recover access",async()=>{
  m.q.maybeSingle.mockResolvedValue({data:{...row,subs:{status:"archived"}},error:null});
  expect((await POST(req(secret))).status).toBe(403);expect(m.q.update).not.toHaveBeenCalled();
});
it("an expired pending transfer leaves the waiting state without granting access",async()=>{
  m.auth.mockResolvedValue({ok:true,device:{id:"device",subId:"sub"}});
  m.q.maybeSingle.mockReset().mockResolvedValueOnce({data:{status:"invited",access_transfer_id:"transfer"},error:null})
    .mockResolvedValueOnce({data:{status:"pending",expires_at:"2000-01-01T00:00:00Z"},error:null});
  expect(await(await GET(req())).json()).toEqual({ok:true,status:"archived",transferStatus:"expired"});
});
it("an approval remains active after the original code expiry",async()=>{
  m.auth.mockResolvedValue({ok:true,device:{id:"device",subId:"sub"}});
  m.q.maybeSingle.mockResolvedValue({data:{status:"active",access_transfer_id:"transfer"},error:null});
  expect(await(await GET(req())).json()).toEqual({ok:true,status:"active"});
  expect(m.q.maybeSingle).toHaveBeenCalledTimes(1);
});
