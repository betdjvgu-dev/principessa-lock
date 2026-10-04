export const SETTINGS_ATTEMPT_ALERT_REASON = "Opened Settings during the session";

export const PROTECTION_ALERT_LABELS = {
  accessibility_granted: "Accessibility permission revoked",
  accessibility_running: "Accessibility service stopped running",
  overlay_permission_granted: "Display-over-other-apps revoked",
  device_admin_granted: "Device admin revoked",
  usage_access_granted: "Usage access revoked",
  protection_healthy: "Protection health degraded",
  settings_tamper_attempt: SETTINGS_ATTEMPT_ALERT_REASON,
} as const;

type Field = keyof typeof PROTECTION_ALERT_LABELS;
export type ProtectionSignals = Partial<Record<Field, boolean | null>>;
export type PendingProtectionAlert = { sessionId: string; fields: Field[] };

export function mergeProtectionAlert(
  stored: unknown, sessionId: string, previous: ProtectionSignals | null, current: ProtectionSignals,
  newSettingsAttempt = false,
): PendingProtectionAlert | null {
  const pending = stored as Partial<PendingProtectionAlert> | null;
  const oldFields = pending?.sessionId === sessionId && Array.isArray(pending.fields) ? pending.fields : [];
  const fields = (Object.keys(PROTECTION_ALERT_LABELS) as Field[]).filter((field) =>
    current[field] !== true && (oldFields.includes(field) ||
      (field === "settings_tamper_attempt" && newSettingsAttempt) ||
      (previous?.[field] === true && current[field] === false)),
  );
  return fields.length ? { sessionId, fields } : null;
}

export function settingsAttemptNewlyReported(
  previousReasons: readonly string[] | null | undefined,
  currentReasons: readonly string[] | null | undefined,
): boolean {
  const current = currentReasons ?? [];
  const previous = new Set(previousReasons ?? []);
  return current.includes("settings_tamper_attempt") && !previous.has("settings_tamper_attempt");
}

export function protectionAlertReason(pending: PendingProtectionAlert): string {
  return pending.fields.map((field) => PROTECTION_ALERT_LABELS[field]).join(", ");
}

export function protectionAlertDue(now: number, attemptedAt: string | null, sentAt: string | null,
  lastReason: string | null, reason: string): boolean {
  const elapsed = (at: string | null) => at && Number.isFinite(Date.parse(at)) ? now - Date.parse(at) : Infinity;
  return elapsed(attemptedAt) >= 60_000 && (lastReason !== reason || elapsed(sentAt) >= 30 * 60_000);
}
