import "server-only";

import { createHash, randomInt } from "node:crypto";

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";

function randomCharacters(source: string, length: number) {
  let value = "";

  for (let index = 0; index < length; index += 1) {
    value += source[randomInt(0, source.length)];
  }

  return value;
}

export function normalizeActivationCode(activationCode: string) {
  return activationCode.trim().toUpperCase();
}

export function hashActivationCode(activationCode: string) {
  return createHash("sha256").update(normalizeActivationCode(activationCode)).digest("hex");
}

export function generateActivationCode() {
  return `PRIN-${randomCharacters(LETTERS, 4)}-${randomCharacters(DIGITS, 4)}`;
}

export function normalizePairingCode(pairingCode: string) {
  return pairingCode.trim().toUpperCase();
}

export function hashPairingCode(pairingCode: string) {
  return createHash("sha256").update(normalizePairingCode(pairingCode)).digest("hex");
}

export function generatePairingCode() {
  return `PAIR-${randomCharacters(LETTERS, 4)}-${randomCharacters(DIGITS, 4)}`;
}

