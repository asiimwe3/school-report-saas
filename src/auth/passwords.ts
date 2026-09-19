/**
 * Password hashing — scrypt (modern, memory-hard, in node:crypto, no native
 * build deps). Stored format: scrypt$N$r$p$<salt-b64>$<hash-b64>.
 * Verification is timing-safe. MFA-ready: see authMethod on the User model.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = parts[1]!, r = parts[2]!, p = parts[3]!, saltB64 = parts[4]!, hashB64 = parts[5]!;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(expected, actual);
}

/** Password policy: min 10 chars; schools handle children's data. */
export function isAcceptablePassword(pw: string): boolean {
  return typeof pw === "string" && pw.length >= 10 && pw.length <= 200;
}
