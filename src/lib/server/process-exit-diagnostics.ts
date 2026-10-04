const REASONS = [
  "unknown", "self_exit", "signaled", "low_memory", "crash", "native_crash", "anr",
  "initialization_failure", "permission_change", "resource_limit", "user_requested",
  "user_stopped", "dependency_died", "other", "freezer", "package_state_change", "package_updated",
] as const;

/** Only expose bounded, non-sensitive historical evidence, never arbitrary device payloads. */
export function normalizeProcessExit(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { reasonCode, occurredAt } = value as Record<string, unknown>;
  if (typeof reasonCode !== "number" || !Number.isInteger(reasonCode) || reasonCode < 0 || reasonCode > 1000) return null;
  if (typeof occurredAt !== "string" || occurredAt.length > 40 || !/^\d{4}-\d\d-\d\dT/.test(occurredAt)) return null;
  const timestamp = Date.parse(occurredAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return { reasonCode, reason: REASONS[reasonCode] ?? "unknown", occurredAt: new Date(timestamp).toISOString() };
}
