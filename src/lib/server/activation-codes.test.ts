import { describe, expect, it } from "vitest";
import {
  generateActivationCode,
  generatePairingCode,
  hashActivationCode,
  hashPairingCode,
  normalizeActivationCode,
  normalizePairingCode,
} from "./activation-codes";

const CODE_FORMAT = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

describe("generateActivationCode", () => {
  it("produces four dash-separated groups of four characters", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateActivationCode()).toMatch(CODE_FORMAT);
    }
  });

  it("excludes ambiguous characters (0, O, 1, I)", () => {
    const code = generateActivationCode();
    expect(code).not.toMatch(/[0OI1]/);
  });

  it("is not practically deterministic across calls", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateActivationCode()));
    expect(codes.size).toBe(20);
  });
});

describe("generatePairingCode", () => {
  it("produces the same format as activation codes", () => {
    expect(generatePairingCode()).toMatch(CODE_FORMAT);
  });
});

describe("normalizeActivationCode / hashActivationCode", () => {
  it("normalizes case and surrounding whitespace before hashing", () => {
    const raw = "abcd-2345-efgh-6789";
    expect(normalizeActivationCode(`  ${raw}  `)).toBe(raw.toUpperCase());
    expect(hashActivationCode(raw)).toBe(hashActivationCode(`  ${raw.toUpperCase()}  `));
  });

  it("produces different hashes for different codes", () => {
    expect(hashActivationCode("AAAA-2222-BBBB-3333")).not.toBe(hashActivationCode("AAAA-2222-BBBB-3334"));
  });
});

describe("normalizePairingCode / hashPairingCode", () => {
  it("normalizes case the same way as activation codes", () => {
    const raw = "wxyz-9876-mnop-5432";
    expect(normalizePairingCode(raw)).toBe(raw.toUpperCase());
    expect(hashPairingCode(raw)).toBe(hashPairingCode(raw.toUpperCase()));
  });
});
