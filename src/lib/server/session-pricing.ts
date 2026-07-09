import "server-only";

// Mirrors desktop-admin/src/lib/pricing.ts and principessa-lock/.../SessionPricing.kt exactly.
// This is the only server-side copy -- used to stamp sessions.price_usd once at pair/activate
// time so the leaderboard has a trustworthy total instead of trusting a client-computed one.
const BASE_PRICE_USD = 10;
const PRICE_PER_DAY_USD = 0.5;
const FREE_DAILY_LIMIT_MINUTES = 60;
const PRICE_PER_5_MINUTES_USD = 1;
const GALLERY_ACCESS_PRICE_USD = 10;

// Floor applied to "leave it up to Principessa" (full_discretion) session requests -- the sub
// is told this minimum up front (see FULL_DISCRETION_MINIMUM_PRICE_USD in
// principessa-lock/.../SessionPricing.kt) before the keyholder ever sets real terms, so the
// stored price (and therefore the leaderboard total) must never come out under it regardless
// of how cheap the terms the keyholder ends up choosing are.
export const FULL_DISCRETION_MINIMUM_PRICE_USD = 30;

export function calculateSessionPriceUsd(
  sessionDays: number,
  dailyLimitMinutes: number,
  galleryAccessEnabled: boolean = false,
): number {
  const extraMinutes = Math.max(0, dailyLimitMinutes - FREE_DAILY_LIMIT_MINUTES);
  const extraMinutesPrice = Math.ceil(extraMinutes / 5) * PRICE_PER_5_MINUTES_USD;

  return (
    BASE_PRICE_USD +
    sessionDays * PRICE_PER_DAY_USD +
    extraMinutesPrice +
    (galleryAccessEnabled ? GALLERY_ACCESS_PRICE_USD : 0)
  );
}
