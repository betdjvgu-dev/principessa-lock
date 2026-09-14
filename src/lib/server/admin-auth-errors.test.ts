import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { auth } = vi.hoisted(() => ({ auth: { getUser: vi.fn(), refreshSession: vi.fn() } }));
vi.mock("./supabase-admin", () => ({
  getSupabaseAdminClient: () => ({ auth }), createIsolatedSupabaseClient: () => ({ auth }),
}));
vi.mock("./rate-limit", () => ({ enforceRateLimit: async () => null }));
import { adminAuthFailure } from "./admin-auth-errors";
import { verifyAdminRequest } from "./admin-auth";
import { POST as refresh } from "../../app/api/admin/refresh/route";

const refreshRequest = () => new Request("http://localhost/api/admin/refresh", {
  method: "POST", body: JSON.stringify({ refreshToken: "test-token" }),
});
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("ADMIN_EMAIL", "admin@example.test"); });
afterEach(() => vi.unstubAllEnvs());

describe("admin authentication failure classification", () => {
  it.each([undefined, new TypeError("fetch failed"), { status: 500 }, { status: 503 },
    { status: 400, code: "request_timeout" }, { status: 0, name: "AuthRetryableFetchError" },
    { status: 409, code: "conflict" }, { status: 400, code: "unexpected_failure" },
    { status: 401, name: "AuthApiError" }])(
    "keeps ambiguous and temporary errors recoverable: %j", (error) => {
      expect(adminAuthFailure(error, "Invalid session").status).toBe(503);
    },
  );
  it("preserves rate limiting instead of converting it to logout", () => {
    expect(adminAuthFailure({ status: 429 }, "Invalid").status).toBe(429);
    expect(adminAuthFailure({ code: "over_request_rate_limit" }, "Invalid").status).toBe(429);
  });
  it.each(["bad_jwt", "refresh_token_already_used", "refresh_token_not_found", "session_expired", "user_banned"])(
    "still denies genuinely invalid credentials with 401: %s", (code) => {
      expect(adminAuthFailure({ status: 400, code }, "Invalid session").status).toBe(401);
    },
  );
  it("does not expose upstream error messages", async () => {
    expect(JSON.stringify(await adminAuthFailure(new Error("secret detail"), "Invalid").json())).not.toContain("secret detail");
  });
});

describe("admin routes preserve the distinction", () => {
  it("returns 503 for refresh outages and does not expose credentials", async () => {
    auth.refreshSession.mockRejectedValue(new TypeError("fetch failed with secret detail"));
    const response = await refresh(refreshRequest());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret detail");
  });
  it("returns 401 for revoked refresh tokens", async () => {
    auth.refreshSession.mockResolvedValue({ data: null, error: { status: 400, code: "refresh_token_already_used" } });
    expect((await refresh(refreshRequest())).status).toBe(401);
  });
  it("treats a missing provider session as an invalid upstream response", async () => {
    auth.refreshSession.mockResolvedValue({ data: { session: null }, error: null });
    expect((await refresh(refreshRequest())).status).toBe(503);
  });
  it("still returns rotated credentials on success", async () => {
    auth.refreshSession.mockResolvedValue({ data: { session: { user: { email: "admin@example.test" }, access_token: "new-access", refresh_token: "new-refresh" } }, error: null });
    const response = await refresh(refreshRequest());
    expect(response.status).toBe(200);
    expect((await response.json()).session.refreshToken).toBe("new-refresh");
  });
  it("denies protected routes temporarily when auth verification is offline", async () => {
    auth.getUser.mockRejectedValue(new Error("offline"));
    const result = await verifyAdminRequest(new Request("http://localhost", { headers: { Authorization: "Bearer test" } }));
    expect(result.error?.status).toBe(503);
    expect(result.identity).toBeUndefined();
  });
  it("still rejects expired JWTs and missing tokens", async () => {
    auth.getUser.mockResolvedValue({ data: null, error: { code: "bad_jwt" } });
    expect((await verifyAdminRequest(new Request("http://localhost", { headers: { Authorization: "Bearer test" } }))).error?.status).toBe(401);
    expect((await verifyAdminRequest(new Request("http://localhost"))).error?.status).toBe(401);
  });
});
