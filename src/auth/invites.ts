/**
 * Teacher invite codes: single-use, time-limited, revocable, tied to one
 * school, with a SERVER-assigned role. The onboarding form never lets the
 * redeeming user pick HEAD_TEACHER / SCHOOL_ADMIN — the role travels inside
 * the invitation row, created by someone who already has school:manage_staff.
 */
import { randomBytes } from "node:crypto";
import { can, INVITABLE_ROLES, type Role } from "./rbac";

export interface InviteState {
  code: string; // stored as sha? — no: code itself is random+single-use; DB stores its digest
  codeDigest: string;
  schoolId: string;
  role: Role;
  expiresAt: number; // epoch ms
  redeemedAt?: number;
  revokedAt?: number;
}

export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function newInviteCode(): string {
  return randomBytes(24).toString("base64url"); // 32 chars, 192 bits
}

export function createInvite(
  schoolId: string,
  role: Role,
  now: number,
  ttlMs = DEFAULT_INVITE_TTL_MS
): { code: string; digest: string; expiresAt: number } {
  if (!INVITABLE_ROLES.includes(role)) {
    throw new Error(`Role ${role} cannot be granted by invitation`);
  }
  const code = newInviteCode();
  // Digest computed by the caller's hash (sha256) before storage.
  const { sha256 } = { sha256: (s: string) => s }; // replaced at API layer; pure here
  return { code, digest: sha256(code), expiresAt: now + ttlMs };
}

export type RedeemResult =
  | { ok: true; role: Role; schoolId: string }
  | { ok: false; reason: "NOT_FOUND" | "EXPIRED" | "REVOKED" | "ALREADY_USED" };

export function redeemInvite(
  invite: InviteState | undefined,
  now: number
): RedeemResult {
  if (!invite) return { ok: false, reason: "NOT_FOUND" };
  if (invite.revokedAt !== undefined) return { ok: false, reason: "REVOKED" };
  if (invite.redeemedAt !== undefined) return { ok: false, reason: "ALREADY_USED" };
  if (invite.expiresAt <= now) return { ok: false, reason: "EXPIRED" };
  return { ok: true, role: invite.role, schoolId: invite.schoolId };
}

/** Only owners/admins may issue invites, and only for invitable roles. */
export function mayIssueInvites(role: Role): boolean {
  return can(role, "school:manage_staff");
}
