import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => {
  const q = { select:vi.fn(),eq:vi.fn(),order:vi.fn(),limit:vi.fn(),in:vi.fn(),maybeSingle:vi.fn(),insert:vi.fn(),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({data:[],error:null}).then(resolve) };
  return { q };
});
vi.mock("./supabase-admin", () => ({getSupabaseAdminClient:()=>({from:()=>m.q})}));
vi.mock("./device-auth",()=>({requireAuthenticatedDevice:async()=>({ok:true,device:{id:"device"}}),verifySessionOwnershipForDevice:async()=>({ok:true})}));
import { POST } from "@/app/api/heartbeat/route";
beforeEach(()=> {
  vi.clearAllMocks();
  for(const method of [m.q.select,m.q.eq,m.q.order,m.q.limit,m.q.in]) method.mockReturnValue(m.q);
  m.q.maybeSingle.mockResolvedValue({data:null,error:null});
});
it("authenticated heartbeat cannot write another device's historical session",async()=> {
  const response = await POST(new Request("http://localhost",{method:"POST",body:JSON.stringify({
    sessionId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",deviceName:"Phone",sessionStatus:"active",protectionState:"active_allowed",
    usageHistory:[{sessionId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",localDate:"2026-01-01",usedMinutes:20,dailyLimitMinutes:90}]
  })}));
  expect(response.status).toBe(403);
  expect(m.q.insert).not.toHaveBeenCalled();
});
