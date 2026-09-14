import { beforeEach, expect, it, vi } from "vitest";
const { query, db } = vi.hoisted(() => {
  const query = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), is: vi.fn(), order: vi.fn(), limit: vi.fn(), update: vi.fn(), returns: vi.fn() };
  return { query, db: { from: vi.fn(() => query) } };
});
vi.mock("./supabase-admin", () => ({ getSupabaseAdminClient: () => db }));
vi.mock("./admin-auth", () => ({ verifyAdminRequest: async () => ({ identity: { id: "admin" } }) }));
vi.mock("./rate-limit", () => ({ enforceAdminRateLimit: async () => null, enforceRateLimit: async () => null }));
vi.mock("./fcm", () => ({ sendNewMessagePush: vi.fn() }));
vi.mock("./device-auth", () => ({ requireAuthenticatedDevice: async () => ({ ok: true, device: { id: "device" } }), verifySessionOwnershipForDevice: async () => ({ ok: true }) }));
import { GET as adminMessages } from "@/app/api/admin/sessions/[id]/messages/route";
import { GET as deviceMessages } from "@/app/api/sessions/[id]/messages/route";
beforeEach(() => {
  vi.resetAllMocks();
  db.from.mockReturnValue(query);
  for (const fn of [query.select, query.eq, query.in, query.is, query.order, query.limit, query.update]) fn.mockReturnValue(query);
});
it.each([adminMessages, deviceMessages])("returns the latest window in chronological order, marks only delivered rows read", async (handler) => {
  query.returns.mockResolvedValue({ data: [{ id: "102", body: "latest" }, { id: "101", body: "previous" }] });
  const response = await handler(new Request("http://localhost"), { params: Promise.resolve({ id: "session" }) });
  expect(response.status).toBe(200);
  expect(query.order).toHaveBeenCalledWith("created_at", { ascending: false });
  expect(query.limit).toHaveBeenCalledWith(100);
  expect((await response.json()).messages.map((m: { id: string }) => m.id)).toEqual(["101", "102"]);
  expect(query.in).toHaveBeenCalledWith("id", ["102", "101"]);
});
it.each([adminMessages, deviceMessages])("empty conversations do not issue an empty read-receipt update", async (handler) => {
  query.returns.mockResolvedValue({ data: [] });
  const response = await handler(new Request("http://localhost"), { params: Promise.resolve({ id: "session" }) });
  expect((await response.json()).messages).toEqual([]);
  expect(query.update).not.toHaveBeenCalled();
});
