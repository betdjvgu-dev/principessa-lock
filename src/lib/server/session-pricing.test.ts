import { describe, expect, it } from "vitest";
import { calculateSessionPriceUsd, calculateScreenTimeFeeUsd, calculateAppUnlockPriceUsd, shouldAutoApproveSessionRequest } from "./session-pricing";

describe("free session options", () => {
  it("charges zero for all option combinations, including unrestricted time", () => {
    for (const discretion of [true, false]) for (const gallery of [true, false]) {
      for (const screenTime of [true, false]) for (const days of [1, 7, 30]) {
        expect(calculateSessionPriceUsd(discretion, gallery, 150, days, screenTime)).toBe(0);
        expect(calculateScreenTimeFeeUsd(days, screenTime)).toBe(0);
      }
    }
  });
  it("still waits for admin-selected discretionary terms", () => {
    expect(shouldAutoApproveSessionRequest(true)).toBe(false);
    expect(shouldAutoApproveSessionRequest(false)).toBe(true);
  });
  it("preserves the paid app-unlock formula", () => {
    const day = 86_400_000;
    expect(calculateAppUnlockPriceUsd(0)).toBe(1);
    expect(calculateAppUnlockPriceUsd(day - 1)).toBe(1);
    expect(calculateAppUnlockPriceUsd(day)).toBe(1);
    expect(calculateAppUnlockPriceUsd(day * 2.5)).toBe(2);
    expect(calculateAppUnlockPriceUsd(day * 30)).toBe(30);
  });
});
