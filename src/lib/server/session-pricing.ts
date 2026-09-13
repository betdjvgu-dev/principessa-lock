import "server-only";

// Mirrors desktop-admin/src/lib/pricing.ts and principessa-lock/.../SessionPricing.kt exactly.
// This is the only server-side copy -- used to stamp sessions.price_usd once at activation time
// so the leaderboard has a trustworthy total instead of trusting a client-computed one, and to
// decide at session-requests creation time whether a request is free enough to auto-approve.
export const GALLERY_ACCESS_PRICE_USD = 0;
export const FULL_DISCRETION_FEE_USD = 0;

// All session options are free; only app unlocks remain paid.
export function calculateDailyLimitFeeUsd(dailyLimitMinutes: number): number {
  return 0;
}

export const SCREEN_TIME_FEE_PER_DAY_USD = 0;
export const SCREEN_TIME_MIN_FEE_USD = 0;

// Unrestricted screen time is free regardless of session length.
export function calculateScreenTimeFeeUsd(sessionDays: number, screenTimeEnabled: boolean): number {
  return 0;
}

// Keep the call signature stable for activation and older request flows.
export function calculateSessionPriceUsd(
  fullDiscretion: boolean,
  galleryAccessEnabled: boolean = false,
  dailyLimitMinutes: number = 60,
  sessionDays: number = 1,
  screenTimeEnabled: boolean = true,
): number {
  return 0;
}

// The admin still needs to choose terms for free full-discretion requests.
export function shouldAutoApproveSessionRequest(fullDiscretion: boolean): boolean {
  return !fullDiscretion;
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
