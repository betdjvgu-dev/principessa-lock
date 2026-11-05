import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ verify: vi.fn(), q: { select: vi.fn(), eq: vi.fn(), gt: vi.fn(), maybeSingle: vi.fn(), returns: vi.fn() }, from: vi.fn(), rpc: vi.fn() }));
vi.mock("./supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: m.from, rpc: m.rpc }) }));
vi.mock("./access-licenses", async original => ({ ...await original<typeof import("./access-licenses")>(), verifyAccessLicense: m.verify }));
import { AccessLicenseError, automaticAccessUsername } from "./access-licenses";
import { requireAuthenticatedDevice } from "./device-auth";
import { GET } from "@/app/api/sessions/[id]/route";
const secret = "plock_" + "x".repeat(43);
const request = () => new Request("https://lock.test/api/sessions/session", { headers: { Authorization: `Bearer ${secret}` } });
const device = { id: "phone", device_name: "Phone", device_secret_hash: "hash", sub_id: "sub", access_revoked_at: null, subs: { status: "active" } };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("LOCK_CODE_REGISTRATION_ENABLED", "true");
  m.from.mockReturnValue(m.q);
  for (const f of [m.q.select, m.q.eq, m.q.gt]) f.mockReturnValue(m.q);
  m.q.maybeSingle.mockResolvedValue({ data: device, error: null });
  m.q.returns.mockResolvedValue({ data: [], error: null });
  m.rpc.mockResolvedValue({ data: 0, error: null });
  m.verify.mockRejectedValue(new AccessLicenseError("revoked", 403));
});
afterEach(() => vi.unstubAllEnvs());
it("a verified device receives a typed revocation, but an invalid bearer never does", async () => {
  let auth = await requireAuthenticatedDevice(request());
  expect(auth.ok).toBe(false);
  if (!auth.ok) expect((await auth.response.json()).details).toEqual({ code: "ACCESS_LICENSE_REVOKED", deviceId: "phone" });
  m.q.maybeSingle.mockResolvedValue({ data: null, error: null });
  auth = await requireAuthenticatedDevice(request());
  if (!auth.ok) { expect(auth.response.status).toBe(401); expect((await auth.response.json()).details).toBeUndefined(); }
});
it("old clients can still fetch their existing session as revoked after license cancellation", async () => {
  m.q.maybeSingle.mockResolvedValueOnce({ data: device, error: null })
    .mockResolvedValueOnce({ data: { id: "session", device_id: "phone" }, error: null })
    .mockResolvedValueOnce({ data: { id: "session", device_id: "phone", status: "active", daily_limit_minutes: 30 }, error: null });
  const response = await GET(request(), { params: Promise.resolve({ id: "session" }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "revoked", accessRevoked: true, deviceId: "phone" });
  expect(m.verify).toHaveBeenCalledWith("sub", "phone", true);
});
it("revocation cleanup never bypasses session ownership", async () => {
  m.q.maybeSingle.mockResolvedValueOnce({ data: device, error: null })
    .mockResolvedValueOnce({ data: { id: "session", device_id: "another-phone" }, error: null });
  const response = await GET(request(), { params: Promise.resolve({ id: "session" }) });
  expect(response.status).toBe(403);
  expect((await response.json()).details).toBeUndefined();
});
it("database/provider failures have no revocation marker", async () => {
  m.verify.mockRejectedValue(new AccessLicenseError("unavailable"));
  const result = await requireAuthenticatedDevice(request());
  if (!result.ok) { expect(result.response.status).toBe(503); expect((await result.response.json()).details).toBeUndefined(); }
});
it("only a proven automatically generated, unchanged label is repaired", async () => {
  m.verify.mockResolvedValue(undefined);
  const name = automaticAccessUsername("Phone", secret);
  m.q.maybeSingle.mockResolvedValue({ data: { ...device, subs: { status: "active", username: name, label: name } }, error: null });
  expect((await requireAuthenticatedDevice(request())).ok).toBe(true);
  expect(m.rpc).toHaveBeenCalledWith("repair_lock_generated_label", { p_device: "phone", p_username: name });
  m.rpc.mockClear();
  m.q.maybeSingle.mockResolvedValue({ data: { ...device, subs: { status: "active", username: name, label: "Chosen by admin" } }, error: null });
  expect((await requireAuthenticatedDevice(request())).ok).toBe(true);
  expect(m.rpc).not.toHaveBeenCalled();
});
