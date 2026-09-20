import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Level, Role, MembershipStatus } from "@prisma/client";
import { prisma } from "@/src/db/prisma";
import { hashPassword } from "@/src/auth/passwords";
import { newToken, newCsrfSecret, sha256, SESSION_COOKIE, REFRESH_COOKIE } from "@/src/auth/tokens";
import { jsonError, limiter, rateLimited } from "@/src/api/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  schoolName: z.string().trim().min(3).max(120),
  district: z.string().trim().max(80).optional().or(z.literal("")),
});

const SESSION_TTL_SEC = 60 * 60 * 8;
const REFRESH_TTL_SEC = 60 * 60 * 24 * 30;

/**
 * Self-serve signup: creates the owner account, their school, an owner
 * membership, and the current academic year + open term in one transaction,
 * then signs the owner in immediately.
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for") ?? "unknown";
  const rl = rateLimited(`register:${ip}`, 5, 60 * 60 * 1000);
  if (rl) return rl;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("VALIDATION", "Check the form fields (password must be at least 8 characters)", 400);
  }
  const { fullName, email, password, schoolName, district } = parsed.data;
  const emailLower = email.toLowerCase();

  const db = prisma();
  const existing = await db.user.findFirst({ where: { email: emailLower }, select: { id: true } });
  if (existing) return jsonError("EMAIL_TAKEN", "An account with this email already exists", 409);

  const now = Date.now();
  const token = newToken();
  const csrfSecret = newCsrfSecret();
  const refresh = newToken();

  await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: emailLower,
        fullName,
        passwordHash: hashPassword(password),
      },
    });

    const school = await tx.school.create({
      data: {
        name: schoolName,
        district: district || null,
        activeYearId: null,
        activeTermId: null,
      },
    });

    await tx.schoolMembership.create({
      data: { schoolId: school.id, userId: user.id, role: Role.SCHOOL_OWNER, status: MembershipStatus.ACTIVE },
    });

    const year = await tx.academicYear.create({
      data: { schoolId: school.id, year: "2026", isCurrent: true },
    });
    const term = await tx.term.create({
      data: {
        schoolId: school.id,
        academicYearId: year.id,
        number: 3,
        name: "Term 3",
        startDate: new Date("2026-09-07"),
        endDate: new Date("2026-12-04"),
        status: "OPEN",
        isCurrent: true,
      },
    });
    await tx.school.update({ where: { id: school.id }, data: { activeYearId: year.id, activeTermId: term.id } });

    await tx.session.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        csrfSecret,
        expiresAt: new Date(now + SESSION_TTL_SEC * 1000),
        ipHash: sha256(ip),
      },
    });
    await tx.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refresh),
        family: newToken(16),
        expiresAt: new Date(now + REFRESH_TTL_SEC * 1000),
      },
    });
  });

  const res = NextResponse.json({
    csrfSecret,
    user: { fullName },
    school: { name: schoolName },
  });
  res.cookies.set(SESSION_COOKIE, token, { ...cookieParams(), maxAge: SESSION_TTL_SEC });
  res.cookies.set(REFRESH_COOKIE, refresh, { ...cookieParams(), maxAge: REFRESH_TTL_SEC, path: "/api/auth" });
  return res;
}

function cookieParams() {
  return { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" };
}
