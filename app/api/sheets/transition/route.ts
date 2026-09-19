import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/src/db/prisma";
import { sheetsRepo, auditRepo } from "@/src/db/prismaRepos";
import { transitionSheet } from "@/src/services/sheets";
import { SheetState } from "@/src/grading/engine";
import { serviceErrorToResponse } from "@/src/api/errors";
import { assertCsrf, jsonError, requireCtx } from "@/src/api/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  schoolId: z.string().min(1),
  classId: z.string().min(1),
  subjectId: z.string().min(1),
  termId: z.string().min(1),
  to: z.enum(["DRAFT", "SUBMITTED", "REVIEWED", "APPROVED", "LOCKED"]),
});

export async function POST(req: NextRequest) {
  const authed = await requireCtx(req);
  if ("res" in authed) return authed.res;
  const csrf = assertCsrf(req, authed.csrfSecret);
  if (csrf) return csrf;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("VALIDATION", "Invalid transition request", 400);

  const db = prisma();
  try {
    const state = await transitionSheet(
      authed.ctx,
      { ...parsed.data, to: parsed.data.to as SheetState },
      sheetsRepo(db) as never,
      auditRepo(db)
    );
    return Response.json({ ok: true, state });
  } catch (e) {
    return serviceErrorToResponse(e);
  }
}
