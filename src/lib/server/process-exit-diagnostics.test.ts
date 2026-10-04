import { expect, it } from "vitest";
import { normalizeProcessExit } from "./process-exit-diagnostics";

it("normalizes only known fields and derives the reason instead of trusting device labels", () => {
  expect(normalizeProcessExit({ reasonCode: 10, reason: "uninstalled", occurredAt: "2026-10-02T11:44:00+03:00", trace: "private" }))
    .toEqual({ reasonCode: 10, reason: "user_requested", occurredAt: "2026-10-02T08:44:00.000Z" });
});

it("rejects malformed or unbounded process exit diagnostics", () => {
  for (const value of [null, [], "crash", {}, { reasonCode: "4", occurredAt: "2026-10-02T11:44:00Z" },
    { reasonCode: -1, occurredAt: "2026-10-02T11:44:00Z" }, { reasonCode: 4.5, occurredAt: "2026-10-02T11:44:00Z" },
    { reasonCode: 1001, occurredAt: "2026-10-02T11:44:00Z" }, { reasonCode: 4, occurredAt: "invalid" },
    { reasonCode: 4, occurredAt: "2026-".repeat(100) }]) expect(normalizeProcessExit(value)).toBeNull();
});

it("accepts future Android reason codes without inventing a cause", () => {
  expect(normalizeProcessExit({ reasonCode: 99, occurredAt: "2026-10-02T11:44:00Z" })?.reason).toBe("unknown");
});
