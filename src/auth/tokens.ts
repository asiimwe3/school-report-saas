/**
 * Session & token primitives. Secrets are only ever compared/held as SHA-256
 * digests — the raw value exists once, on the wire to the user.
 *
 * Refresh tokens rotate by family with reuse detection: presenting an
 * already-rotated token revokes the whole family (stolen-token containment).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256 = (v: string): string =>
  createHash("sha256").update(v).digest("hex");

export const newToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export const newCsrfSecret = (): string => newToken(32);

/** Constant-time digest comparison. */
export function digestMatches(raw: string, storedDigestHex: string): boolean {
  const a = Buffer.from(sha256(raw), "hex");
  const b = Buffer.from(storedDigestHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface RefreshRecord {
  tokenDigest: string;
  family: string;
  expiresAt: number; // epoch ms
  consumedAt?: number;
  revoked?: boolean;
}

/**
 * Pure refresh-rotation state machine over a record store. `now` is injected
 * for deterministic tests. Returns either a new token (and mutates records) or
 * a denial reason. Reuse of a consumed token revokes the entire family.
 */
export function rotateRefresh(
  store: Map<string, RefreshRecord>, // keyed by tokenDigest
  presentedDigest: string,
  now: number,
  ttlMs: number,
  issue: (digest: string, family: string, expiresAt: number) => void
): { ok: true; family: string } | { ok: false; reason: "UNKNOWN" | "EXPIRED" | "REVOKED" | "REUSE" } {
  const rec = store.get(presentedDigest);
  if (!rec) return { ok: false, reason: "UNKNOWN" };
  if (rec.revoked) return { ok: false, reason: "REVOKED" };
  if (rec.expiresAt <= now) return { ok: false, reason: "EXPIRED" };
  if (rec.consumedAt !== undefined) {
    // Reuse: kill the whole family.
    for (const [digest, r] of store) {
      if (r.family === rec.family) r.revoked = true;
    }
    return { ok: false, reason: "REUSE" };
  }
  rec.consumedAt = now;
  const nextDigest = sha256(newToken());
  issue(nextDigest, rec.family, now + ttlMs);
  return { ok: true, family: rec.family };
}

/** Cookie attribute sets — HTTP-only, Secure, SameSite. */
export const SESSION_COOKIE = "srs_session";
export const REFRESH_COOKIE = "srs_refresh";
export const sessionCookieAttrs = (maxAgeSec: number) =>
  `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
export const refreshCookieAttrs = (maxAgeSec: number) =>
  `HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh; Max-Age=${maxAgeSec}`;
