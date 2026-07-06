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

export type HeartbeatInput = {
  batteryOptimizationIgnored?: boolean;
  blockingActive?: boolean;
  dailyLimitMinutes?: number;
  deviceAdminGranted?: boolean;
  deviceId?: string;
  deviceName: string;
  forcedSleepEnabled?: boolean;
  insideSleepWindow?: boolean;
  lastUsageRefreshAt?: string;
  limitReached?: boolean;
  localDate?: string;
  protectionState: string;
  remainingMinutes?: number;
  sessionId: string;
  sessionStatus: string;
  timezone?: string;
  usageAccessGranted?: boolean;
  usedMinutes?: number;
  appVersion?: string;
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

function normalizeOptionalString(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }

  return normalizeRequiredString(value) ?? null;
}

function isOptionalBoolean(value: unknown) {
  return value === undefined || typeof value === "boolean";
}

function isOptionalNonNegativeInteger(value: unknown) {
  return value === undefined || (Number.isInteger(value) && Number(value) >= 0);
}

export function validateHeartbeatInput(input: unknown) {
  if (!input || typeof input !== "object") {
    return { ok: false as const, response: jsonError(400, "Request body must be a JSON object.") };
  }

  const payload = input as Record<string, unknown>;
  const sessionId = normalizeRequiredString(payload.sessionId);
  const deviceName = normalizeRequiredString(payload.deviceName);
  const sessionStatus = normalizeRequiredString(payload.sessionStatus);
  const protectionState = normalizeRequiredString(payload.protectionState);

  if (!sessionId) {
    return { ok: false as const, response: jsonError(400, "sessionId is required.") };
  }

  if (!deviceName) {
    return { ok: false as const, response: jsonError(400, "deviceName is required.") };
  }

  if (!sessionStatus) {
    return { ok: false as const, response: jsonError(400, "sessionStatus is required.") };
  }

  if (!protectionState) {
    return { ok: false as const, response: jsonError(400, "protectionState is required.") };
  }

  if (payload.deviceId !== undefined && normalizeRequiredString(payload.deviceId) === null) {
    return { ok: false as const, response: jsonError(400, "deviceId must be a non-empty string when provided.") };
  }

  if (payload.timezone !== undefined && normalizeRequiredString(payload.timezone) === null) {
    return { ok: false as const, response: jsonError(400, "timezone must be a non-empty string when provided.") };
  }

  if (payload.appVersion !== undefined && normalizeRequiredString(payload.appVersion) === null) {
    return { ok: false as const, response: jsonError(400, "appVersion must be a non-empty string when provided.") };
  }

  if (
    !isOptionalBoolean(payload.forcedSleepEnabled) ||
    !isOptionalBoolean(payload.insideSleepWindow) ||
    !isOptionalBoolean(payload.usageAccessGranted) ||
    !isOptionalBoolean(payload.deviceAdminGranted) ||
    !isOptionalBoolean(payload.blockingActive) ||
    !isOptionalBoolean(payload.limitReached) ||
    !isOptionalBoolean(payload.batteryOptimizationIgnored)
  ) {
    return { ok: false as const, response: jsonError(400, "Heartbeat boolean fields must be booleans when provided.") };
  }

  if (
    !isOptionalNonNegativeInteger(payload.usedMinutes) ||
    !isOptionalNonNegativeInteger(payload.dailyLimitMinutes) ||
    !isOptionalNonNegativeInteger(payload.remainingMinutes)
  ) {
    return {
      ok: false as const,
      response: jsonError(400, "usedMinutes, dailyLimitMinutes, and remainingMinutes must be non-negative integers when provided."),
    };
  }

  if (payload.lastUsageRefreshAt !== undefined && normalizeRequiredString(payload.lastUsageRefreshAt) === null) {
    return { ok: false as const, response: jsonError(400, "lastUsageRefreshAt must be a non-empty string when provided.") };
  }

  if (payload.localDate !== undefined) {
    const localDate = normalizeRequiredString(payload.localDate);
    if (!localDate || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
      return { ok: false as const, response: jsonError(400, "localDate must use YYYY-MM-DD format when provided.") };
    }
  }

  return {
    ok: true as const,
    data: {
      appVersion: normalizeOptionalString(payload.appVersion) ?? undefined,
      batteryOptimizationIgnored: payload.batteryOptimizationIgnored as boolean | undefined,
      blockingActive: payload.blockingActive as boolean | undefined,
      dailyLimitMinutes: payload.dailyLimitMinutes as number | undefined,
      deviceAdminGranted: payload.deviceAdminGranted as boolean | undefined,
      deviceId: normalizeOptionalString(payload.deviceId) ?? undefined,
      deviceName,
      forcedSleepEnabled: payload.forcedSleepEnabled as boolean | undefined,
      insideSleepWindow: payload.insideSleepWindow as boolean | undefined,
      lastUsageRefreshAt: normalizeOptionalString(payload.lastUsageRefreshAt) ?? undefined,
      limitReached: payload.limitReached as boolean | undefined,
      localDate: normalizeOptionalString(payload.localDate) ?? undefined,
      protectionState,
      remainingMinutes: payload.remainingMinutes as number | undefined,
      sessionId,
      sessionStatus,
      timezone: normalizeOptionalString(payload.timezone) ?? undefined,
      usageAccessGranted: payload.usageAccessGranted as boolean | undefined,
      usedMinutes: payload.usedMinutes as number | undefined,
    } satisfies HeartbeatInput,
  };
}
