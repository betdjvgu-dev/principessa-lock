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
  accessibilityGranted?: boolean;
  accessibilityRunning?: boolean;
  activeSessionPresent?: boolean;
  batteryOptimizationIgnored?: boolean;
  blockingActive?: boolean;
  blockingMethod?: string;
  blockingRequired?: boolean;
  dailyLimitMinutes?: number;
  deviceAdminGranted?: boolean;
  deviceId?: string;
  deviceName: string;
  forcedSleepEnabled?: boolean;
  forcedSleepReady?: boolean;
  insideSleepWindow?: boolean;
  lastAccessibilityEventAt?: string;
  lastProtectionTickAt?: string;
  lastRemoteActionCheckAt?: string;
  lastRecoveryAttemptAt?: string;
  lastRecoveryReason?: string;
  lastSessionSyncAt?: string;
  lastProtectionCheckAt?: string;
  lastUsageRefreshAt?: string;
  limitReached?: boolean;
  localDate?: string;
  networkConnected?: boolean;
  overlayActive?: boolean;
  overlayPermissionGranted?: boolean;
  overlayReady?: boolean;
  pollingIntervalMs?: number;
  pollingMode?: string;
  foregroundServiceRunning?: boolean;
  protectionBrokenReasons?: string[];
  protectionHealthy?: boolean;
  protectionHealthLevel?: string;
  protectionHealthStatus?: string;
  protectionState: string;
  remainingMinutes?: number;
  serviceRunning?: boolean;
  sessionId: string;
  sessionStatus: string;
  timezone?: string;
  remoteActionQueueLength?: number;
  usageAccessGranted?: boolean;
  usedMinutes?: number;
  appVersion?: string;
};

export type RemoteActionCreateInput = {
  actionType: "clear_local_usage" | "force_lock" | "sync_config";
  deviceId?: string;
  payload?: Record<string, unknown>;
  sessionId: string;
};

export type RemoteActionCompleteInput = {
  errorMessage?: string;
  ok: boolean;
  result?: Record<string, unknown>;
};

