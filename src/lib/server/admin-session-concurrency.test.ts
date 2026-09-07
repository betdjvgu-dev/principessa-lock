import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, supabase, push } = vi.hoisted(() => {
  const query = { select: vi.fn(), eq: vi.fn(), update: vi.fn(), maybeSingle: vi.fn() };
  return { query, supabase: { from: vi.fn(() => query) }, push: vi.fn() };
});
vi.mock("@/lib/server/rate-limit", () => ({ enforceAdminRateLimit: async () => null }));
vi.mock("@/lib/server/admin-auth", () => ({ verifyAdminRequest: async () => ({ error: null }) }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => supabase }));
vi.mock("@/lib/server/remote-action-dispatch", () => ({ queueSyncConfigPush: push }));
import { PATCH } from "@/app/api/admin/sessions/[id]/route";

const session = { id: "session", device_id: "device", status: "active", config_version: 2,
  updated_at: "2026-09-07T12:00:00Z", daily_limit_minutes: 30 };
const request = (body: object) => new Request("http://localhost/api/admin/sessions/session", {
  method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
const context = () => ({ params: Promise.resolve({ id: "session" }) });

beforeEach(() => {
  vi.clearAllMocks();
  query.maybeSingle.mockReset();
  for (const method of [query.select, query.eq, query.update]) method.mockReturnValue(query);
  query.maybeSingle.mockResolvedValueOnce({ data: session, error: null });
});

describe("admin configuration compare-and-swap", () => {
  it("rejects an obsolete draft without writing or sending a push", async () => {
    const response = await PATCH(request({ dailyLimitMinutes: 10, expectedConfigVersion: 1 }), context());
    expect(response.status).toBe(409);
    expect(query.update).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
  it("rejects timestamp conflicts even without a version increment", async () => {
    expect((await PATCH(request({ dailyLimitMinutes: 10, expectedConfigVersion: 2, expectedUpdatedAt: "2026-09-06T12:00:00Z" }), context())).status).toBe(409);
  });
  it("rejects a competing update/revoke between read and write", async () => {
    query.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const response = await PATCH(request({ dailyLimitMinutes: 10, expectedConfigVersion: 2 }), context());
    expect(response.status).toBe(409);
    expect(query.eq).toHaveBeenCalledWith("config_version", 2);
    expect(query.eq).toHaveBeenCalledWith("updated_at", session.updated_at);
    expect(query.eq).toHaveBeenCalledWith("status", "active");
    expect(push).not.toHaveBeenCalled();
  });
  it("keeps old clients working and pushes only after a successful update", async () => {
    query.maybeSingle.mockResolvedValueOnce({ data: { ...session, config_version: 3, daily_limit_minutes: 10 }, error: null });
    expect((await PATCH(request({ dailyLimitMinutes: 10 }), context())).status).toBe(200);
    expect(query.update).toHaveBeenCalledWith({ daily_limit_minutes: 10, config_version: 3 });
    expect(push).toHaveBeenCalledTimes(1);
  });
});
