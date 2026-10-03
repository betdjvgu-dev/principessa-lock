import { describe, expect, it } from "vitest";
import { getSuccessfullyCompletedDays } from "./leaderboard";

const now = new Date("2026-07-17T12:00:00.000Z");

describe("getSuccessfullyCompletedDays", () => {
  it("does not award past or current paused time", () => {
    expect(getSuccessfullyCompletedDays({ status: "active", session_days: 7,
      starts_at: "2026-07-14T12:00:00Z", ends_at: "2026-07-21T12:00:00Z",
      total_paused_ms: 24 * 60 * 60 * 1000, paused_at: "2026-07-16T12:00:00Z" }, now)).toBe(1);
  });
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
