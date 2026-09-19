import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/src/db/prisma";
import { requireScope } from "@/src/auth/tenant";
import { can } from "@/src/auth/rbac";
import { ServiceError } from "@/src/db/types";
import { jsonError, requireCtx } from "@/src/api/session";
import { serviceErrorToResponse } from "@/src/api/errors";

export const dynamic = "force-dynamic";

const Q = z.object({ schoolId: z.string().min(1) });

/** All sheets of the school with class/subject/term names — the approval queue. */
export async function GET(req: NextRequest) {
  const authed = await requireCtx(req);
  if ("res" in authed) return authed.res;

  const parsed = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return jsonError("VALIDATION", "schoolId required", 400);

  try {
    const scope = requireScope(authed.ctx.memberships, parsed.data.schoolId);
    if (!can(scope.role, "marks:view")) {
      throw new ServiceError("FORBIDDEN", `${scope.role} cannot view sheets`);
    }
    const db = prisma();
    const sheets = await db.markSheet.findMany({
      where: { schoolId: parsed.data.schoolId },
      include: { class_: true, subject: true, term: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });

    return Response.json({
      sheets: sheets.map((s) => ({
        id: s.id,
        classId: s.classId,
        className: s.class_.name,
        subjectId: s.subjectId,
        subjectName: s.subject.name,
        termId: s.termId,
        termName: s.term.name,
        state: s.state,
        updatedAt: s.updatedAt,
      })),
    });
  } catch (e) {
    return serviceErrorToResponse(e);
  }
}
