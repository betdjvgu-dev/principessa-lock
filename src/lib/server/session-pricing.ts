import "server-only";

// Mirrors desktop-admin/src/lib/pricing.ts and principessa-lock/.../SessionPricing.kt exactly.
// This is the only server-side copy -- used to stamp sessions.price_usd once at activation time
// so the leaderboard has a trustworthy total instead of trusting a client-computed one.
//
// Session duration (days) and the daily time limit are entirely free -- only these two opt-in
// premium features carry a flat fee. Neither scales with session length/limit.
export const GALLERY_ACCESS_PRICE_USD = 10;
export const FULL_DISCRETION_FEE_USD = 10;

export function calculateSessionPriceUsd(fullDiscretion: boolean, galleryAccessEnabled: boolean = false): number {
  return (fullDiscretion ? FULL_DISCRETION_FEE_USD : 0) + (galleryAccessEnabled ? GALLERY_ACCESS_PRICE_USD : 0);
}
