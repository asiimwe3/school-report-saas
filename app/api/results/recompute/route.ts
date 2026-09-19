import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/src/db/prisma";
import { rosterRepo, marksRepo, resultsRepo, auditRepo } from "@/src/db/prismaRepos";
import { recomputeSubjectResults } from "@/src/services/results";
import { PLE_SCHEME, UCE_SCHEME, UACE_SCHEME } from "@/src/grading/schemes";
import type { GradingScheme } from "@/src/grading/engine";
import { serviceErrorToResponse } from "@/src/api/errors";
import { assertCsrf, jsonError, requireCtx } from "@/src/api/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  schoolId: z.string().min(1),
  termId: z.string().min(1),
  subjectId: z.string().min(1),
  scheme: z.enum(["PLE", "UCE", "UACE"]),
});

export async function POST(req: NextRequest) {
  const authed = await requireCtx(req);
  if ("res" in authed) return authed.res;
  const csrf = assertCsrf(req, authed.csrfSecret);
  if (csrf) return csrf;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("VALIDATION", "Invalid recompute request", 400);

  const schemes: Record<string, GradingScheme> = {
    PLE: PLE_SCHEME,
    UCE: UCE_SCHEME,
    UACE: UACE_SCHEME,
  };

  const db = prisma();
  try {
    const summary = await recomputeSubjectResults(
      authed.ctx,
      { ...parsed.data, scheme: schemes[parsed.data.scheme]! },
      rosterRepo(db),
      marksRepo(db),
      resultsRepo(db),
      auditRepo(db)
    );
    return Response.json({ ok: true, summary });
  } catch (e) {
    return serviceErrorToResponse(e);
  }
}
