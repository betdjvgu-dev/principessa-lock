const DAY_MS = 24 * 60 * 60 * 1000;

export type LeaderboardSession = {
  ends_at: string | null;
  session_days: number | null;
  starts_at: string | null;
  status: string | null;
};

export function getSuccessfullyCompletedDays(session: LeaderboardSession, now = new Date()): number {
  if (session.status !== "active" && session.status !== "completed") {
    return 0;
  }

  const configuredDays = Math.max(0, Math.trunc(session.session_days ?? 0));
  const startsAt = Date.parse(session.starts_at ?? "");
  const endsAt = Date.parse(session.ends_at ?? "");
  const nowAt = now.getTime();

  if (configuredDays === 0 || !Number.isFinite(startsAt) || !Number.isFinite(endsAt) || nowAt <= startsAt) {
    return 0;
  }

  const successfullySurvivedUntil = Math.min(nowAt, endsAt);
  const elapsedFullDays = Math.floor(Math.max(0, successfullySurvivedUntil - startsAt) / DAY_MS);

  return Math.min(configuredDays, elapsedFullDays);
}
