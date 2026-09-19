import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const { query, db } = vi.hoisted(() => {
  const query = { select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(),
    maybeSingle: vi.fn(), insert: vi.fn(), update: vi.fn(), upsert: vi.fn(), error: null };
  return { query, db: { from: vi.fn(() => query) } };
});
vi.mock("./supabase-admin", () => ({ getSupabaseAdminClient: () => db }));
vi.mock("./rate-limit", () => ({ enforceRateLimit: async () => null }));
vi.mock("./device-auth", () => ({
  requireAuthenticatedDevice: async () => ({ ok: true, device: { id: "device" } }),
  verifySessionOwnershipForDevice: async () => ({ ok: true }),
}));
vi.mock("./fcm", () => ({ sendProtectionTamperAlertPush: async () => false }));
import { POST } from "@/app/api/heartbeat/route";

const request = (limit = 150) => new Request("http://localhost/api/heartbeat", {
  method: "POST", body: JSON.stringify({ sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    deviceName: "Test", sessionStatus: "active", protectionState: "active_allowed",
    dailyLimitMinutes: limit, usedMinutes: 42, localDate: "2026-09-19" }),
});
beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ["select", "eq", "order", "limit", "insert", "update"] as const) query[name].mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: null, error: null });
  query.upsert.mockResolvedValue({ error: null });
});
describe("daily usage history", () => {
  it("stores a 150-minute limit without clipping reported history", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(query.upsert).toHaveBeenCalledWith(expect.objectContaining({ limit_minutes: 150, used_minutes: 42 }),
      { onConflict: "session_id,local_date" });
  });
  it("exposes a failed usage write without failing an already stored heartbeat", async () => {
    query.upsert.mockResolvedValue({ error: { code: "23514", message: "limit constraint" } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request());
      expect(await response.json()).toEqual({ ok: true, usageHistorySaved: false });
      expect(log).toHaveBeenCalledWith("Usage history could not be stored.", expect.objectContaining({ code: "23514" }));
    } finally { log.mockRestore(); }
  });
  it("migration allows effective limits including step bonuses, without deleting history", () => {
    const sql = readFileSync("supabase/phase-usage-history-limit-20260919.sql", "utf8");
    expect(sql).toContain("check (limit_minutes >= 5)");
    expect(sql).not.toMatch(/delete from|truncate table/i);
  });
});
