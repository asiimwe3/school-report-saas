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

/** Classes, streams, subjects, terms and components for the school. */
export async function GET(req: NextRequest) {
  const authed = await requireCtx(req);
  if ("res" in authed) return authed.res;

  const parsed = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return jsonError("VALIDATION", "schoolId required", 400);

  try {
    const scope = requireScope(authed.ctx.memberships, parsed.data.schoolId);
    if (!can(scope.role, "marks:view")) {
      throw new ServiceError("FORBIDDEN", `${scope.role} cannot view school data`);
    }
    const db = prisma();
    const school = await db.school.findFirst({ where: { id: parsed.data.schoolId } });
    if (!school) throw new ServiceError("NOT_FOUND", "School not found");

    const [classes, subjects, terms, components] = await Promise.all([
      db.schoolClass.findMany({ where: { schoolId: school.id } }),
      db.subject.findMany({ where: { schoolId: school.id, active: true } }),
      db.term.findMany({
        where: { schoolId: school.id, academicYearId: school.activeYearId ?? undefined },
      }),
      db.assessmentComponent.findMany({ where: { schoolId: school.id, active: true } }),
    ]);

    return Response.json({
      school: { id: school.id, name: school.name, activeYearId: school.activeYearId, activeTermId: school.activeTermId },
      classes: classes.map((c) => ({ id: c.id, name: c.name, level: c.level })),
      subjects: subjects.map((s) => ({ id: s.id, name: s.name, level: s.level, compulsory: s.compulsory })),
      terms: terms.map((t) => ({ id: t.id, name: t.name, startDate: t.startDate, endDate: t.endDate })),
      components: components.map((c) => ({ id: c.id, code: c.code, kind: c.kind, weightPercent: c.weightPercent })),
    });
  } catch (e) {
    return serviceErrorToResponse(e);
  }
}
