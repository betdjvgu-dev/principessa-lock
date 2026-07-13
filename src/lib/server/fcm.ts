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

/** Wakes a device to check for (and notify) an approved registration immediately -- without
 *  this, a sub only found out once they happened to reopen the app while it polled on its own
 *  (which could take minutes if the app was backgrounded). */
export async function sendRegistrationApprovedPush(fcmToken: string | null | undefined) {
  await sendDataPush(fcmToken, { type: "registration_approved" });
}

/** Wakes the keyholder's own device (whichever one she's logged into the in-app admin console
 *  on) to notify her of a new session request immediately, instead of her only finding out
 *  whenever she happens to open the admin console on her own. */
export async function sendNewSessionRequestPush(fcmToken: string | null | undefined) {
  await sendDataPush(fcmToken, { type: "new_session_request" });
}

/** Wakes a sub's device to check for (and notify) an approved/rejected session request
 *  immediately -- without this, a sub only found out once they happened to reopen the app while
 *  it polled on its own (which could take minutes if the app was backgrounded). */
export async function sendSessionRequestDecisionPush(fcmToken: string | null | undefined) {
  await sendDataPush(fcmToken, { type: "session_request_decided" });
}

/** Wakes the keyholder's own device the moment a new sub self-registers and is waiting for
 *  approval -- without this, a new registration was only visible if she happened to open the
 *  admin console on her own. */
export async function sendNewRegistrationPush(fcmToken: string | null | undefined, username: string) {
  await sendDataPush(fcmToken, { type: "new_registration", username });
}

/** Wakes the keyholder's own device the moment a critical protection permission is lost (or
 *  overall protection health degrades) on a sub's device -- without this, tamper/permission loss
 *  was only visible if she happened to open the admin dashboard and noticed a status field
 *  herself, potentially long after the sub used the gap to uninstall or disable protection. */
export async function sendProtectionTamperAlertPush(fcmToken: string | null | undefined, deviceName: string, reason: string) {
  await sendDataPush(fcmToken, { deviceName, reason, type: "protection_tamper_alert" });
}
