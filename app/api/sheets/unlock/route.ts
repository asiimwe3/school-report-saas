import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/src/db/prisma";
import { sheetsRepo, auditRepo } from "@/src/db/prismaRepos";
import { unlockSheet } from "@/src/services/marks";
import { serviceErrorToResponse } from "@/src/api/errors";
import { assertCsrf, jsonError, requireCtx } from "@/src/api/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  schoolId: z.string().min(1),
  classId: z.string().min(1),
  subjectId: z.string().min(1),
  termId: z.string().min(1),
  reason: z.string().min(5).max(500),
});

export async function POST(req: NextRequest) {
  const authed = await requireCtx(req);
  if ("res" in authed) return authed.res;
  const csrf = assertCsrf(req, authed.csrfSecret);
  if (csrf) return csrf;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("VALIDATION", "Reason of at least 5 characters is required", 400);

  const db = prisma();
  try {
    await unlockSheet(authed.ctx, parsed.data, sheetsRepo(db) as never, auditRepo(db));
    return Response.json({ ok: true });
  } catch (e) {
    return serviceErrorToResponse(e);
  }
}
