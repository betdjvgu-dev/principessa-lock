import "server-only";
import { jsonError } from "./api-response";
import { getSupabaseAdminClient } from "./supabase-admin";
import { createHash } from "node:crypto";
import { jsonOk } from "./api-response";
import type { RegisterInput } from "./request-validation";

export const codeRegistrationEnabled = () => process.env.LOCK_CODE_REGISTRATION_ENABLED === "true";
export function normalizeAccessCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase().replace(/\s+/g, "");
  return /^[A-Z0-9-]{16,80}$/.test(code) ? code : null;
}
export class AccessLicenseError extends Error {
  constructor(public readonly reason: string, public readonly status = 503) { super(reason); }
}
export function automaticAccessUsername(deviceName: string, deviceSecret: string, attempt = 0) {
  const prefix = deviceName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 7) || "device";
  // Internal account handle only, never an authentication credential. Stable across retries.
  const suffix = createHash("sha256").update(`lock-username:v1\0${deviceSecret}\0${attempt}`).digest("hex").slice(0, 12);
  return `${prefix}_${suffix}`;
}
export async function registerWithAccessCode(input: RegisterInput, code: string) {
  if (!input.deviceSecret) return jsonError(400, "Update the app and provide a secure device credential and activation code.");
  try {
    const hash = createHash("sha256").update(input.deviceSecret).digest("hex");
    const receipt = await exchangeAccessLicense({ action: "claim", code, credentialHash: hash });
    if (receipt.status !== "active") throw new AccessLicenseError("revoked", 403);
    for (let attempt = 0; attempt < 3; attempt++) {
      const username = input.username ?? automaticAccessUsername(input.deviceName, input.deviceSecret, attempt);
      const { data, error } = await getSupabaseAdminClient().rpc("activate_lock_access_license", {
        p_license: receipt.licenseId, p_hash: hash,
        p_details: { ...input, username, deviceSecret: undefined, activationCode: undefined },
      });
      if (error) {
        if (error.code === "23505" && !input.username && /username/i.test(error.message)) continue;
        if (error.code === "23505") return jsonError(409, input.username
          ? "Username or device name is already in use. Change it and retry with the same code."
          : "That device name is already in use. Choose another and retry with the same code.");
        if (["license_bound_elsewhere", "license_existing_device"].includes(error.message)) throw new AccessLicenseError("bound_elsewhere", 409);
        throw new AccessLicenseError("unavailable");
      }
      if (!data?.deviceId || !data?.subId) throw new AccessLicenseError("unavailable");
      return jsonOk({ ok: true, status: "active", subId: data.subId, username: data.username,
        device: { id: data.deviceId, deviceSecret: input.deviceSecret } }, { status: 201, headers: { "Cache-Control": "no-store" } });
    }
    throw new AccessLicenseError("unavailable");
  } catch (error) { return accessLicenseError(error); }
}
export function accessLicenseError(error: unknown) {
  const reason = error instanceof AccessLicenseError ? error.reason : "unavailable";
  const messages: Record<string, string> = {
    invalid_license: "The activation code is invalid or revoked.",
    bound_elsewhere: "This code is already used. Use Recover existing access or an admin-approved transfer.",
    revoked: "Lifetime access was revoked. Contact Principessa.",
  };
  return jsonError(error instanceof AccessLicenseError ? error.status : 503,
    messages[reason] ?? "Access verification is temporarily unavailable. Your saved session has not been removed.");
}
export async function exchangeAccessLicense(input: Record<string, unknown>) {
  const secret = process.env.PRINCIPESSA_LOCK_LICENSE_BRIDGE_SECRET?.trim();
  const base = process.env.VAULT_MISTRESS_BASE_URL?.trim();
  if (!secret || secret.length < 32 || !base) throw new AccessLicenseError("unavailable");
  const url = new URL("/api/app-license/lock", base);
  if (url.protocol !== "https:" && !(process.env.NODE_ENV === "test" || url.hostname === "localhost")) {
    throw new AccessLicenseError("unavailable");
  }
  const response = await fetch(url, {
    method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` }, body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok || !/^[a-f0-9-]{36}$/i.test(body?.licenseId ?? "")) {
    const reason = ["invalid_license", "bound_elsewhere"].includes(body?.error) ? body.error : "unavailable";
    throw new AccessLicenseError(reason, reason === "unavailable" ? 503 : 409);
  }
  if (!["active", "revoked"].includes(body.status)) throw new AccessLicenseError("unavailable");
  if (input.action === "sync" && body.licenseId !== input.licenseId) throw new AccessLicenseError("unavailable");
  return body as { licenseId: string; status: "active" | "revoked" };
}

type License = { id: string; current_sub_id: string; current_device_id: string; source: string;
  legacy_sub_id: string | null; status: string; revision: number; last_validated_at: string | null };
const checks = new Map<string, Promise<void>>();
const cache = new Map<string, number>();
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

// A ten-minute, bounded cache prevents adding a second backend request to each heartbeat.
// Database/provider failures are 503, never a fake revocation or credential reset.
export async function verifyAccessLicense(subId: string, deviceId: string) {
  const key = `${subId}:${deviceId}`;
  if ((cache.get(key) ?? 0) > Date.now()) return;
  if (checks.has(key)) return checks.get(key);
  const pending = (async () => {
    const db = getSupabaseAdminClient();
    let { data: license, error } = await db.from("lock_access_licenses").select("*")
      .eq("current_sub_id", subId).maybeSingle<License>();
    if (!error && !license) {
      // Old installs without credentials at migration time may complete approved
      // credential recovery later. Only snapshotted/admin-approved users qualify.
      const { error: attachError } = await db.rpc("attach_legacy_lock_license", { p_sub: subId });
      if (attachError) throw new AccessLicenseError("unavailable");
      ({ data: license, error } = await db.from("lock_access_licenses").select("*")
        .eq("current_sub_id", subId).maybeSingle<License>());
    }
    if (error || !license) throw new AccessLicenseError("unavailable");
    if (license.status !== "active" || license.current_device_id !== deviceId) throw new AccessLicenseError("revoked", 403);
    if (license.last_validated_at && Date.parse(license.last_validated_at) > Date.now() - CHECK_INTERVAL_MS) {
      cache.set(key, Date.parse(license.last_validated_at) + CHECK_INTERVAL_MS);
      return;
    }
    const [{ data: sub, error: subError }, { data: device, error: deviceError }] = await Promise.all([
      db.from("subs").select("username").eq("id", subId).single(),
      db.from("devices").select("device_name").eq("id", deviceId).single(),
    ]);
    if (subError || deviceError) throw new AccessLicenseError("unavailable");
    const result = await exchangeAccessLicense({ action: "sync", licenseId: license.id,
      legacySubId: license.legacy_sub_id, holderId: subId, revision: license.revision,
      username: sub.username, deviceName: device.device_name });
    const { data: updated, error: updateError } = await db.from("lock_access_licenses")
      .update({ status: result.status, last_validated_at: new Date().toISOString() })
      .eq("id", license.id).eq("current_sub_id", subId).eq("revision", license.revision).select("id").maybeSingle();
    if (updateError || !updated) throw new AccessLicenseError("unavailable");
    if (result.status !== "active") throw new AccessLicenseError("revoked", 403);
    if (cache.size >= 1000) cache.clear();
    cache.set(key, Date.now() + CHECK_INTERVAL_MS);
  })();
  checks.set(key, pending);
  try { await pending; } finally { checks.delete(key); }
}
