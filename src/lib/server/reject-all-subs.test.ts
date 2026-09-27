import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(), limit: vi.fn(), query: { delete: vi.fn(), in: vi.fn(), eq: vi.fn(), is: vi.fn(), select: vi.fn() },
  from: vi.fn(),
}));
vi.mock("@/lib/server/admin-auth", () => ({ verifyAdminRequest: mocks.auth }));
vi.mock("@/lib/server/rate-limit", () => ({ enforceAdminRateLimit: mocks.limit }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/server/supabase-errors", () => ({ jsonSupabaseError: () => new Response(null, { status: 503 }) }));
import { POST } from "@/app/api/admin/subs/reject-all/route";
const id = "00000000-0000-4000-8000-000000000001";
const req = (body: unknown) => new Request("http://localhost/api/admin/subs/reject-all", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ error: null }); mocks.limit.mockResolvedValue(null);
  mocks.from.mockReturnValue(mocks.query);
  for (const method of [mocks.query.delete, mocks.query.in, mocks.query.eq, mocks.query.is]) method.mockReturnValue(mocks.query);
  mocks.query.select.mockResolvedValue({ data: [{ id }], error: null });
});
it("requires admin authentication before accessing data", async () => {
  mocks.auth.mockResolvedValue({ error: new Response(null, { status: 401 }) });
  expect((await POST(req({ ids: [id] }))).status).toBe(401);
  expect(mocks.from).not.toHaveBeenCalled();
});
it.each([{}, { ids: [] }, { ids: ["bad"] }, { ids: Array(1001).fill(id) }])("rejects invalid payload %j", async body => {
  expect((await POST(req(body))).status).toBe(400); expect(mocks.from).not.toHaveBeenCalled();
});
it("only deletes snapshot ids still invited in one database mutation", async () => {
  const response = await POST(req({ ids: [id, id] }));
  expect(await response.json()).toEqual({ ok: true, rejectedIds: [id] });
  expect(mocks.query.delete).toHaveBeenCalledTimes(1);
  expect(mocks.query.in).toHaveBeenCalledWith("id", [id]);
  expect(mocks.query.eq).toHaveBeenCalledWith("status", "invited");
  expect(mocks.query.is).toHaveBeenCalledWith("access_transfer_id", null);
});
it("returns no deleted ids if requests were already approved", async () => {
  mocks.query.select.mockResolvedValue({ data: [], error: null });
  expect(await (await POST(req({ ids: [id] }))).json()).toEqual({ ok: true, rejectedIds: [] });
});
it("does not report success on database failure", async () => {
  mocks.query.select.mockResolvedValue({ data: null, error: { message: "offline" } });
  expect((await POST(req({ ids: [id] }))).status).toBe(503);
});
