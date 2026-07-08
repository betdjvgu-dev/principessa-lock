import "server-only";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

let cachedMessaging: ReturnType<typeof getMessaging> | null = null;
let initializationAttempted = false;

function getFirebaseMessaging() {
  if (cachedMessaging) {
    return cachedMessaging;
  }

  if (initializationAttempted) {
    return null;
  }

  initializationAttempted = true;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  const app = getApps()[0] ?? initializeApp({ credential: cert({ clientEmail, privateKey, projectId }) });
  cachedMessaging = getMessaging(app);

  return cachedMessaging;
}

/**
 * Best-effort: wakes a device via a data-only push instead of waiting for the next poll
 * interval. If Firebase isn't configured, or the device has no token (never registered, or a
 * prior push failed), this silently no-ops -- polling always remains the fallback delivery
 * path regardless of push success.
 */
async function sendDataPush(fcmToken: string | null | undefined, data: Record<string, string>) {
  if (!fcmToken) {
    return;
  }

  const messaging = getFirebaseMessaging();

  if (!messaging) {
    return;
  }

  try {
    await messaging.send({
      android: { priority: "high" },
      data,
      token: fcmToken,
    });
  } catch (error) {
    console.error("Failed to send FCM push.", error);
  }
}

/** Wakes a device to check for pending remote actions immediately (e.g. force_lock). */
export async function sendRemoteActionPush(fcmToken: string | null | undefined) {
  await sendDataPush(fcmToken, { type: "remote_action" });
}

/** Wakes a device to check for (and notify) a new message from Principessa immediately --
 *  without this, a keyholder message only ever reached the sub once they happened to open
 *  the Messaging screen on their own. */
export async function sendNewMessagePush(fcmToken: string | null | undefined) {
  await sendDataPush(fcmToken, { type: "new_message" });
}
