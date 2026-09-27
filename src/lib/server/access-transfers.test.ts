import { beforeEach,expect,it,vi } from "vitest";
const m=vi.hoisted(()=>({admin:vi.fn(),device:vi.fn(),limit:vi.fn(),rpc:vi.fn()}));
vi.mock("@/lib/server/admin-auth",()=>({verifyAdminRequest:m.admin}));
vi.mock("@/lib/server/device-auth",async original=>({...await original<typeof import("./device-auth")>(),requireAuthenticatedDevice:m.device}));
vi.mock("@/lib/server/rate-limit",()=>({enforceRateLimit:m.limit,enforceAdminRateLimit:m.limit}));
vi.mock("@/lib/server/supabase-admin",()=>({getSupabaseAdminClient:()=>({rpc:m.rpc})}));
import {POST as issue} from "@/app/api/access-transfers/code/route";
import {POST as claim} from "@/app/api/access-transfers/claim/route";
import {POST as adminIssue,GET as adminList} from "@/app/api/admin/access-transfers/route";
import {POST as decide} from "@/app/api/admin/access-transfers/[id]/[decision]/route";
import {newTransferCode,normalizeTransferCode,transferCodeHash,transferError} from "./access-transfers";
const id="00000000-0000-4000-8000-000000000001",secret="plock_"+"a".repeat(43);
const input={code:"PLT-"+"A".repeat(48),username:"new_owner",deviceName:"New phone",hardwareIdHash:"b".repeat(64),deviceSecret:secret};
const req=(body:unknown={})=>new Request("http://localhost/api/access-transfers",{method:"POST",body:JSON.stringify(body)});
beforeEach(()=>{vi.resetAllMocks();m.admin.mockResolvedValue({identity:{id:"owner"}});m.device.mockResolvedValue({ok:true,device:{id}});
  m.limit.mockResolvedValue(null);m.rpc.mockResolvedValue({data:{id,expiresAt:"2026-09-29T00:00:00Z"},error:null});});
it("codes contain 192 bits of randomness and only their hashes enter SQL",async()=>{
  const a=newTransferCode(),b=newTransferCode();expect(a).toMatch(/^PLT-[A-F0-9]{48}$/);expect(a).not.toBe(b);
  expect(normalizeTransferCode(` ${a.toLowerCase()} `)).toBe(a);
  const response=await issue(req());const body=await response.json();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(m.rpc).toHaveBeenCalledWith("issue_access_transfer",{p_device:id,p_code_hash:transferCodeHash(body.code),p_actor:`device:${id}`});
  expect(JSON.stringify(m.rpc.mock.calls)).not.toContain(body.code);
});
it("issuing a code requires authenticated approved device",async()=>{
  m.device.mockResolvedValue({ok:false,response:new Response(null,{status:403})});
  expect((await issue(req())).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled();
});
it("public claim is rate-limited before database work",async()=>{
  m.limit.mockResolvedValue(new Response(null,{status:429}));expect((await claim(req(input))).status).toBe(429);expect(m.rpc).not.toHaveBeenCalled();
});
it.each([null,{}, {...input,code:"1234"},{...input,deviceSecret:undefined},{...input,username:undefined},
  {...input,hardwareIdHash:"wrong"},{...input,deviceName:"a".repeat(101)}])("rejects malformed claim without side effects",async(body)=>{
  expect((await claim(req(body))).status).toBe(400);expect(m.rpc).not.toHaveBeenCalled();
});
it.each(['invited','active'])("claim returns only supplied credential and expected %s status",async status=>{
  m.rpc.mockResolvedValue({data:{transferId:id,subId:id,deviceId:id,username:"new_owner",status},error:null});
  const res=await claim(req(input));const body=await res.json();
  expect(res.status).toBe(200);expect(body.device).toEqual({id,deviceSecret:secret});expect(body.status).toBe(status);
  const params=m.rpc.mock.calls[0][1];expect(params.p_code_hash).toBe(transferCodeHash(input.code));
  expect(params.p_input.deviceSecret).toBeUndefined();expect(JSON.stringify(params)).not.toContain(secret);
});
it("all admin operations deny a non-admin before database access",async()=>{
  m.admin.mockResolvedValue({error:new Response(null,{status:401})});
  expect((await adminList(req())).status).toBe(401);expect((await adminIssue(req({sourceDeviceId:id}))).status).toBe(401);
  expect((await decide(req(),{params:Promise.resolve({id,decision:"approve"})})).status).toBe(401);expect(m.rpc).not.toHaveBeenCalled();
});
it("admin issuing validates UUID and attributes identity server-side",async()=>{
  expect((await adminIssue(req({sourceDeviceId:"bad"}))).status).toBe(400);
  await adminIssue(req({sourceDeviceId:id,actor:"forged"}));expect(m.rpc.mock.calls[0][1].p_actor).toBe("admin:owner");
});
it.each(['approve','reject'])("admin %s is one atomic RPC",async decision=>{
  expect((await decide(req(),{params:Promise.resolve({id,decision})})).status).toBe(200);
  expect(m.rpc).toHaveBeenCalledExactlyOnceWith("decide_access_transfer",{p_id:id,p_approve:decision==='approve',p_actor:"admin:owner"});
});
it("invalid decisions never reach database",async()=>{
  expect((await decide(req(),{params:Promise.resolve({id,decision:"activate"})})).status).toBe(400);expect(m.rpc).not.toHaveBeenCalled();
});
it("database errors do not leak hashes, SQL details or successful results",async()=>{
  m.rpc.mockResolvedValue({error:{message:"private hash "+secret,code:"XX000"}});
  const response=await claim(req(input));expect(response.status).toBe(503);expect(await response.text()).not.toContain(secret);
  expect(transferError({message:"transfer_active_session"}).status).toBe(409);
  expect(transferError({message:"transfer_expired"}).status).toBe(409);
});
