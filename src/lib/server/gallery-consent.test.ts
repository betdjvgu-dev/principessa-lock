import { beforeEach, expect, it, vi } from "vitest";
const { query, db } = vi.hoisted(() => {
  const query = { select: vi.fn(), eq: vi.fn(), or: vi.fn(), order: vi.fn(), in: vi.fn(), insert: vi.fn(), update: vi.fn(), maybeSingle: vi.fn(), returns: vi.fn() };
  return { query, db: { from: vi.fn(() => query) } };
});
vi.mock("./supabase-admin", () => ({ getSupabaseAdminClient: () => db }));
vi.mock("./admin-auth", () => ({ verifyAdminRequest: async () => ({ identity: { id: "admin" } }) }));
vi.mock("./rate-limit", () => ({ enforceAdminRateLimit: async () => null }));
vi.mock("./fcm", () => ({ sendRemoteActionPush: async () => false }));
vi.mock("./device-auth", () => ({ requireAuthenticatedDevice: async () => ({ ok: true, device: { id: "device" } }), verifySessionOwnershipForDevice: async () => ({ ok: true }), verifyRemoteActionOwnershipForDevice: async () => ({ ok: true }) }));
import { POST } from "@/app/api/admin/remote-actions/route";
import { GET } from "@/app/api/remote-actions/route";
import { POST as complete } from "@/app/api/remote-actions/[id]/complete/route";
const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const create = (actionType = "capture_gallery") => new Request("http://localhost", { method: "POST", body: JSON.stringify({ sessionId, actionType, payload: {} }) });
beforeEach(() => {
  vi.resetAllMocks();
  db.from.mockReturnValue(query);
  for (const fn of [query.select, query.eq, query.or, query.order, query.in, query.insert, query.update]) fn.mockReturnValue(query);
});
it.each([false, null, undefined])("rejects gallery capture without session consent: %j", async (consent) => {
  query.maybeSingle.mockResolvedValue({ data: { id: sessionId, status: "active", gallery_access_enabled: consent } });
  expect((await POST(create())).status).toBe(403);
  expect(query.insert).not.toHaveBeenCalled();
});
it.each(["capture_gallery", "capture_screenshot"])("allows intended capture with appropriate consent: %s", async (actionType) => {
  query.maybeSingle.mockResolvedValueOnce({ data: { id: sessionId, status: "active", gallery_access_enabled: actionType === "capture_gallery" } })
    .mockResolvedValueOnce({ data: { id: "action", status: "pending" } });
  expect((await POST(create(actionType))).status).toBe(200);
  expect(query.insert).toHaveBeenCalled();
});
it("rejects an already queued gallery request after consent is withdrawn, without changing screenshots", async () => {
  query.returns.mockResolvedValue({ data: [{ id: "gallery", action_type: "capture_gallery" }, { id: "screen", action_type: "capture_screenshot" }] });
  query.maybeSingle.mockResolvedValue({ data: { status: "active", gallery_access_enabled: false } });
  const response = await GET(new Request(`http://localhost?sessionId=${sessionId}`));
  expect(response.status).toBe(200);
  expect((await response.json()).actions.map((a: { id: string }) => a.id)).toEqual(["screen"]);
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  expect(query.in).toHaveBeenCalledWith("id", ["gallery"]);
});
it("does not deliver gallery capture if consent lookup fails", async () => {
  query.returns.mockResolvedValue({ data: [{ id: "gallery", action_type: "capture_gallery" }] });
  query.maybeSingle.mockResolvedValue({ data: null, error: { code: "failure" } });
  expect((await GET(new Request(`http://localhost?sessionId=${sessionId}`))).status).toBeGreaterThanOrEqual(500);
});
it("discards an in-flight upload when consent has since been withdrawn", async () => {
  query.maybeSingle.mockResolvedValueOnce({ data: { id: "action", session_id: sessionId, action_type: "capture_gallery", status: "pending" } })
    .mockResolvedValueOnce({ data: { gallery_access_enabled: false, status: "active" } })
    .mockResolvedValueOnce({ data: { id: "action", status: "failed" } });
  const response = await complete(new Request("http://localhost", { method: "POST", body: JSON.stringify({ ok: true, result: { photosBase64: ["must-not-persist"] } }) }), { params: Promise.resolve({ id: "action" }) });
  expect(response.status).toBe(200);
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", result_payload: {} }));
  expect(JSON.stringify(query.update.mock.calls)).not.toContain("must-not-persist");
});
