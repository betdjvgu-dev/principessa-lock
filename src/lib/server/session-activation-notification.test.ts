import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ lookup: vi.fn(), send: vi.fn() }));
vi.mock("./supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: () => ({ select: () => ({ limit: m.lookup }) }) }) }));
vi.mock("./fcm", () => ({ sendSessionActivatedPush: m.send }));
import { notifyAdminSessionActivated } from "./session-activation-notification";
const session = { sessionId: "session", deviceName: "Phone", sessionDays: 1, dailyLimitMinutes: 90 };
beforeEach(() => { vi.resetAllMocks(); });
it("sends only to the registered admin token", async () => {
  m.lookup.mockResolvedValue({ data: [{ fcm_token: "admin" }, { fcm_token: "companion" }, { fcm_token: "admin" }], error: null });
  m.send.mockResolvedValue(true);
  expect(await notifyAdminSessionActivated(session)).toBe(true);
  expect(m.send).toHaveBeenCalledWith("admin", session);
  expect(m.send).toHaveBeenCalledWith("companion", session);
  expect(m.send).toHaveBeenCalledTimes(2);
});
it("database and transport failures do not fail the activation", async () => {
  m.lookup.mockRejectedValueOnce(new Error("offline"));
  expect(await notifyAdminSessionActivated(session)).toBe(false);
  m.lookup.mockResolvedValue({ data: null, error: { message: "unavailable" } });
  expect(await notifyAdminSessionActivated(session)).toBe(false);
  expect(m.send).not.toHaveBeenCalled();
});
