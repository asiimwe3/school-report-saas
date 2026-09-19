import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/db/prisma";
import { sha256, SESSION_COOKIE, REFRESH_COOKIE } from "@/src/auth/tokens";
import { assertCsrf, jsonError, requireCtx } from "@/src/api/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const authed = await requireCtx(req);
  if ("res" in authed) return authed.res;
  const csrf = assertCsrf(req, authed.csrfSecret);
  if (csrf) return csrf;

  const db = prisma();
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.session.updateMany({
      where: { tokenHash: sha256(token) },
      data: { revokedAt: new Date() },
    });
  }
  const refresh = req.cookies.get(REFRESH_COOKIE)?.value;
  if (refresh) {
    await db.refreshToken.updateMany({
      where: { tokenHash: sha256(refresh) },
      data: { revokedAt: new Date() },
    });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  res.cookies.delete(REFRESH_COOKIE);
  return res;
}
