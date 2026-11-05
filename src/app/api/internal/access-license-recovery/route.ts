import { createHash, timingSafeEqual } from "node:crypto";
import { jsonError, jsonOk } from "@/lib/server/api-response";
import { readJsonBody } from "@/lib/server/request-validation";
import { resetIncompleteActivation } from "@/lib/server/incomplete-activation";
import { AccessLicenseError } from "@/lib/server/access-licenses";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  // Called by the authenticated Vault admin action, never by Android/public clients.
  const secret = process.env.PRINCIPESSA_LOCK_LICENSE_BRIDGE_SECRET?.trim();
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  if (!secret || secret.length < 32) return jsonError(503, "Recovery bridge is not configured.");
  if (token.length > 256 || !timingSafeEqual(digest(token), digest(secret))) return jsonError(401, "Unauthorized.");
  const body = await readJsonBody<{ licenseId?: unknown }>(request);
  if (!body.ok) return body.response;
  const id = body.data?.licenseId;
  if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return jsonError(400, "Invalid license id.");
  try {
    await resetIncompleteActivation(id, "vault-admin");
    return jsonOk({ ok: true });
  } catch (error) {
    if (error instanceof AccessLicenseError && error.reason === "already_activated") return jsonError(409,
      "This access was already activated. Use admin-approved device transfer or same-phone recovery instead.");
    return jsonError(503, "Incomplete activation could not be reset. Retry safely; existing access was not changed.");
  }
}
