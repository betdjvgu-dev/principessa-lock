import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { auth } = vi.hoisted(() => ({ auth: { getUser: vi.fn(), signInWithPassword: vi.fn(), refreshSession: vi.fn() } }));
vi.mock("./supabase-admin", () => ({ getSupabaseAdminClient: () => ({ auth }), createIsolatedSupabaseClient: () => ({ auth }) }));
vi.mock("./rate-limit", () => ({ enforceRateLimit: async () => null }));
vi.mock("@/lib/env", () => ({ getSupabaseAnonKey: () => "public-key", getServerEnv: () => ({ SUPABASE_URL: "https://example.supabase.co" }) }));
import { authorizeAdminEmail } from "./admin-identity";
import { verifyAdminRequest } from "./admin-auth";
import { POST as login } from "@/app/api/admin/login/route";
import { POST as refresh } from "@/app/api/admin/refresh/route";
const request = () => new Request("http://localhost", { method: "POST", headers: { Authorization: "Bearer token" }, body: JSON.stringify({ email: "admin@example.test", password: "test", refreshToken: "refresh" }) });
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("ADMIN_EMAIL", "admin@example.test"); });
afterEach(() => vi.unstubAllEnvs());

it.each([undefined, "", "   "])("denies login, refresh and protected routes without configuration: %j", async (value) => {
  vi.stubEnv("ADMIN_EMAIL", value);
  expect((await login(request())).status).toBe(503);
  expect((await refresh(request())).status).toBe(503);
  expect((await verifyAdminRequest(request())).error?.status).toBe(503);
  expect(auth.getUser).not.toHaveBeenCalled();
  expect(auth.signInWithPassword).not.toHaveBeenCalled();
  expect(auth.refreshSession).not.toHaveBeenCalled();
});
it.each([undefined, null, "", "other@example.test"])("rejects a missing or different authenticated identity: %j", async (email) => {
  const user = { id: "user", email };
  auth.getUser.mockResolvedValue({ data: { user } });
  auth.signInWithPassword.mockResolvedValue({ data: { session: { user } } });
  auth.refreshSession.mockResolvedValue({ data: { session: { user } } });
  expect((await login(request())).status).toBe(403);
  expect((await refresh(request())).status).toBe(403);
  expect((await verifyAdminRequest(request())).error?.status).toBe(403);
});
it("accepts only the configured admin, normalizing whitespace and case", async () => {
  vi.stubEnv("ADMIN_EMAIL", " Admin@Example.Test ");
  expect(authorizeAdminEmail("ADMIN@example.test")).toBeNull();
  const user = { id: "admin", email: "admin@example.test" };
  auth.getUser.mockResolvedValue({ data: { user } });
  auth.signInWithPassword.mockResolvedValue({ data: { session: { user } } });
  expect((await login(request())).status).toBe(200);
  expect((await verifyAdminRequest(request())).identity?.id).toBe("admin");
});
