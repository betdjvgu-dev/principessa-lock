import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ exchange: vi.fn(), rpc: vi.fn() }));
vi.mock("./supabase-admin", () => ({ getSupabaseAdminClient: () => ({ rpc: m.rpc }) }));
vi.mock("./access-licenses", async original => ({ ...await original<typeof import("./access-licenses")>(), exchangeAccessLicense: m.exchange }));
import { resetIncompleteActivation } from "./incomplete-activation";
import { POST } from "@/app/api/internal/access-license-recovery/route";
const licenseId = "30000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64), token = "bridge-only-test-secret-32-characters";
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("PRINCIPESSA_LOCK_LICENSE_BRIDGE_SECRET", token);
  m.exchange.mockResolvedValue({ licenseId, status: "active", credentialHash: hash });
  m.rpc.mockResolvedValue({ error: null });
});
afterEach(() => vi.unstubAllEnvs());
it("commits the local fence before resetting the central binding", async () => {
  await resetIncompleteActivation(licenseId, "admin");
  expect(m.exchange.mock.calls.map(c => c[0].action)).toEqual(["inspect_claim", "reset_claim"]);
  expect(m.rpc).toHaveBeenCalledWith("fence_incomplete_lock_activation", { p_license: licenseId, p_hash: hash, p_actor: "admin" });
  expect(m.rpc.mock.invocationCallOrder[0]).toBeLessThan(m.exchange.mock.invocationCallOrder[1]);
});
it.each(["license_already_activated", "offline"])("never resets the binding when fencing fails: %s", async message => {
  m.rpc.mockResolvedValue({ error: { message } });
  await expect(resetIncompleteActivation(licenseId, "admin")).rejects.toThrow();
  expect(m.exchange).toHaveBeenCalledTimes(1);
});
it("an already unbound code is a no-op, not a credential/identity mutation", async () => {
  m.exchange.mockResolvedValue({ licenseId, status: "active", credentialHash: null });
  await resetIncompleteActivation(licenseId, "admin");
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.exchange).toHaveBeenCalledTimes(1);
});
it("a malformed inspection is not mistaken for an unbound code", async () => {
  m.exchange.mockResolvedValue({ licenseId, status: "active" });
  await expect(resetIncompleteActivation(licenseId, "admin")).rejects.toThrow();
  expect(m.rpc).not.toHaveBeenCalled();
});
it.each([undefined, "wrong", "device-secret", "a".repeat(257)])("rejects public/device callers before any read or mutation", async bearer => {
  const response = await POST(new Request("https://lock.test/api/internal/access-license-recovery", {
    method: "POST", headers: bearer ? { Authorization: `Bearer ${bearer}` } : {}, body: JSON.stringify({ licenseId }),
  }));
  expect(response.status).toBe(401);
  expect(m.exchange).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
});
it("the bridge returns 409 for activated access without clearing it", async () => {
  m.rpc.mockResolvedValue({ error: { message: "license_already_activated" } });
  const response = await POST(new Request("https://lock.test/api/internal/access-license-recovery", {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ licenseId }),
  }));
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("already activated");
  expect(m.exchange).toHaveBeenCalledTimes(1);
});
it("missing bridge configuration denies even empty credentials", async () => {
  vi.stubEnv("PRINCIPESSA_LOCK_LICENSE_BRIDGE_SECRET", "");
  expect((await POST(new Request("https://lock.test", { method: "POST" }))).status).toBe(503);
  expect(m.rpc).not.toHaveBeenCalled();
});
