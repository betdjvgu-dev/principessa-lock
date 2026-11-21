import { beforeEach, expect, it, vi } from "vitest";
import { ownSessionRequest, type OwnSessionRequestRow } from "./own-session-request";

const m = vi.hoisted(() => ({ auth: vi.fn(), results: [] as unknown[], queries: [] as Array<Array<unknown[]>> }));
vi.mock("@/lib/server/device-auth", () => ({ requireAuthenticatedDevice: m.auth }));
vi.mock("@/lib/server/rate-limit", () => ({ enforceRateLimit: async () => null }));
vi.mock("@/lib/server/admin-push", () => ({ notifyAdminDevices: async () => {} }));
vi.mock("@/lib/server/fcm", () => ({ sendNewSessionRequestPush: async () => {}, sendSessionRequestDecisionPush: async () => {} }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: (table: string) => {
  const calls: unknown[][] = [["from", table]];
  m.queries.push(calls);
  const query: Record<string, unknown> = {};
  for (const name of ["select", "update", "insert", "eq", "in", "lte", "order", "limit", "maybeSingle", "single"]) {
    query[name] = (...args: unknown[]) => { calls.push([name, ...args]); return query; };
  }
  query.then = (resolve: (result: unknown) => void) => Promise.resolve(m.results.shift()).then(resolve);
  return query;
} }) }));
import { GET, POST } from "@/app/api/session-requests/route";

const row: OwnSessionRequestRow = {
  id: "old", status: "approved", device_name: "Phone", requested_days: 30, daily_limit_minutes: 90,
  screen_time_enabled: false, always_allowed_package: "com.example.allowed", forced_sleep_enabled: false,
  gallery_access_enabled: true, full_discretion: true, activation_code_expires_at: "2026-09-11T01:04:32Z",
};
beforeEach(() => {
  m.results.length = 0; m.queries.length = 0;
  m.auth.mockResolvedValue({ ok: true, device: { id: "device-a", subId: "sub-a", deviceName: "Phone" } });
});
it("maps expired approvals without exposing credentials or activating anything", () => {
  expect(ownSessionRequest(row, Date.parse("2026-11-21T00:00:00Z"))).toEqual({ id: "old", status: "expired", settings: {
    deviceName: "Phone", sessionDays: 30, dailyLimitMinutes: 90, screenTimeEnabled: false,
    alwaysAllowedPackage: "com.example.allowed", forcedSleepEnabled: false, galleryAccessEnabled: true, fullDiscretion: true,
  } });
  expect(ownSessionRequest(row, Date.parse(row.activation_code_expires_at!) - 1).status).toBe("approved");
  expect(ownSessionRequest(row, Date.parse(row.activation_code_expires_at!)).status).toBe("expired");
  expect(ownSessionRequest({ ...row, status: "activated" }).status).toBe("activated");
});
it("authenticated discovery includes request settings without writes on every poll", async () => {
  m.results.push({ data: row, error: null });
  const res = await GET(new Request("https://test/api/session-requests"));
  expect(res.status).toBe(200);
  expect((await res.json()).request.settings.galleryAccessEnabled).toBe(true);
  expect(m.queries[0]).toContainEqual(["eq", "device_id", "device-a"]);
  expect(m.queries.flat().some(call => call[0] === "update")).toBe(false);
});
it("missing device authentication cannot discover or mutate requests", async () => {
  m.auth.mockResolvedValue({ ok: false, response: new Response("Unauthorized", { status: 401 }) });
  expect((await GET(new Request("https://test/api/session-requests"))).status).toBe(401);
  expect(m.queries).toEqual([]);
});
const post = () => POST(new Request("https://test/api/session-requests", { method: "POST", body: JSON.stringify({
  deviceName: "Phone", sessionDays: 3, dailyLimitMinutes: 90, forcedSleepEnabled: false, fullDiscretion: true,
  galleryAccessEnabled: false, screenTimeEnabled: true,
}) }));
it("expires only elapsed approved rows for this device before accepting a new request", async () => {
  m.results.push({ error: null }, { data: null, error: null }, { data: { id: "new", status: "pending" }, error: null });
  expect((await post()).status).toBe(201);
  expect(m.queries[0]).toEqual([
    ["from", "session_requests"], ["update", { status: "expired" }], ["eq", "device_id", "device-a"],
    ["eq", "status", "approved"], ["lte", "activation_code_expires_at", expect.any(String)],
  ]);
  expect(m.queries[2]).toContainEqual(["insert", expect.objectContaining({ device_id: "device-a", requested_days: 3 })]);
});
it("a valid outstanding approval still prevents duplicate requests", async () => {
  m.results.push({ error: null }, { data: { id: "valid", status: "approved" }, error: null });
  expect((await post()).status).toBe(409);
  expect(m.queries).toHaveLength(2);
});
