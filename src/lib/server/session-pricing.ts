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

export const SCREEN_TIME_FEE_PER_DAY_USD = 1;
export const SCREEN_TIME_MIN_FEE_USD = 5;

// Paying to go *without* a daily screen-time limit -- the limit itself stays free (it always has
// been, across its whole 5-90 minute range), but choosing unrestricted screen time for the session
// costs money, scaling with session length ($1/day) with a $5 floor so a short session doesn't
// trivially undercut it. Free when screenTimeEnabled is on, since the limit is still doing its job.
export function calculateScreenTimeFeeUsd(sessionDays: number, screenTimeEnabled: boolean): number {
  if (screenTimeEnabled) {
    return 0;
  }
  return Math.max(SCREEN_TIME_MIN_FEE_USD, sessionDays * SCREEN_TIME_FEE_PER_DAY_USD);
}

// full_discretion is a flat fee regardless of the terms the keyholder ends up setting -- the
// tiered daily-limit fee and the screen-time fee only apply to a sub's own chosen terms on a
// normal request, not to whatever the keyholder later decides for a "leave it up to Principessa"
// one (the sub's own submitted sessionDays/dailyLimitMinutes/screenTimeEnabled are just
// placeholders in that mode -- charging based on them would charge for a choice the sub never
// actually made).
export function calculateSessionPriceUsd(
  fullDiscretion: boolean,
  galleryAccessEnabled: boolean = false,
  dailyLimitMinutes: number = 60,
  sessionDays: number = 1,
  screenTimeEnabled: boolean = true,
): number {
  const discretionFee = fullDiscretion ? FULL_DISCRETION_FEE_USD : 0;
  const galleryFee = galleryAccessEnabled ? GALLERY_ACCESS_PRICE_USD : 0;
  const dailyLimitFee = fullDiscretion ? 0 : calculateDailyLimitFeeUsd(dailyLimitMinutes);
  const screenTimeFee = fullDiscretion ? 0 : calculateScreenTimeFeeUsd(sessionDays, screenTimeEnabled);
  return discretionFee + galleryFee + dailyLimitFee + screenTimeFee;
}

// Blocked-app unlock price scales with how much of the session is actually left to unlock for --
// requesting with days left on a long session costs more than requesting near the end of a short
// one, instead of a flat fee regardless of how much value it actually buys. Rounds down to whole
// days, but a request made with under 24h left still charges the $1 floor rather than $0. Mirrors
// principessa-lock/.../SessionPricing.kt (used there only to preview the price client-side before
// requesting -- the amount actually charged/stored is always this server-side copy).
export function calculateAppUnlockPriceUsd(remainingMs: number): number {
  const remainingHours = remainingMs / (1000 * 60 * 60);
  if (remainingHours < 24) {
    return 1;
  }
  return Math.floor(remainingHours / 24);
}