export type AdminSessionUpdateInput = {
  dailyLimitMinutes?: number;
  endsAt?: string;
  extendDays?: number;
  forcedSleepEnabled?: boolean;
  sleepEndTime?: string;
  sleepStartTime?: string;
  status?: "revoked";
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

const TIME_VALUE_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

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

function isOptionalStringArray(value: unknown) {
  return value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0));
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
    !isOptionalBoolean(payload.activeSessionPresent) ||
    !isOptionalBoolean(payload.accessibilityGranted) ||
    !isOptionalBoolean(payload.accessibilityRunning) ||
    !isOptionalBoolean(payload.forcedSleepEnabled) ||
    !isOptionalBoolean(payload.forcedSleepReady) ||
    !isOptionalBoolean(payload.insideSleepWindow) ||
    !isOptionalBoolean(payload.usageAccessGranted) ||
    !isOptionalBoolean(payload.deviceAdminGranted) ||
    !isOptionalBoolean(payload.blockingRequired) ||
    !isOptionalBoolean(payload.blockingActive) ||
    !isOptionalBoolean(payload.overlayPermissionGranted) ||
    !isOptionalBoolean(payload.overlayReady) ||
    !isOptionalBoolean(payload.overlayActive) ||
    !isOptionalBoolean(payload.networkConnected) ||
    !isOptionalBoolean(payload.limitReached) ||
    !isOptionalBoolean(payload.batteryOptimizationIgnored) ||
    !isOptionalBoolean(payload.protectionHealthy) ||
    !isOptionalBoolean(payload.serviceRunning) ||
    !isOptionalBoolean(payload.foregroundServiceRunning)
  ) {
    return { ok: false as const, response: jsonError(400, "Heartbeat boolean fields must be booleans when provided.") };
  }

  if (
    !isOptionalNonNegativeInteger(payload.usedMinutes) ||
    !isOptionalNonNegativeInteger(payload.dailyLimitMinutes) ||
    !isOptionalNonNegativeInteger(payload.remainingMinutes) ||
    !isOptionalNonNegativeInteger(payload.pollingIntervalMs) ||
    !isOptionalNonNegativeInteger(payload.remoteActionQueueLength)
  ) {
    return {
      ok: false as const,
      response: jsonError(400, "Heartbeat integer fields must be non-negative integers when provided."),
    };
  }

  if (payload.protectionHealthStatus !== undefined && normalizeRequiredString(payload.protectionHealthStatus) === null) {
    return { ok: false as const, response: jsonError(400, "protectionHealthStatus must be a non-empty string when provided.") };
  }

  if (payload.protectionHealthLevel !== undefined && normalizeRequiredString(payload.protectionHealthLevel) === null) {
    return { ok: false as const, response: jsonError(400, "protectionHealthLevel must be a non-empty string when provided.") };
  }

  if (!isOptionalStringArray(payload.protectionBrokenReasons)) {
    return { ok: false as const, response: jsonError(400, "protectionBrokenReasons must be a string array when provided.") };
  }

  if (payload.blockingMethod !== undefined && normalizeRequiredString(payload.blockingMethod) === null) {
    return { ok: false as const, response: jsonError(400, "blockingMethod must be a non-empty string when provided.") };
  }

  if (payload.lastProtectionCheckAt !== undefined && normalizeRequiredString(payload.lastProtectionCheckAt) === null) {
    return { ok: false as const, response: jsonError(400, "lastProtectionCheckAt must be a non-empty string when provided.") };
  }

  if (payload.lastAccessibilityEventAt !== undefined && normalizeRequiredString(payload.lastAccessibilityEventAt) === null) {
    return { ok: false as const, response: jsonError(400, "lastAccessibilityEventAt must be a non-empty string when provided.") };
  }

  if (payload.lastProtectionTickAt !== undefined && normalizeRequiredString(payload.lastProtectionTickAt) === null) {
    return { ok: false as const, response: jsonError(400, "lastProtectionTickAt must be a non-empty string when provided.") };
  }

  if (payload.lastRemoteActionCheckAt !== undefined && normalizeRequiredString(payload.lastRemoteActionCheckAt) === null) {
    return { ok: false as const, response: jsonError(400, "lastRemoteActionCheckAt must be a non-empty string when provided.") };
  }

  if (payload.lastRecoveryAttemptAt !== undefined && normalizeRequiredString(payload.lastRecoveryAttemptAt) === null) {
    return { ok: false as const, response: jsonError(400, "lastRecoveryAttemptAt must be a non-empty string when provided.") };
  }

  if (payload.lastRecoveryReason !== undefined && normalizeRequiredString(payload.lastRecoveryReason) === null) {
    return { ok: false as const, response: jsonError(400, "lastRecoveryReason must be a non-empty string when provided.") };
  }

  if (payload.lastUsageRefreshAt !== undefined && normalizeRequiredString(payload.lastUsageRefreshAt) === null) {
    return { ok: false as const, response: jsonError(400, "lastUsageRefreshAt must be a non-empty string when provided.") };
  }

  if (payload.lastSessionSyncAt !== undefined && normalizeRequiredString(payload.lastSessionSyncAt) === null) {
    return { ok: false as const, response: jsonError(400, "lastSessionSyncAt must be a non-empty string when provided.") };
  }

  if (payload.pollingMode !== undefined && normalizeRequiredString(payload.pollingMode) === null) {
    return { ok: false as const, response: jsonError(400, "pollingMode must be a non-empty string when provided.") };
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
      activeSessionPresent: payload.activeSessionPresent as boolean | undefined,
      accessibilityGranted: payload.accessibilityGranted as boolean | undefined,
      accessibilityRunning: payload.accessibilityRunning as boolean | undefined,
      appVersion: normalizeOptionalString(payload.appVersion) ?? undefined,
      batteryOptimizationIgnored: payload.batteryOptimizationIgnored as boolean | undefined,
      blockingActive: payload.blockingActive as boolean | undefined,
      blockingMethod: normalizeOptionalString(payload.blockingMethod) ?? undefined,
      blockingRequired: payload.blockingRequired as boolean | undefined,
      dailyLimitMinutes: payload.dailyLimitMinutes as number | undefined,
      deviceAdminGranted: payload.deviceAdminGranted as boolean | undefined,
      deviceId: normalizeOptionalString(payload.deviceId) ?? undefined,
      deviceName,
      foregroundServiceRunning: payload.foregroundServiceRunning as boolean | undefined,
      forcedSleepEnabled: payload.forcedSleepEnabled as boolean | undefined,
      forcedSleepReady: payload.forcedSleepReady as boolean | undefined,
      insideSleepWindow: payload.insideSleepWindow as boolean | undefined,
      lastAccessibilityEventAt: normalizeOptionalString(payload.lastAccessibilityEventAt) ?? undefined,
      lastProtectionTickAt: normalizeOptionalString(payload.lastProtectionTickAt) ?? undefined,
      lastRemoteActionCheckAt: normalizeOptionalString(payload.lastRemoteActionCheckAt) ?? undefined,
      lastRecoveryAttemptAt: normalizeOptionalString(payload.lastRecoveryAttemptAt) ?? undefined,
      lastRecoveryReason: normalizeOptionalString(payload.lastRecoveryReason) ?? undefined,
      lastProtectionCheckAt: normalizeOptionalString(payload.lastProtectionCheckAt) ?? undefined,
      lastSessionSyncAt: normalizeOptionalString(payload.lastSessionSyncAt) ?? undefined,
      lastUsageRefreshAt: normalizeOptionalString(payload.lastUsageRefreshAt) ?? undefined,
      limitReached: payload.limitReached as boolean | undefined,
      localDate: normalizeOptionalString(payload.localDate) ?? undefined,
      networkConnected: payload.networkConnected as boolean | undefined,
      overlayActive: payload.overlayActive as boolean | undefined,
      overlayPermissionGranted: payload.overlayPermissionGranted as boolean | undefined,
      overlayReady: payload.overlayReady as boolean | undefined,
      pollingIntervalMs: payload.pollingIntervalMs as number | undefined,
      pollingMode: normalizeOptionalString(payload.pollingMode) ?? undefined,
      protectionBrokenReasons: (payload.protectionBrokenReasons as string[] | undefined) ?? undefined,
      protectionHealthy: payload.protectionHealthy as boolean | undefined,
      protectionHealthLevel: normalizeOptionalString(payload.protectionHealthLevel) ?? undefined,
      protectionHealthStatus: normalizeOptionalString(payload.protectionHealthStatus) ?? undefined,
      protectionState,
      remainingMinutes: payload.remainingMinutes as number | undefined,
      serviceRunning: payload.serviceRunning as boolean | undefined,
      sessionId,
      sessionStatus,
      timezone: normalizeOptionalString(payload.timezone) ?? undefined,
      remoteActionQueueLength: payload.remoteActionQueueLength as number | undefined,
      usageAccessGranted: payload.usageAccessGranted as boolean | undefined,
      usedMinutes: payload.usedMinutes as number | undefined,
    } satisfies HeartbeatInput,
  };
}

