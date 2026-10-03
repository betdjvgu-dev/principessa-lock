export type UsageHistoryEntry = { sessionId?: string; localDate: string; usedMinutes: number; dailyLimitMinutes: number };
export function validUsageHistory(input: unknown): input is UsageHistoryEntry[] {
  if (!Array.isArray(input) || input.length > 31) return false;
  const latest = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dates = new Set<string>();
  return input.every(row => {
    if (!row || typeof row !== "object" || typeof row.localDate !== "string" ||
      (row.sessionId !== undefined && (typeof row.sessionId !== "string" || !/^[a-f0-9-]{36}$/i.test(row.sessionId))) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.localDate) || row.localDate > latest || dates.has(`${row.sessionId ?? ""}|${row.localDate}`)) return false;
    const date = new Date(`${row.localDate}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== row.localDate) return false;
    dates.add(`${row.sessionId ?? ""}|${row.localDate}`);
    return Number.isInteger(row.usedMinutes) && row.usedMinutes >= 0 && row.usedMinutes <= 2880 &&
      Number.isInteger(row.dailyLimitMinutes) && row.dailyLimitMinutes >= 5 && row.dailyLimitMinutes <= 2880;
  });
}
