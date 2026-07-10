import "server-only";

// Mirrors desktop-admin/src/lib/pricing.ts and principessa-lock/.../SessionPricing.kt exactly.
// This is the only server-side copy -- used to stamp sessions.price_usd once at activation time
// so the leaderboard has a trustworthy total instead of trusting a client-computed one.
export const GALLERY_ACCESS_PRICE_USD = 5;
export const FULL_DISCRETION_FEE_USD = 15;

// Tiered by distance from the free 30-60 min band -- a daily limit is free in that band, and
// gets more expensive the further it goes in *either* direction (stricter below 30, more
// lenient above 60). Default is 60 (free, top of the band).
export function calculateDailyLimitFeeUsd(dailyLimitMinutes: number): number {
  if (dailyLimitMinutes >= 30 && dailyLimitMinutes <= 60) {
    return 0;
  }
  if (dailyLimitMinutes >= 10 && dailyLimitMinutes <= 29) {
    return 5;
  }
  if (dailyLimitMinutes >= 5 && dailyLimitMinutes <= 9) {
    return 10;
  }
  if (dailyLimitMinutes >= 61 && dailyLimitMinutes <= 75) {
    return 5;
  }
  if (dailyLimitMinutes >= 76 && dailyLimitMinutes <= 90) {
    return 10;
  }
  return 0;
}

// full_discretion is a flat fee regardless of the terms the keyholder ends up setting -- the
// tiered daily-limit fee only applies to a sub's own chosen limit on a normal request, not to
// whatever the keyholder later decides for a "leave it up to Principessa" one.
export function calculateSessionPriceUsd(
  fullDiscretion: boolean,
  galleryAccessEnabled: boolean = false,
  dailyLimitMinutes: number = 60,
): number {
  const discretionFee = fullDiscretion ? FULL_DISCRETION_FEE_USD : 0;
  const galleryFee = galleryAccessEnabled ? GALLERY_ACCESS_PRICE_USD : 0;
  const dailyLimitFee = fullDiscretion ? 0 : calculateDailyLimitFeeUsd(dailyLimitMinutes);
  return discretionFee + galleryFee + dailyLimitFee;
}
