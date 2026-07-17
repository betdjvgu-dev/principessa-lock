import { describe, expect, it } from "vitest";
import { getSuccessfullyCompletedDays } from "./leaderboard";

const now = new Date("2026-07-17T12:00:00.000Z");

describe("getSuccessfullyCompletedDays", () => {
  it("does not award configured days when a session has just started", () => {
    expect(
      getSuccessfullyCompletedDays(
        {
          ends_at: "2026-07-20T12:00:00.000Z",
          session_days: 3,
          starts_at: "2026-07-17T11:00:00.000Z",
          status: "active",
        },
        now,
      ),
    ).toBe(0);
  });

  it("awards only fully survived days and caps them at the configured duration", () => {
    expect(
      getSuccessfullyCompletedDays(
        {
          ends_at: "2026-07-20T12:00:00.000Z",
          session_days: 3,
          starts_at: "2026-07-15T11:00:00.000Z",
          status: "active",
        },
        now,
      ),
    ).toBe(2);
  });

  it("does not award revoked sessions", () => {
    expect(
      getSuccessfullyCompletedDays(
        {
          ends_at: "2026-07-20T12:00:00.000Z",
          session_days: 30,
          starts_at: "2026-06-01T12:00:00.000Z",
          status: "revoked",
        },
        now,
      ),
    ).toBe(0);
  });
});
