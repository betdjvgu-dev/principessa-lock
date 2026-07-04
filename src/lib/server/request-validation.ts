import { jsonError } from "@/lib/server/api-response";

export type SessionRequestInput = {
  dailyLimitMinutes: number;
  deviceName: string;
  forcedSleepEnabled: boolean;
  sessionDays: number;
};

export type ActivationInput = {
  activationCode: string;
  deviceName: string;
  timezone?: string;
};

export async function readJsonBody<T>(request: Request) {
  try {
    return {
      ok: true as const,
      data: (await request.json()) as T,
    };
  } catch {
    return {
      ok: false as const,
      response: jsonError(400, "Invalid JSON request body."),
    };
  }
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number) {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function normalizeRequiredString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function validateSessionRequestInput(input: unknown) {
  if (!input || typeof input !== "object") {
    return { ok: false as const, response: jsonError(400, "Request body must be a JSON object.") };
  }

  const payload = input as Record<string, unknown>;
  const deviceName = normalizeRequiredString(payload.deviceName);

  if (!deviceName) {
    return { ok: false as const, response: jsonError(400, "deviceName is required.") };
  }

  if (!isIntegerInRange(payload.sessionDays, 1, 30)) {
    return { ok: false as const, response: jsonError(400, "sessionDays must be an integer between 1 and 30.") };
  }

  if (!isIntegerInRange(payload.dailyLimitMinutes, 5, 90)) {
    return {
      ok: false as const,
      response: jsonError(400, "dailyLimitMinutes must be an integer between 5 and 90."),
    };
  }

  if (typeof payload.forcedSleepEnabled !== "boolean") {
    return { ok: false as const, response: jsonError(400, "forcedSleepEnabled must be a boolean.") };
  }

  return {
    ok: true as const,
    data: {
      dailyLimitMinutes: Number(payload.dailyLimitMinutes),
      deviceName,
      forcedSleepEnabled: payload.forcedSleepEnabled,
      sessionDays: Number(payload.sessionDays),
    } satisfies SessionRequestInput,
  };
}

export function validateActivationInput(input: unknown) {
  if (!input || typeof input !== "object") {
    return { ok: false as const, response: jsonError(400, "Request body must be a JSON object.") };
  }

  const payload = input as Record<string, unknown>;
  const activationCode = normalizeRequiredString(payload.activationCode);
  const deviceName = normalizeRequiredString(payload.deviceName);

  if (!activationCode) {
    return { ok: false as const, response: jsonError(400, "activationCode is required.") };
  }

  if (!deviceName) {
    return { ok: false as const, response: jsonError(400, "deviceName is required.") };
  }

  if (payload.timezone !== undefined && normalizeRequiredString(payload.timezone) === null) {
    return { ok: false as const, response: jsonError(400, "timezone must be a non-empty string when provided.") };
  }

  return {
    ok: true as const,
    data: {
      activationCode,
      deviceName,
      timezone: normalizeRequiredString(payload.timezone) ?? undefined,
    } satisfies ActivationInput,
  };
}
