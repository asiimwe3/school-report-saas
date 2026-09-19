import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, isAcceptablePassword } from "../src/auth/passwords";
import {
  digestMatches,
  rotateRefresh,
  sha256,
  sessionCookieAttrs,
} from "../src/auth/tokens";
import { can, canTeacher, INVITABLE_ROLES, type AssignmentRef } from "../src/auth/rbac";
import { requireScope, scoped, TenantAccessError, type MembershipRef } from "../src/auth/tenant";
import { redeemInvite, DEFAULT_INVITE_TTL_MS, type InviteState } from "../src/auth/invites";
import { createRateLimiter } from "../src/http/rateLimit";

describe("passwords", () => {
  it("hashes and verifies", () => {
    const h = hashPassword("CorrectHorse9!");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("CorrectHorse9!", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
  });

  it("produces unique salts (different hashes for same password)", () => {
    expect(hashPassword("SamePassword1")).not.toBe(hashPassword("SamePassword1"));
  });

  it("rejects short passwords by policy", () => {
    expect(isAcceptablePassword("short")).toBe(false);
    expect(isAcceptablePassword("0123456789")).toBe(true);
  });
});

describe("tokens", () => {
  it("digest matching is exact", () => {
    const raw = "abc123";
    expect(digestMatches(raw, sha256(raw))).toBe(true);
    expect(digestMatches("other", sha256(raw))).toBe(false);
  });

  it("session cookies are HttpOnly, Secure, SameSite", () => {
    const attrs = sessionCookieAttrs(3600);
    expect(attrs).toContain("HttpOnly");
    expect(attrs).toContain("Secure");
    expect(attrs).toContain("SameSite=Lax");
  });

  it("rotates a valid refresh token and issues a family successor", () => {
    const store = new Map();
    const d1 = sha256("t1");
    store.set(d1, { tokenDigest: d1, family: "fam", expiresAt: 10_000 });
    const issued: string[] = [];
    const res = rotateRefresh(store, d1, 5_000, 4_000, (digest) => issued.push(digest));
    expect(res.ok).toBe(true);
    expect(issued).toHaveLength(1);
  });

  it("rejects unknown, expired tokens", () => {
    const store = new Map();
    expect(rotateRefresh(store, sha256("nope"), 1, 1000, () => {})).toMatchObject({ ok: false, reason: "UNKNOWN" });
    const d = sha256("old");
    store.set(d, { tokenDigest: d, family: "f", expiresAt: 1000 });
    expect(rotateRefresh(store, d, 2000, 1000, () => {})).toMatchObject({ ok: false, reason: "EXPIRED" });
  });

  it("REUSE of a consumed token revokes the entire family", () => {
    const store = new Map();
    const d1 = sha256("t1");
    store.set(d1, { tokenDigest: d1, family: "fam", expiresAt: 100_000 });
    let successorDigest = "";
    const first = rotateRefresh(store, d1, 1_000, 90_000, (digest) => {
      successorDigest = digest;
      store.set(digest, { tokenDigest: digest, family: "fam", expiresAt: 100_000 });
    });
    expect(first.ok).toBe(true);
    // Attacker replays the old token → whole family dies, including the successor.
    const reuse = rotateRefresh(store, d1, 2_000, 90_000, () => {});
    expect(reuse).toMatchObject({ ok: false, reason: "REUSE" });
    const successor = rotateRefresh(store, successorDigest, 3_000, 90_000, () => {});
    expect(successor).toMatchObject({ ok: false, reason: "REVOKED" });
  });
});

describe("RBAC", () => {
  it("owners can do everything; teachers cannot self-promote", () => {
    expect(can("SCHOOL_OWNER", "billing:manage")).toBe(true);
    expect(can("TEACHER", "marks:approve")).toBe(false);
    expect(can("TEACHER", "marks:enter")).toBe(true);
    expect(can("TEACHER", "school:manage_staff")).toBe(false);
  });

  it("bursars cannot touch academic marks", () => {
    expect(can("BURSAR", "fees:record")).toBe(true);
    expect(can("BURSAR", "marks:enter")).toBe(false);
    expect(can("BURSAR", "marks:approve")).toBe(false);
  });

  it("data-entry can enter but never approve", () => {
    expect(can("DATA_ENTRY", "marks:enter")).toBe(true);
    expect(can("DATA_ENTRY", "marks:import")).toBe(true);
    expect(can("DATA_ENTRY", "marks:approve")).toBe(false);
  });

  it("only head teachers (and owners) approve and lock", () => {
    expect(can("HEAD_TEACHER", "marks:approve")).toBe(true);
    expect(can("HEAD_TEACHER", "marks:lock")).toBe(true);
    expect(can("SCHOOL_ADMIN", "marks:approve")).toBe(false);
  });

  it("privileged roles are never invitabile via onboarding", () => {
    expect(INVITABLE_ROLES).not.toContain("SCHOOL_OWNER");
    expect(INVITABLE_ROLES).toContain("TEACHER");
  });

  it("teacher context: only assigned class+subject, or explicit class-teacher grant", () => {
    const assignments: AssignmentRef[] = [
      { teacherId: "t1", subjectId: "math", classId: "S1E", classTeacher: false, active: true },
      { teacherId: "t1", subjectId: "eng", classId: "S2W", classTeacher: true, active: true },
      { teacherId: "t2", subjectId: "math", classId: "S1E", classTeacher: false, active: true },
    ];
    expect(canTeacher(assignments, "t1", "S1E", "math")).toBe(true);
    expect(canTeacher(assignments, "t1", "S1E", "sci")).toBe(false); // not assigned subject
    expect(canTeacher(assignments, "t1", "S2W", "sci")).toBe(true); // class-teacher grant
    expect(canTeacher(assignments, "t1", "S3N", "math")).toBe(false); // another class
    expect(canTeacher(assignments, "t2", "S1E", "math")).toBe(true);
    expect(canTeacher(assignments, "t1", "S1E")).toBe(false); // no grant, subject unknown
  });
});

describe("tenant scoping", () => {
  const memberships: MembershipRef[] = [
    { schoolId: "schA", role: "TEACHER", status: "ACTIVE" },
    { schoolId: "schB", role: "TEACHER", status: "INVITED" },
    { schoolId: "schC", role: "HEAD_TEACHER", status: "ACTIVE" },
  ];

  it("scopes to the requested school's ACTIVE membership", () => {
    expect(requireScope(memberships, "schA")).toEqual({ schoolId: "schA", role: "TEACHER" });
  });

  it("never grants access to non-member schools", () => {
    expect(() => requireScope(memberships, "schX")).toThrow(TenantAccessError);
  });

  it("never grants access via non-ACTIVE memberships (invited/suspended/removed)", () => {
    expect(() => requireScope(memberships, "schB")).toThrow(TenantAccessError);
    const suspended: MembershipRef[] = [{ schoolId: "s", role: "TEACHER", status: "SUSPENDED" }];
    expect(() => requireScope(suspended, "s")).toThrow(TenantAccessError);
  });

  it("refuses ambiguous context with multiple active memberships", () => {
    expect(() => requireScope(memberships, undefined)).toThrow(TenantAccessError);
  });

  it("injects schoolId into queries server-side", () => {
    const scope = requireScope(memberships, "schC");
    const q = scoped(scope, { termId: "t1" });
    expect(q).toEqual({ termId: "t1", schoolId: "schC" });
    // Even a client-injected schoolId cannot override the scope:
    const q2 = scoped(scope, { schoolId: "schA" });
    expect(q2.schoolId).toBe("schC");
  });
});

describe("invites", () => {
  const base: InviteState = {
    code: "x",
    codeDigest: "d",
    schoolId: "schA",
    role: "TEACHER",
    expiresAt: 10_000,
  };

  it("happy path: pending invite redeems", () => {
    expect(redeemInvite({ ...base }, 5_000)).toEqual({ ok: true, role: "TEACHER", schoolId: "schA" });
  });

  it("single-use: redeemed invite cannot redeem again", () => {
    expect(redeemInvite({ ...base, redeemedAt: 4_000 }, 5_000)).toMatchObject({ ok: false, reason: "ALREADY_USED" });
  });

  it("time-limited: expired invite is rejected", () => {
    expect(redeemInvite({ ...base }, 20_000)).toMatchObject({ ok: false, reason: "EXPIRED" });
  });

  it("revocable: revoked invite is rejected", () => {
    expect(redeemInvite({ ...base, revokedAt: 3_000 }, 5_000)).toMatchObject({ ok: false, reason: "REVOKED" });
  });

  it("default TTL is 7 days", () => {
    expect(DEFAULT_INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("rate limiting", () => {
  it("blocks after the limit within the window and frees after it", () => {
    const rl = createRateLimiter();
    const key = "login:user@example.com";
    expect(rl.allow(key, 3, 1000, 100)).toBe(true);
    expect(rl.allow(key, 3, 1000, 200)).toBe(true);
    expect(rl.allow(key, 3, 1000, 300)).toBe(true);
    expect(rl.allow(key, 3, 1000, 400)).toBe(false); // 4th attempt within window
    expect(rl.allow(key, 3, 1000, 2000)).toBe(true); // window has passed
  });

  it("keys are independent", () => {
    const rl = createRateLimiter();
    expect(rl.allow("a", 1, 1000, 100)).toBe(true);
    expect(rl.allow("b", 1, 1000, 100)).toBe(true);
    expect(rl.allow("a", 1, 1000, 200)).toBe(false);
  });
});
