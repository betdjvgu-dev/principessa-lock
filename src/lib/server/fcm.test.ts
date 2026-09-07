import { beforeEach, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("firebase-admin/app", () => ({ cert: vi.fn(), getApps: () => [{}], initializeApp: vi.fn() }));
vi.mock("firebase-admin/messaging", () => ({ getMessaging: () => ({ send }) }));
import { sendProtectionTamperAlertPush } from "./fcm";

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
it("reports failure and permits retry", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    send.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("message-id");
    expect(await sendProtectionTamperAlertPush("test-token", "Phone", "missing")).toBe(false);
    expect(await sendProtectionTamperAlertPush("test-token", "Phone", "missing")).toBe(true);
  } finally { log.mockRestore(); }
});
