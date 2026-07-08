import "server-only";

import { createHash, randomInt } from "node:crypto";

// 32-character alphabet (letters + digits, ambiguous 0/O/1/I/L excluded) across four
// groups gives ~80 bits of entropy, versus the old fixed "PRIN-"/"PAIR-" prefix + 2 groups
// (~30 bits) which also telegraphed the code's purpose via a guessable static prefix.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_GROUP_COUNT = 4;
const CODE_GROUP_LENGTH = 4;

function randomCharacters(source: string, length: number) {
  let value = "";

  for (let index = 0; index < length; index += 1) {
    value += source[randomInt(0, source.length)];
  }

  return value;
}

function generateCode() {
  return Array.from({ length: CODE_GROUP_COUNT }, () => randomCharacters(CODE_ALPHABET, CODE_GROUP_LENGTH)).join("-");
}

export function normalizeActivationCode(activationCode: string) {
  return activationCode.trim().toUpperCase();
}

export function hashActivationCode(activationCode: string) {
  return createHash("sha256").update(normalizeActivationCode(activationCode)).digest("hex");
}

export function generateActivationCode() {
  return generateCode();
}
