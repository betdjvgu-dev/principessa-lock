import "server-only";

// Mirrors desktop-admin/src/lib/pricing.ts and principessa-lock/.../SessionPricing.kt exactly.
// This is the only server-side copy -- used to stamp sessions.price_usd once at activation time
// so the leaderboard has a trustworthy total instead of trusting a client-computed one, and to
// decide at session-requests creation time whether a request is free enough to auto-approve.
export const GALLERY_ACCESS_PRICE_USD = 0;
export const FULL_DISCRETION_FEE_USD = 10;

// The daily limit is free across its entire 5-90 minute range -- full_discretion is the only
// paid option left. Kept as a function (rather than inlining 0) so callers don't need to know
// that, and so a future tiered fee only has to change here.
export function calculateDailyLimitFeeUsd(dailyLimitMinutes: number): number {
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
