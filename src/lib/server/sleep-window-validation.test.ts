import { describe, expect, it } from "vitest";
import { sleepWindowError } from "./sleep-window-validation";

describe("effective sleep windows", () => {
  it("allows daytime and overnight windows", () => {
    expect(sleepWindowError("23:00", "07:00")).toBeNull();
    expect(sleepWindowError("09:00", "17:00")).toBeNull();
  });
  it("rejects equal times instead of treating them as a full day", () => {
    expect(sleepWindowError("07:00", "07:00")).toContain("different");
  });
  it("validates a partial patch against existing times", () => {
    const existing = { start: "23:00", end: "07:00" };
    expect(sleepWindowError("07:00", existing.end)).toContain("different");
  });
  it("checks inherited weekday boundaries", () => {
    expect(sleepWindowError("23:00", "07:00", { mon: { sleepStartTime: "07:00" } })).toContain("mon:");
    expect(sleepWindowError("23:00", "07:00", { tue: { sleepEndTime: "23:00" } })).toContain("tue:");
    expect(sleepWindowError("23:00", "07:00", { mon: { dailyLimitMinutes: 30 } })).toBeNull();
  });
  it("rejects invalid formats", () => {
    for (const value of ["24:00", "7:00", "noon", "23:60"]) expect(sleepWindowError(value, "07:00")).not.toBeNull();
  });
});
