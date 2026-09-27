import { beforeEach, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("firebase-admin/app", () => ({ cert: vi.fn(), getApps: () => [{}], initializeApp: vi.fn() }));
vi.mock("firebase-admin/messaging", () => ({ getMessaging: () => ({ send }) }));
import { sendProtectionTamperAlertPush, sendSessionActivatedPush } from "./fcm";

beforeEach(() => {
  send.mockReset();
  process.env.FIREBASE_PROJECT_ID = "test-project";
  process.env.FIREBASE_CLIENT_EMAIL = "test@example.com";
  process.env.FIREBASE_PRIVATE_KEY = "test-only";
});
it("does not mark a missing token as sent", async () => {
  expect(await sendProtectionTamperAlertPush(null, "Phone", "missing")).toBe(false);
  expect(send).not.toHaveBeenCalled();
});
it("sends activation identity and settings as FCM string data to the admin token", async () => {
  send.mockResolvedValue("message-id");
  expect(await sendSessionActivatedPush("admin-token", {
    sessionId: "session-id", deviceName: "Test phone", sessionDays: 3, dailyLimitMinutes: 90,
  })).toBe(true);
  expect(send).toHaveBeenCalledWith({ token: "admin-token", android: { priority: "high" }, data: {
    type: "session_activated", sessionId: "session-id", deviceName: "Test phone",
    sessionDays: "3", dailyLimitMinutes: "90",
  }});
});
it("reports failure and permits retry", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    send.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("message-id");
    expect(await sendProtectionTamperAlertPush("test-token", "Phone", "missing")).toBe(false);
    expect(await sendProtectionTamperAlertPush("test-token", "Phone", "missing")).toBe(true);
  } finally { log.mockRestore(); }
});