const ALLOWED_REMOTE_ACTIONS = new Set(["force_lock", "clear_local_usage", "sync_config"]);

export function validateRemoteActionCreateInput(input: unknown) {
  if (!input || typeof input !== "object") {
    return { ok: false as const, response: jsonError(400, "Request body must be a JSON object.") };
  }

  const payload = input as Record<string, unknown>;
  const sessionId = normalizeRequiredString(payload.sessionId);
  const actionType = normalizeRequiredString(payload.actionType);

  if (!sessionId) {
    return { ok: false as const, response: jsonError(400, "sessionId is required.") };
  }

  if (!actionType || !ALLOWED_REMOTE_ACTIONS.has(actionType)) {
    return { ok: false as const, response: jsonError(400, "actionType must be one of: force_lock, clear_local_usage, sync_config.") };
  }

  if (payload.deviceId !== undefined && normalizeRequiredString(payload.deviceId) === null) {
    return { ok: false as const, response: jsonError(400, "deviceId must be a non-empty string when provided.") };
  }

  if (payload.payload !== undefined && (typeof payload.payload !== "object" || payload.payload === null || Array.isArray(payload.payload))) {
    return { ok: false as const, response: jsonError(400, "payload must be a JSON object when provided.") };
  }

  return {
    ok: true as const,
    data: {
      actionType: actionType as RemoteActionCreateInput["actionType"],
      deviceId: normalizeOptionalString(payload.deviceId) ?? undefined,
      payload: (payload.payload as Record<string, unknown> | undefined) ?? {},
      sessionId,
    } satisfies RemoteActionCreateInput,
  };
}

