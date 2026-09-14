import { beforeEach, expect, it, vi } from "vitest";

const { query, db, dispatch } = vi.hoisted(() => {
  const query = { select: vi.fn(), eq: vi.fn(), gt: vi.fn(), update: vi.fn(), maybeSingle: vi.fn(), returns: vi.fn() };
  return { query, db: { from: vi.fn(() => query), rpc: vi.fn() }, dispatch: vi.fn() };
});
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => db }));
vi.mock("@/lib/server/admin-auth", () => ({ verifyAdminRequest: async () => ({ error: null }) }));
vi.mock("@/lib/server/rate-limit", () => ({ enforceAdminRateLimit: async () => null }));
vi.mock("@/lib/server/remote-action-dispatch", () => ({ queueSyncConfigPush: dispatch }));
vi.mock("@/lib/server/device-auth", () => ({
  requireAuthenticatedDevice: async () => ({ ok: true, device: { id: "current-device" } }),
  verifySessionOwnershipForDevice: async () => ({ ok: true }),
}));
import { POST } from "@/app/api/admin/unlock-requests/[id]/approve/route";
import { GET } from "@/app/api/sessions/[id]/route";
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const endsAt = "2099-01-01T00:00:00Z";

beforeEach(() => {
  vi.resetAllMocks();
  for (const method of [query.select, query.eq, query.gt, query.update]) method.mockReturnValue(query);
  db.from.mockReturnValue(query);
  db.rpc.mockResolvedValue({ data: 0, error: null });
  dispatch.mockResolvedValue({ queued: true, pushSent: true });
});

function pendingApproval() {
  query.maybeSingle.mockResolvedValueOnce({ data: { id: "request", session_id: "session", status: "pending" }, error: null })
    .mockResolvedValueOnce({ data: { ends_at: endsAt, status: "active", device_id: "current-device", sub_id: "sub" }, error: null })
    .mockResolvedValueOnce({ data: { id: "request", session_id: "session", status: "approved", device_id: "old-device", sub_id: "sub", package_name: "example.app", expires_at: endsAt }, error: null });
}

it("approval grants an exception through config sync without manually editing blocked packages", async () => {
  pendingApproval();
  const approved = await POST(new Request("http://localhost/approve", { method: "POST" }), context("request"));
  expect(approved.status).toBe(200);
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({ status: "approved", expires_at: endsAt }));
  expect(query.update.mock.calls[0][0]).not.toHaveProperty("price_usd");
  expect(dispatch).toHaveBeenCalledWith(db, { sessionId: "session", deviceId: "current-device", subId: "sub" });

  query.maybeSingle.mockResolvedValueOnce({ data: { id: "session", status: "active", blocked_packages: ["example.app"], config_version: 1 }, error: null });
  query.returns.mockResolvedValue({ data: [{ package_name: "example.app" }], error: null });
  const synced = await GET(new Request("http://localhost/api/sessions/session"), context("session"));
  expect(await synced.json()).toMatchObject({ blockedPackages: ["example.app"], unlockedPackages: ["example.app"] });
  expect(query.eq).toHaveBeenCalledWith("status", "approved");
  expect(query.gt).toHaveBeenCalledWith("expires_at", expect.any(String));
});

it("approval remains valid when push is unavailable and exposes delivery status", async () => {
  pendingApproval();
  dispatch.mockResolvedValue({ queued: true, pushSent: false });
  const response = await POST(new Request("http://localhost/approve", { method: "POST" }), context("request"));
  expect(await response.json()).toMatchObject({ ok: true, request: { status: "approved" }, delivery: { queued: true, pushSent: false } });
});

it("rejects repeated approval without duplicate grant or dispatch", async () => {
  query.maybeSingle.mockResolvedValueOnce({ data: { id: "request", status: "approved" }, error: null });
  expect((await POST(new Request("http://localhost/approve", { method: "POST" }), context("request"))).status).toBe(409);
  expect(query.update).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});
