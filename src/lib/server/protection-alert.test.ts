import { describe, expect, it } from "vitest";
import { mergeProtectionAlert, protectionAlertDue } from "./protection-alert";

describe("protection alert retry", () => {
  it("does not alert on a never-granted permission", () => {
    expect(mergeProtectionAlert(null, "s", null, { usage_access_granted: false })).toBeNull();
  });
  it("retains a failed transition across later heartbeats", () => {
    const pending = mergeProtectionAlert(null, "s", { usage_access_granted: true }, { usage_access_granted: false });
    expect(mergeProtectionAlert(pending, "s", { usage_access_granted: false }, { usage_access_granted: false })).toEqual(pending);
  });
  it("clears recovered permissions and does not carry alerts into a new session", () => {
    const pending = { sessionId: "s", fields: ["usage_access_granted"] };
    expect(mergeProtectionAlert(pending, "s", null, { usage_access_granted: true })).toBeNull();
    expect(mergeProtectionAlert(pending, "new", null, { usage_access_granted: false })).toBeNull();
  });
  it("backs off attempts without pretending a failed push was sent", () => {
    const now = Date.parse("2026-09-07T12:00:00Z");
    expect(protectionAlertDue(now, new Date(now - 30_000).toISOString(), null, null, "missing")).toBe(false);
    expect(protectionAlertDue(now, new Date(now - 60_000).toISOString(), null, null, "missing")).toBe(true);
    expect(protectionAlertDue(now, null, new Date(now - 60_000).toISOString(), "missing", "missing")).toBe(false);
  });
});
