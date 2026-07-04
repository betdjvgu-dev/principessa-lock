import "server-only";

import { timingSafeEqual } from "node:crypto";

import { getServerEnv } from "@/lib/env";
import { jsonError } from "@/lib/server/api-response";

function extractBearerToken(authorizationHeader: string | null) {
  if (!authorizationHeader) {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}

function tokenMatches(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function verifyAdminRequest(request: Request) {
  const token = extractBearerToken(request.headers.get("authorization"));

  if (!token) {
    return jsonError(401, "Missing or invalid admin bearer token.");
  }

  const { ADMIN_API_TOKEN } = getServerEnv();

  if (!tokenMatches(ADMIN_API_TOKEN, token)) {
    return jsonError(401, "Invalid admin bearer token.");
  }

  return null;
}

