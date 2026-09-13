import "server-only";
import { jsonError } from "./api-response";

const invalidSessionCodes = new Set([
  "bad_jwt", "invalid_credentials", "no_authorization", "session_not_found",
  "session_expired", "refresh_token_not_found", "refresh_token_already_used",
  "user_not_found", "user_banned",
]);

// Unknown/provider failures still deny access, but must not destroy a saved login.
export function adminAuthFailure(error: unknown, invalidMessage: string): Response {
  const details = error && typeof error === "object"
    ? error as { code?: string; status?: number; name?: string } : {};
  if (details.status === 429 || details.code === "over_request_rate_limit") {
    return jsonError(429, "Authentication is temporarily rate limited. Please try again shortly.");
  }
  if (details.status === 408 || details.status === 409 || (details.status ?? 0) >= 500 ||
      details.name === "AuthRetryableFetchError" || details.code === "request_timeout") {
    return jsonError(503, "Authentication service is temporarily unavailable. Please try again.");
  }
  if (invalidSessionCodes.has(details.code ?? "")) {
    return jsonError(401, invalidMessage);
  }
  return jsonError(503, "Authentication service could not verify the session. Please try again.");
}
