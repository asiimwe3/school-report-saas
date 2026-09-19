/**
 * Route-adapter glue: cookie session → authenticated Ctx (memberships +
 * assignments read from the DB, never from the request), uniform JSON error
 * responses, CSRF check, and the shared rate limiter instance.
 */
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../db/prisma";
import { authRepo } from "../db/prismaRepos";
import { digestMatches, SESSION_COOKIE } from "../auth/tokens";
import type { Ctx } from "../db/types";
import { createRateLimiter } from "../http/rateLimit";

export const limiter = createRateLimiter();

export const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export function jsonError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * Authenticates via the HttpOnly session cookie. Roles and assignments are
 * loaded from the database on every request — a client cannot influence them.
 */
export interface Authed {
  ctx: Ctx;
  csrfSecret: string;
}

export async function requireCtx(req: NextRequest): Promise<Authed | { res: NextResponse }> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    return { res: jsonError("UNAUTHENTICATED", "Sign in required", 401) };
  }
  const tokenHash = sha256(token);
  const db = prisma();
  const session = await authRepo(db).findSessionByTokenHash(tokenHash);
  if (!session || !digestMatches(token, session.tokenHash === tokenHash ? token : "")) {
    return { res: jsonError("UNAUTHENTICATED", "Session expired; sign in again", 401) };
  }

  const membershipsRaw = await authRepo(db).listMemberships(session.userId);
  const memberships = membershipsRaw.map((m) => ({
    schoolId: m.schoolId,
    role: m.role as Ctx["memberships"][number]["role"],
    status: m.status as Ctx["memberships"][number]["status"],
  }));

  // Assignments for all member schools (small list; cached per request only).
  const assignments: Ctx["assignments"] = [];
  for (const m of memberships) {
    if (m.role === "TEACHER" || m.role === "HEAD_TEACHER") {
      const rows = await authRepo(db).listAssignments(m.schoolId, session.userId);
      for (const a of rows) {
        assignments.push({
          teacherId: a.teacherId,
          subjectId: a.subjectId,
          classId: a.classId,
          classTeacher: a.classTeacher,
          active: a.active,
        });
      }
    }
  }

  return {
    ctx: {
      userId: session.userId,
      memberships,
      assignments,
      now: Date.now(),
    },
    csrfSecret: session.csrfSecret,
  };
}

/** Double-submit CSRF: header must match the session-bound secret. */
export function assertCsrf(req: NextRequest, csrfSecret: string): NextResponse | null {
  const header = req.headers.get("x-csrf-token");
  if (!header || header !== csrfSecret) {
    return jsonError("CSRF", "Invalid CSRF token", 403);
  }
  return null;
}

/** In-process rate limit guard. */
export function rateLimited(key: string, limit: number, windowMs: number): NextResponse | null {
  if (!limiter.allow(key, limit, windowMs, Date.now())) {
    return jsonError("RATE_LIMITED", "Too many requests; slow down", 429);
  }
  return null;
}
