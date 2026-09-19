import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/src/db/prisma";
import { verifyPassword } from "@/src/auth/passwords";
import { newToken, newCsrfSecret, sha256, SESSION_COOKIE, REFRESH_COOKIE, sessionCookieAttrs, refreshCookieAttrs } from "@/src/auth/tokens";
import { jsonError, limiter, rateLimited } from "@/src/api/session";

export const dynamic = "force-dynamic";

const Body = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });

const SESSION_TTL_SEC = 60 * 60 * 8; // 8h
const REFRESH_TTL_SEC = 60 * 60 * 24 * 30; // 30d

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for") ?? "unknown";
  const rl = rateLimited(`login:${ip}`, 10, 60_000);
  if (rl) return rl;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("VALIDATION", "Email and password required", 400);

  const db = prisma();
  const user = await db.user.findFirst({
    where: { email: parsed.data.email.toLowerCase() },
  });
  // Uniform failure — never reveal which half was wrong.
  if (!user || !user.passwordHash || !verifyPassword(parsed.data.password, user.passwordHash)) {
    return jsonError("AUTH_FAILED", "Invalid credentials", 401);
  }

  const token = newToken();
  const csrfSecret = newCsrfSecret();
  const now = Date.now();
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: sha256(token),
      csrfSecret,
      expiresAt: new Date(now + SESSION_TTL_SEC * 1000),
      ipHash: sha256(ip),
    },
  });

  const refresh = newToken();
  const family = newToken(16);
  await db.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(refresh),
      family,
      expiresAt: new Date(now + REFRESH_TTL_SEC * 1000),
    },
  });

  const res = NextResponse.json({
    csrfSecret,
    user: { id: user.id, fullName: user.fullName },
  });
  res.cookies.set(SESSION_COOKIE, token, { ...cookieParams(), maxAge: SESSION_TTL_SEC });
  res.cookies.set(REFRESH_COOKIE, refresh, { ...cookieParams(), maxAge: REFRESH_TTL_SEC, path: "/api/auth" });
  return res;
}

function cookieParams() {
  return { httpOnly: true, secure: true, sameSite: "lax" as const };
}

// Silence unused warnings for attrs helpers if unused.
void sessionCookieAttrs; void refreshCookieAttrs;
