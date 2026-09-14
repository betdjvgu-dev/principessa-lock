import "server-only";
import { jsonError } from "./api-response";

export function requireAdminConfiguration(): Response | null {
  return process.env.ADMIN_EMAIL?.trim()
    ? null
    : jsonError(503, "Admin access is not configured. Contact the administrator.");
}

export function authorizeAdminEmail(email: string | null | undefined): Response | null {
  const configurationError = requireAdminConfiguration();
  if (configurationError) return configurationError;
  return email?.trim().toLowerCase() === process.env.ADMIN_EMAIL!.trim().toLowerCase()
    ? null
    : jsonError(403, "This account is not authorized as the admin.");
}
