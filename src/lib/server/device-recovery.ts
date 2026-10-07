import { jsonError } from "./api-response";

export function recoveryError(error: { message?: string }) {
  const messages: Record<string, [number, string]> = {
    recovery_invalid: [400, "Invalid recovery details."],
    recovery_unavailable: [403, "Access recovery is unavailable. Check your original username or contact Principessa."],
    recovery_pending: [409, "A recovery request is already pending. Contact Principessa if this was not you."],
    recovery_rejected: [403, "Access recovery was rejected. Contact Principessa."],
    recovery_not_pending: [409, "This recovery request expired or was already decided. Refresh the list."],
  };
  const known = messages[error.message ?? ""];
  return jsonError(known?.[0] ?? 503, known?.[1] ?? "Access recovery is temporarily unavailable. Please retry later.");
}
