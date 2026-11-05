import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), fetch: vi.fn(), limit: vi.fn(), q: {
  select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(), single: vi.fn(), update: vi.fn(),
} }));
vi.mock("./supabase-admin", () => ({ getSupabaseAdminClient: () => ({ rpc: m.rpc, from: m.from }) }));
vi.mock("./rate-limit", () => ({ enforceRateLimit: m.limit }));
const secret = "plock_" + "a".repeat(43), licenseId = "30000000-0000-4000-8000-000000000001";
const code = "PLCK-1234-5678-ABCD-EFGH";
const input = { deviceName: "Phone", username: "owner", deviceSecret: secret };
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubEnv("LOCK_CODE_REGISTRATION_ENABLED", "true");
  vi.stubEnv("PRINCIPESSA_LOCK_LICENSE_BRIDGE_SECRET", "server-only-test-bridge-secret-32-chars");
  vi.stubEnv("VAULT_MISTRESS_BASE_URL", "https://vault.example");
  vi.stubGlobal("fetch", m.fetch);
  m.limit.mockResolvedValue(null); m.from.mockReturnValue(m.q);
  for (const fn of [m.q.select, m.q.eq, m.q.update]) fn.mockReturnValue(m.q);
  m.fetch.mockResolvedValue(Response.json({ ok: true, licenseId, status: "active" }));
  m.rpc.mockResolvedValue({ data: { deviceId: "device", subId: "sub", username: "owner" }, error: null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("normalizes codes without accepting arbitrary input", async () => {
  const { normalizeAccessCode } = await import("./access-licenses");
  expect(normalizeAccessCode(" plck-1234-5678-abcd-efgh \n")).toBe(code);
  for (const value of [null, {}, "a", "<script>example</script>", "x".repeat(81)]) expect(normalizeAccessCode(value)).toBeNull();
});
it("only the hash crosses the Vault bridge and plaintext credentials are not passed to the database RPC", async () => {
  const { registerWithAccessCode } = await import("./access-licenses");
  const response = await registerWithAccessCode(input, code);
  expect(response.status).toBe(201);
  expect(JSON.stringify(m.rpc.mock.calls)).not.toContain(secret);
  const outbound = JSON.parse(m.fetch.mock.calls[0][1].body);
  expect(outbound.credentialHash).toMatch(/^[a-f0-9]{64}$/);
  expect(outbound.deviceSecret).toBeUndefined();
  expect(m.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer server-only-test-bridge-secret-32-chars");
  expect((await response.json()).device.deviceSecret).toBe(secret);
});
it("code activation accepts just device name and code and creates a stable internal handle", async () => {
  const { automaticAccessUsername } = await import("./access-licenses");
  const { POST } = await import("@/app/api/register/route");
  const response = await POST(new Request("https://lock.example/api/register", { method: "POST", body: JSON.stringify({
    ...input, username: undefined, activationCode: code,
  }) }));
  expect(response.status).toBe(201);
  expect(m.rpc.mock.calls[0][1].p_details.username).toBe(automaticAccessUsername(input.deviceName, secret));
  expect(automaticAccessUsername(input.deviceName, secret)).toMatch(/^[a-z0-9_]{3,20}$/);
  expect(automaticAccessUsername("Telefon \u2764", secret)).toMatch(/^[a-z0-9_]{3,20}$/);
  expect(automaticAccessUsername("\u2764", secret)).toMatch(/^[a-z0-9_]{3,20}$/);
  expect(automaticAccessUsername(input.deviceName, secret)).not.toBe(automaticAccessUsername(input.deviceName, secret + "other"));
});
it("legacy clients retain their chosen username", async () => {
  const { registerWithAccessCode } = await import("./access-licenses");
  await registerWithAccessCode(input, code);
  expect(m.rpc.mock.calls[0][1].p_details.username).toBe("owner");
});
it("an internal handle collision is retried without another claim or a user-visible username field", async () => {
  m.rpc.mockResolvedValueOnce({ data: null, error: { code: "23505", message: 'duplicate key violates constraint "subs_username_lower_key"' } });
  const { registerWithAccessCode } = await import("./access-licenses");
  expect((await registerWithAccessCode({ ...input, username: undefined }, code)).status).toBe(201);
  expect(m.rpc).toHaveBeenCalledTimes(2);
  expect(m.fetch).toHaveBeenCalledTimes(1);
  expect(m.rpc.mock.calls[0][1].p_details.username).not.toBe(m.rpc.mock.calls[1][1].p_details.username);
});
it("a device name collision is not hidden or repeatedly retried", async () => {
  m.rpc.mockResolvedValue({ data: null, error: { code: "23505", message: 'duplicate key violates constraint "devices_device_name_lower_key"' } });
  const { registerWithAccessCode } = await import("./access-licenses");
  const response = await registerWithAccessCode({ ...input, username: undefined }, code);
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("device name");
  expect(m.rpc).toHaveBeenCalledTimes(1);
});
it.each(["offline", "malformed", "unauthorized"])("%s bridge errors fail temporarily, never create accounts or revoke access", async mode => {
  if (mode === "offline") m.fetch.mockRejectedValue(new TypeError("network unavailable"));
  if (mode === "malformed") m.fetch.mockResolvedValue(Response.json({ ok: true, status: "active" }));
  if (mode === "unauthorized") m.fetch.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
  const { registerWithAccessCode } = await import("./access-licenses");
  expect((await registerWithAccessCode(input, code)).status).toBe(503);
  expect(m.rpc).not.toHaveBeenCalled(); expect(m.q.update).not.toHaveBeenCalled();
});
it("missing bridge configuration is not treated as a bad user credential", async () => {
  vi.stubEnv("PRINCIPESSA_LOCK_LICENSE_BRIDGE_SECRET", "");
  const { registerWithAccessCode } = await import("./access-licenses");
  expect((await registerWithAccessCode(input, code)).status).toBe(503);
  expect(m.fetch).not.toHaveBeenCalled();
});
it("a mismatched bridge receipt cannot validate or revoke a different license", async () => {
  const { exchangeAccessLicense } = await import("./access-licenses");
  await expect(exchangeAccessLicense({ action: "sync", licenseId: "40000000-0000-4000-8000-000000000001" }))
    .rejects.toMatchObject({ status: 503, reason: "unavailable" });
});
it("code registration is gated; new registrations require a code once enabled", async () => {
  const { POST } = await import("@/app/api/register/route");
  const req = (activationCode?: string) => new Request("https://lock.example/api/register", { method: "POST", body: JSON.stringify({ ...input, activationCode }) });
  expect((await POST(req())).status).toBe(400);
  vi.stubEnv("LOCK_CODE_REGISTRATION_ENABLED", "false");
  expect((await POST(req(code))).status).toBe(503);
  expect(m.rpc).not.toHaveBeenCalled();
});
it("authenticated legacy checks deduplicate concurrent verification and cache successful checks", async () => {
  m.q.maybeSingle.mockResolvedValueOnce({ data: { id: licenseId, current_device_id: "phone", current_sub_id: "sub", source: "legacy", legacy_sub_id: "sub", status: "active", revision: 0, last_validated_at: null }, error: null })
    .mockResolvedValueOnce({ data: { id: licenseId }, error: null });
  m.q.single.mockResolvedValue({ data: { username: "owner", device_name: "Phone" }, error: null });
  const { verifyAccessLicense } = await import("./access-licenses");
  await Promise.all([verifyAccessLicense("sub", "phone"), verifyAccessLicense("sub", "phone")]);
  await verifyAccessLicense("sub", "phone");
  expect(m.fetch).toHaveBeenCalledTimes(1);
});
it("a provider outage during verification cannot write revoked state", async () => {
  m.q.maybeSingle.mockResolvedValue({ data: { id: licenseId, current_device_id: "phone", current_sub_id: "sub", status: "active", revision: 0 }, error: null });
  m.q.single.mockResolvedValue({ data: { username: "owner", device_name: "Phone" }, error: null });
  m.fetch.mockRejectedValue(new Error("offline"));
  const { verifyAccessLicense } = await import("./access-licenses");
  await expect(verifyAccessLicense("sub", "phone")).rejects.toThrow();
  expect(m.q.update).not.toHaveBeenCalled();
});
it("positive central revocation returns 403 and is saved without changing the device secret", async () => {
  m.q.maybeSingle.mockResolvedValueOnce({ data: { id: licenseId, current_device_id: "phone", current_sub_id: "sub", status: "active", revision: 0 }, error: null })
    .mockResolvedValueOnce({ data: { id: licenseId }, error: null });
  m.q.single.mockResolvedValue({ data: { username: "owner", device_name: "Phone" }, error: null });
  m.fetch.mockResolvedValue(Response.json({ ok: true, licenseId, status: "revoked" }));
  const { verifyAccessLicense } = await import("./access-licenses");
  await expect(verifyAccessLicense("sub", "phone")).rejects.toMatchObject({ status: 403, reason: "revoked" });
  expect(m.q.update).toHaveBeenCalledWith(expect.objectContaining({ status: "revoked" }));
  expect(JSON.stringify(m.q.update.mock.calls)).not.toContain("device_secret");
});
