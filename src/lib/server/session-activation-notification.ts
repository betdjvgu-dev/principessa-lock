import { notifyAdminDevices } from "@/lib/server/admin-push";
import "server-only";
import { sendSessionActivatedPush } from "./fcm";

// Called only by the successful INSERT owner, never by activation recovery/retries.
// Notification delivery must not turn an already committed activation into an error.
export async function notifyAdminSessionActivated(session: {
  sessionId: string; deviceName: string; sessionDays: number; dailyLimitMinutes: number;
}) {
  try {
    return await notifyAdminDevices(token => sendSessionActivatedPush(token, session));
  } catch {
    console.warn("Session activated; admin notification delivery failed.");
    return false;
  }
}
