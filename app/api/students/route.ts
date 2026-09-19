import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/src/db/prisma";
import { requireScope } from "@/src/auth/tenant";
import { can } from "@/src/auth/rbac";
import { ServiceError } from "@/src/db/types";
import { jsonError, requireCtx } from "@/src/api/session";
import { serviceErrorToResponse } from "@/src/api/errors";

export const dynamic = "force-dynamic";

const Q = z.object({
  schoolId: z.string().min(1),
  classId: z.string().min(1),
  termId: z.string().min(1),
});

/** Active roster of a class for a term's academic year. */
export async function GET(req: NextRequest) {
  const authed = await requireCtx(req);
  if ("res" in authed) return authed.res;

  const parsed = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return jsonError("VALIDATION", "schoolId, classId, termId required", 400);

  try {
    const scope = requireScope(authed.ctx.memberships, parsed.data.schoolId);
    if (!can(scope.role, "marks:view")) {
      throw new ServiceError("FORBIDDEN", `${scope.role} cannot view rosters`);
    }
    const db = prisma();
    const term = await db.term.findFirst({
      where: { id: parsed.data.termId, schoolId: parsed.data.schoolId },
    });
    if (!term) throw new ServiceError("NOT_FOUND", "Term not found");

    const enrollments = await db.enrollment.findMany({
      where: {
        schoolId: parsed.data.schoolId,
        classId: parsed.data.classId,
        academicYearId: term.academicYearId,
        status: "ACTIVE",
      },
      include: { student: true },
      orderBy: { rollNo: "asc" },
    });

    return Response.json({
      students: enrollments.map((e) => ({
        id: e.studentId,
        name: `${e.student.firstName} ${e.student.lastName}`,
        admissionNo: e.student.admissionNo,
        rollNo: e.rollNo,
        enrollmentId: e.id,
      })),
    });
  } catch (e) {
    return serviceErrorToResponse(e);
  }
}
