import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn(), admin: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ rpc: m.rpc }) }));
vi.mock("@/lib/server/admin-auth", () => ({ verifyAdminRequest: m.admin }));
vi.mock("@/lib/server/rate-limit", () => ({ enforceRateLimit: m.limit, enforceAdminRateLimit: m.limit }));
import { POST } from "@/app/api/device-recovery/route";
import { POST as decide } from "@/app/api/admin/device-recovery/[id]/[decision]/route";
import { hashDeviceSecret } from "./device-auth";
const secret = "plock_" + "a".repeat(43);
const body = { deviceName: "Phone", username: "owner", deviceSecret: secret, hardwareIdHash: "b".repeat(64) };
const req = (value: unknown = body) => new Request("http://localhost/api/device-recovery", { method: "POST", body: JSON.stringify(value) });
const id = "20000000-0000-4000-8000-000000000001";
beforeEach(() => { vi.resetAllMocks(); m.limit.mockResolvedValue(null); m.admin.mockResolvedValue({ identity: { id: "admin" } }); });
it("pending requests reveal no identity or credential and SQL receives only hashes", async () => {
  m.rpc.mockResolvedValue({ data: { status: "pending" } });
  const res = await POST(req()); expect(res.status).toBe(409);
  expect(await res.text()).not.toContain(secret);
  expect(m.rpc).toHaveBeenCalledWith("request_device_recovery", { p_hardware: body.hardwareIdHash, p_username: "owner", p_secret_hash: hashDeviceSecret(secret) });
});
it("only approved candidate receives its own secret, never a database secret", async () => {
  m.rpc.mockResolvedValue({ data: { status: "approved", deviceId: id, username: "owner", deviceName: "Phone", sessionId: id } });
  const res = await POST(req()); expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("no-store");
  expect((await res.json()).device).toEqual({ id, deviceSecret: secret });
});
it.each([{}, { ...body, deviceSecret: undefined }, { ...body, hardwareIdHash: "bad" }, { ...body, username: undefined }])("malformed requests never reach SQL", async value => {
  expect((await POST(req(value))).status).toBe(400); expect(m.rpc).not.toHaveBeenCalled();
});
it("rate limiting runs before recovery work", async () => {
  m.limit.mockResolvedValue(new Response(null, { status: 429 })); expect((await POST(req())).status).toBe(429); expect(m.rpc).not.toHaveBeenCalled();
});
it("admin authorization is mandatory", async () => {
  m.admin.mockResolvedValue({ error: new Response(null, { status: 401 }) });
  expect((await decide(req(), { params: Promise.resolve({ id, decision: "approve" }) })).status).toBe(401); expect(m.rpc).not.toHaveBeenCalled();
});
it("approval actor is derived from authenticated admin, not request", async () => {
  m.rpc.mockResolvedValue({ error: null });
  expect((await decide(req(), { params: Promise.resolve({ id, decision: "approve" }) })).status).toBe(200);
  expect(m.rpc).toHaveBeenCalledWith("decide_device_recovery", { p_id: id, p_approve: true, p_actor: "admin:admin" });
});
it("unexpected database errors never leak credential details", async () => {
  m.rpc.mockResolvedValue({ error: { message: secret } });
  const res = await POST(req()); expect(res.status).toBe(503); expect(await res.text()).not.toContain(secret);
});
