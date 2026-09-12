type SleepOverride = { sleepStartTime?: string; sleepEndTime?: string };

/** Validate effective times, including an override that inherits half of its window. */
export function sleepWindowError(start: string, end: string, overrides: Record<string, unknown> = {}): string | null {
  const valid = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const pairError = (a: string, b: string) =>
    !valid.test(a) || !valid.test(b) ? "Sleep times must use HH:mm format." :
      a === b ? "Sleep start and end must be different." : null;
  const baseError = pairError(start, end);
  if (baseError) return baseError;
  for (const [day, value] of Object.entries(overrides)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `Invalid sleep override for ${day}.`;
    const override = value as SleepOverride;
    const error = pairError(override.sleepStartTime ?? start, override.sleepEndTime ?? end);
    if (error) return `${day}: ${error}`;
  }
  return null;
}
