import { describe, expect, it } from "vitest";
import { mergeProtectionAlert, protectionAlertDue, protectionAlertReason, SETTINGS_ATTEMPT_ALERT_REASON, settingsAttemptNewlyReported } from "./protection-alert";

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
  it("notifies the first Settings attempt and not a repeat of the same heartbeat reason", () => {
    expect(settingsAttemptNewlyReported([], ["settings_tamper_attempt"])).toBe(true);
    expect(settingsAttemptNewlyReported(["settings_tamper_attempt"], ["settings_tamper_attempt"])).toBe(false);
    expect(settingsAttemptNewlyReported(null, ["clock_tamper_detected"])).toBe(false);
  });
  it("backs off attempts without pretending a failed push was sent", () => {
    const now = Date.parse("2026-09-07T12:00:00Z");
    expect(protectionAlertDue(now, new Date(now - 30_000).toISOString(), null, null, "missing")).toBe(false);
    expect(protectionAlertDue(now, new Date(now - 60_000).toISOString(), null, null, "missing")).toBe(true);
    expect(protectionAlertDue(now, null, new Date(now - 60_000).toISOString(), "missing", "missing")).toBe(false);
  });

  it("retains a Settings alert across a failed delivery and repeated heartbeat", () => {
    const pending = mergeProtectionAlert(null, "s", null, {}, true);
    expect(pending).toEqual({ sessionId: "s", fields: ["settings_tamper_attempt"] });
    const repeated = settingsAttemptNewlyReported(["settings_tamper_attempt"], ["settings_tamper_attempt"]);
    expect(mergeProtectionAlert(pending, "s", null, {}, repeated)).toEqual(pending);
    expect(protectionAlertReason(pending!)).toBe(SETTINGS_ATTEMPT_ALERT_REASON);
  });

  it("retains the Settings event during cooldown even after its UI reason disappears", () => {
    const now = Date.parse("2026-10-04T12:00:00Z");
    const pending = mergeProtectionAlert(null, "s", null, {}, true);
    const attemptedAt = new Date(now - 30_000).toISOString();
    expect(protectionAlertDue(now, attemptedAt, null, null, protectionAlertReason(pending!))).toBe(false);
    const retry = mergeProtectionAlert(pending, "s", null, { protection_healthy: true });
    expect(retry).toEqual(pending);
    expect(protectionAlertDue(now + 30_000, attemptedAt, null, null, protectionAlertReason(retry!))).toBe(true);
  });

  it("combines a Settings event and permission loss into one pending notification", () => {
    const pending = mergeProtectionAlert(null, "s", { usage_access_granted: true }, { usage_access_granted: false }, true);
    expect(pending?.fields).toEqual(["usage_access_granted", "settings_tamper_attempt"]);
    expect(protectionAlertReason(pending!)).toContain(SETTINGS_ATTEMPT_ALERT_REASON);
  });

  it("does not resurrect an acknowledged Settings event or carry it into another session", () => {
    expect(mergeProtectionAlert(null, "s", null, {}, false)).toBeNull();
    expect(mergeProtectionAlert({ sessionId: "old", fields: ["settings_tamper_attempt"] }, "new", null, {})).toBeNull();
  });
});