export function validateRemoteActionCompleteInput(input: unknown) {
  if (!input || typeof input !== "object") {
    return { ok: false as const, response: jsonError(400, "Request body must be a JSON object.") };
  }

  const payload = input as Record<string, unknown>;

  if (typeof payload.ok !== "boolean") {
    return { ok: false as const, response: jsonError(400, "ok must be a boolean.") };
  }

  if (payload.result !== undefined && (typeof payload.result !== "object" || payload.result === null || Array.isArray(payload.result))) {
    return { ok: false as const, response: jsonError(400, "result must be a JSON object when provided.") };
  }

  if (payload.errorMessage !== undefined && normalizeRequiredString(payload.errorMessage) === null) {
    return { ok: false as const, response: jsonError(400, "errorMessage must be a non-empty string when provided.") };
  }

  return {
    ok: true as const,
    data: {
      errorMessage: normalizeOptionalString(payload.errorMessage) ?? undefined,
      ok: payload.ok,
      result: (payload.result as Record<string, unknown> | undefined) ?? {},
    } satisfies RemoteActionCompleteInput,
  };
}

export function validateAdminSessionUpdateInput(input: unknown) {
  if (!input || typeof input !== "object") {
    return { ok: false as const, response: jsonError(400, "Request body must be a JSON object.") };
  }

  const payload = input as Record<string, unknown>;

  if (Object.keys(payload).length === 0) {
    return { ok: false as const, response: jsonError(400, "At least one session field must be provided.") };
  }

  if (payload.dailyLimitMinutes !== undefined && !isIntegerInRange(payload.dailyLimitMinutes, 5, 90)) {
    return {
      ok: false as const,
      response: jsonError(400, "dailyLimitMinutes must be an integer between 5 and 90."),
    };
  }

  if (payload.forcedSleepEnabled !== undefined && typeof payload.forcedSleepEnabled !== "boolean") {
    return { ok: false as const, response: jsonError(400, "forcedSleepEnabled must be a boolean when provided.") };
  }

  if (payload.sleepStartTime !== undefined) {
    const sleepStartTime = normalizeRequiredString(payload.sleepStartTime);
    if (!sleepStartTime || !TIME_VALUE_REGEX.test(sleepStartTime)) {
      return { ok: false as const, response: jsonError(400, "sleepStartTime must use HH:mm format when provided.") };
    }
  }

  if (payload.sleepEndTime !== undefined) {
    const sleepEndTime = normalizeRequiredString(payload.sleepEndTime);
    if (!sleepEndTime || !TIME_VALUE_REGEX.test(sleepEndTime)) {
      return { ok: false as const, response: jsonError(400, "sleepEndTime must use HH:mm format when provided.") };
    }
  }

  if (payload.endsAt !== undefined) {
    const endsAt = normalizeRequiredString(payload.endsAt);
    if (!endsAt || Number.isNaN(new Date(endsAt).getTime())) {
      return { ok: false as const, response: jsonError(400, "endsAt must be a valid timestamp when provided.") };
    }
  }

  if (payload.extendDays !== undefined && !isIntegerInRange(payload.extendDays, 1, 30)) {
    return { ok: false as const, response: jsonError(400, "extendDays must be an integer between 1 and 30.") };
  }

  if (payload.endsAt !== undefined && payload.extendDays !== undefined) {
    return { ok: false as const, response: jsonError(400, "Provide either endsAt or extendDays, not both.") };
  }

  if (payload.status !== undefined && payload.status !== "revoked") {
    return { ok: false as const, response: jsonError(400, "status can only be set to revoked.") };
  }

  return {
    ok: true as const,
    data: {
      dailyLimitMinutes: payload.dailyLimitMinutes as number | undefined,
      endsAt: normalizeOptionalString(payload.endsAt) ?? undefined,
      extendDays: payload.extendDays as number | undefined,
      forcedSleepEnabled: payload.forcedSleepEnabled as boolean | undefined,
      sleepEndTime: normalizeOptionalString(payload.sleepEndTime) ?? undefined,
      sleepStartTime: normalizeOptionalString(payload.sleepStartTime) ?? undefined,
      status: (payload.status as "revoked" | undefined) ?? undefined,
    } satisfies AdminSessionUpdateInput,
  };
}
