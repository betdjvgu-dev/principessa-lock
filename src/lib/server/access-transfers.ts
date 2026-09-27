import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { jsonError, jsonOk } from "./api-response";
import { getSupabaseAdminClient } from "./supabase-admin";

export const transferUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function newTransferCode() { return `PLT-${randomBytes(24).toString("hex").toUpperCase()}`; }
export function normalizeTransferCode(value: unknown) {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^PLT-[0-9A-F]{48}$/.test(code) ? code : null;
}
export function transferCodeHash(code: string) { return createHash("sha256").update(code).digest("hex"); }
export function transferError(error: { code?: string; message?: string }) {
  // Never return/log raw database details: they can contain unique-key credential hashes.
  const messages: Record<string, [number, string]> = {
    transfer_active_session: [409, "Finish or revoke the active session before transferring access."],
    transfer_source_unavailable: [409, "The source device no longer has transferable access."],
    transfer_invalid_code: [409, "The transfer code is invalid, expired, or already used."],
    transfer_pending: [409, "A transfer request is already waiting for admin approval."],
    transfer_expired: [409, "The transfer code expired. Request a new code."],
    transfer_existing_device: [409, "This device is already registered. Contact Principessa before transferring."],
    transfer_not_found: [404, "Transfer not found."],
    transfer_not_claimed: [409, "The new device has not requested this transfer yet."],
    transfer_already_decided: [409, "This transfer has already been decided."],
    transfer_target_unavailable: [409, "The receiving device is no longer eligible."],
    transfer_requires_approval: [409, "Use Transfer Requests to approve this device."],
    transfer_source_revoked: [403, "This device's access was transferred. Contact Principessa."],
    transfer_credential_required: [403, "The original device credential is required. Contact Principessa."],
    transfer_invalid_input: [400, "Invalid transfer details."],
  };
  const match = messages[error.message ?? ""];
  if (match) return jsonError(...match);
  if (error.code === "23505") return jsonError(409, "Username or device name is already in use, or a transfer is already pending.");
  return jsonError(503, "Access transfer is temporarily unavailable. Please try again later.");
}
export async function issueTransfer(deviceId: string, actor: string) {
  const code = newTransferCode();
  const { data, error } = await getSupabaseAdminClient().rpc("issue_access_transfer", {
    p_device: deviceId, p_code_hash: transferCodeHash(code), p_actor: actor,
  });
  if (error) return transferError(error);
  return jsonOk({ ok: true, code, expiresAt: data.expiresAt }, { headers: { "Cache-Control": "no-store" } });
}
