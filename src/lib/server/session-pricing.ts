import "server-only";

// Mirrors desktop-admin/src/lib/pricing.ts and principessa-lock/.../SessionPricing.kt exactly.
// This is the only server-side copy -- used to stamp sessions.price_usd once at pair/activate
// time so the leaderboard has a trustworthy total instead of trusting a client-computed one.
const BASE_PRICE_USD = 10;
const PRICE_PER_DAY_USD = 1;
const FREE_DAILY_LIMIT_MINUTES = 60;
const PRICE_PER_5_MINUTES_USD = 1;
const GALLERY_ACCESS_PRICE_USD = 10;

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
