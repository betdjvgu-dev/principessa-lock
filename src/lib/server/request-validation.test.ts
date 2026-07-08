import { describe, expect, it } from "vitest";
import {
  validateActivationInput,
  validateAdminSessionUpdateInput,
  validateFcmTokenInput,
  validateRegisterInput,
  validateRemoteActionCreateInput,
  validateSessionRequestInput,
} from "./request-validation";

async function errorBody(response: Response) {
  return (await response.json()) as { error: string };
}

describe("validateSessionRequestInput", () => {
  const valid = {
    dailyLimitMinutes: 30,
    deviceName: "Pixel 7",
    forcedSleepEnabled: true,
    sessionDays: 3,
  };

  it("accepts a well-formed payload", () => {
    const result = validateSessionRequestInput(valid);
    expect(result.ok).toBe(true);
  });

  it("rejects a missing deviceName", () => {
    const result = validateSessionRequestInput({ ...valid, deviceName: "  " });
    expect(result.ok).toBe(false);
  });

  it("rejects sessionDays out of range", () => {
    const result = validateSessionRequestInput({ ...valid, sessionDays: 31 });
    expect(result.ok).toBe(false);
  });

  it("rejects dailyLimitMinutes out of range", async () => {
    const result = validateSessionRequestInput({ ...valid, dailyLimitMinutes: 91 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((await errorBody(result.response)).error).toMatch(/dailyLimitMinutes/);
    }
  });

  it("rejects a non-object payload", () => {
    expect(validateSessionRequestInput("nope").ok).toBe(false);
    expect(validateSessionRequestInput(null).ok).toBe(false);
  });
});

describe("validateActivationInput", () => {
  it("accepts a well-formed payload", () => {
    const result = validateActivationInput({ activationCode: "AUPQ-8T27-M4KX-2Q7Z", deviceName: "Pixel 7" });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing activationCode", () => {
    const result = validateActivationInput({ deviceName: "Pixel 7" });
    expect(result.ok).toBe(false);
  });

  it("rejects a blank timezone when provided", () => {
    const result = validateActivationInput({ activationCode: "X", deviceName: "Y", timezone: "   " });
    expect(result.ok).toBe(false);
  });
});

describe("validateRegisterInput", () => {
  it("accepts a well-formed payload", () => {
    const result = validateRegisterInput({ deviceName: "Pixel 7", username: "alex_92" });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing username", () => {
    expect(validateRegisterInput({ deviceName: "Pixel 7" }).ok).toBe(false);
  });

  it("rejects a username with invalid characters", () => {
    expect(validateRegisterInput({ deviceName: "Pixel 7", username: "a b!" }).ok).toBe(false);
  });

  it("rejects a username shorter than 3 characters", () => {
    expect(validateRegisterInput({ deviceName: "Pixel 7", username: "ab" }).ok).toBe(false);
  });

  it("rejects a missing deviceName", () => {
    expect(validateRegisterInput({ username: "alex_92" }).ok).toBe(false);
  });
});

describe("validateFcmTokenInput", () => {
  it("accepts a non-empty token", () => {
    expect(validateFcmTokenInput({ fcmToken: "abc123" }).ok).toBe(true);
  });

  it("rejects an empty token", () => {
    expect(validateFcmTokenInput({ fcmToken: "" }).ok).toBe(false);
  });
});

describe("validateRemoteActionCreateInput", () => {
  it("accepts each allowed action type", () => {
    for (const actionType of ["force_lock", "clear_local_usage", "sync_config", "capture_screenshot"]) {
      const result = validateRemoteActionCreateInput({ actionType, sessionId: "session-1" });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects an unknown action type", () => {
    const result = validateRemoteActionCreateInput({ actionType: "wipe_device", sessionId: "session-1" });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing sessionId", () => {
    expect(validateRemoteActionCreateInput({ actionType: "force_lock" }).ok).toBe(false);
  });
});

describe("validateAdminSessionUpdateInput", () => {
  it("rejects an empty payload", () => {
    expect(validateAdminSessionUpdateInput({}).ok).toBe(false);
  });

  it("accepts a partial update", () => {
    expect(validateAdminSessionUpdateInput({ dailyLimitMinutes: 45 }).ok).toBe(true);
  });

  it("rejects both endsAt and extendDays together", () => {
    const result = validateAdminSessionUpdateInput({
      endsAt: new Date().toISOString(),
      extendDays: 3,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts blockedPackages as an array of non-empty strings", () => {
    const result = validateAdminSessionUpdateInput({ blockedPackages: ["com.instagram.android"] });
    expect(result.ok).toBe(true);
  });

  it("rejects blockedPackages containing a blank entry", () => {
    const result = validateAdminSessionUpdateInput({ blockedPackages: ["com.instagram.android", "  "] });
    expect(result.ok).toBe(false);
  });

  describe("weekdayOverrides", () => {
    it("accepts a valid sparse override map", () => {
      const result = validateAdminSessionUpdateInput({
        weekdayOverrides: {
          sat: { dailyLimitMinutes: 60 },
          sun: { dailyLimitMinutes: 60, sleepStartTime: "23:30" },
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.weekdayOverrides?.sat.dailyLimitMinutes).toBe(60);
      }
    });

    it("rejects an unknown weekday key", () => {
      const result = validateAdminSessionUpdateInput({ weekdayOverrides: { someday: { dailyLimitMinutes: 60 } } });
      expect(result.ok).toBe(false);
    });

    it("rejects an out-of-range dailyLimitMinutes override", () => {
      const result = validateAdminSessionUpdateInput({ weekdayOverrides: { mon: { dailyLimitMinutes: 200 } } });
      expect(result.ok).toBe(false);
    });

    it("rejects a malformed sleepStartTime override", () => {
      const result = validateAdminSessionUpdateInput({ weekdayOverrides: { mon: { sleepStartTime: "11pm" } } });
      expect(result.ok).toBe(false);
    });
  });
});
