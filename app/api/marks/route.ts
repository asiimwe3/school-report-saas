import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/src/db/prisma";
import { marksRepo, sheetsRepo, auditRepo } from "@/src/db/prismaRepos";
import { enterMark } from "@/src/services/marks";
import { assertCsrf, jsonError, rateLimited, requireCtx } from "@/src/api/session";
import { serviceErrorToResponse } from "@/src/api/errors";
import { MarkType } from "@/src/grading/engine";
import { requireScope } from "@/src/auth/tenant";
import { can, canTeacher } from "@/src/auth/rbac";
import { ServiceError } from "@/src/db/types";

export const dynamic = "force-dynamic";

const Body = z.object({
  schoolId: z.string().min(1),
  studentId: z.string().min(1),
  subjectId: z.string().min(1),
  termId: z.string().min(1),
  componentId: z.string().min(1),
  type: z.enum(["VALUE", "ABS", "MISSING", "EXEMPT", "NA"]),
  score: z.number().min(0).nullable(),
  maxScore: z.number().int().min(1).max(1000).optional(),
});


// ── GET: marks for one class+subject+term sheet ─────────────────────────────
const Q = z.object({
  schoolId: z.string().min(1),
  classId: z.string().min(1),
  subjectId: z.string().min(1),
  termId: z.string().min(1),
});

export async function GET(req: NextRequest) {
  const authed = await requireCtx(req);
  if ("res" in authed) return authed.res;

  const parsed = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return jsonError("VALIDATION", "schoolId, classId, subjectId, termId required", 400);

  try {
    const scope = requireScope(authed.ctx.memberships, parsed.data.schoolId);
    if (!can(scope.role, "marks:view")) {
      throw new ServiceError("FORBIDDEN", `${scope.role} cannot view marks`);
    }
    // Teachers can only open sheets they are assigned to.
    if (
      scope.role === "TEACHER" &&
      !canTeacher(authed.ctx.assignments, authed.ctx.userId, parsed.data.classId, parsed.data.subjectId)
    ) {
      throw new ServiceError("FORBIDDEN", "Not assigned to this class/subject");
    }

    const db = prisma();
    const [sheet, marks] = await Promise.all([
      db.markSheet.findFirst({
        where: { ...parsed.data, schoolId: parsed.data.schoolId },
      }),
      db.mark.findMany({
        where: {
          schoolId: parsed.data.schoolId,
          termId: parsed.data.termId,
          subjectId: parsed.data.subjectId,
          student: {
            enrollments: {
              some: {
                classId: parsed.data.classId,
                academicYearId: (await db.term.findFirst({ where: { id: parsed.data.termId, schoolId: parsed.data.schoolId } }))!.academicYearId,
                status: "ACTIVE",
              },
            },
          },
        },
      }),
    ]);

    return Response.json({
      sheetState: sheet?.state ?? "DRAFT",
      marks: marks.map((m) => ({
        studentId: m.studentId,
        componentId: m.componentId,
        type: m.type,
        score: m.score === null ? null : Number(m.score),
        maxScore: m.maxScore,
        version: m.version,
      })),
    });
  } catch (e) {
    return serviceErrorToResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const authed = await requireCtx(req);
  if ("res" in authed) return authed.res;
  const csrf = assertCsrf(req, authed.csrfSecret);
  if (csrf) return csrf;

  const rl = rateLimited(`marks:${authed.ctx.userId}`, 600, 60_000);
  if (rl) return rl;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid mark", 400);
  }
  const b = parsed.data;

  // classId and enrollmentId are resolved SERVER-SIDE from the term's
  // academic-year enrollment — the client can never claim a class.
  const db = prisma();
  const term = await db.term.findFirst({ where: { id: b.termId, schoolId: b.schoolId } });
  if (!term) return jsonError("NOT_FOUND", "Term not found", 404);
  const enrollment = await db.enrollment.findFirst({
    where: { schoolId: b.schoolId, studentId: b.studentId, academicYearId: term.academicYearId, status: "ACTIVE" },
  });
  if (!enrollment) return jsonError("NOT_FOUND", "No active enrollment for this student in the term's year", 404);

  try {
    const mark = await enterMark(
      authed.ctx,
      {
        schoolId: b.schoolId,
        studentId: b.studentId,
        subjectId: b.subjectId,
        termId: b.termId,
        componentId: b.componentId,
        enrollmentId: enrollment.id,
        classId: enrollment.classId,
        type: b.type as MarkType,
        score: b.score,
        maxScore: b.maxScore,
      },
      marksRepo(db),
      sheetsRepo(db) as never,
      auditRepo(db)
    );
    return Response.json({ ok: true, mark });
  } catch (e) {
    return serviceErrorToResponse(e);
  }
}

