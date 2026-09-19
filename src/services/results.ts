/**
 * Term results service — computes and persists result snapshots using the
 * shared grading engine. The roster is ALWAYS the ACTIVE-enrollment set for
 * the school's explicit active academic year; previous years never leak in.
 * Every consumer (reports, dashboards, merit lists) reads these snapshots —
 * nobody recalculates.
 */
import { requireScope } from "../auth/tenant";
import { can } from "../auth/rbac";
import {
  computeSubject,
  rosterFor,
  type GradingScheme,
  type SubjectInput,
} from "../grading/engine";
import {
  ServiceError,
  type AuditRepo,
  type Ctx,
  type MarksRepo,
  type ResultsRepo,
  type RosterRepo,
} from "../db/types";

export interface RecomputeInput {
  schoolId: string;
  termId: string;
  subjectId: string;
  scheme: GradingScheme;
}

export interface RecomputeSummary {
  studentCount: number;
  complete: number;
  incomplete: number;
}

export async function recomputeSubjectResults(
  ctx: Ctx,
  input: RecomputeInput,
  roster: RosterRepo,
  marks: MarksRepo,
  results: ResultsRepo,
  audit: AuditRepo
): Promise<RecomputeSummary> {
  const scope = requireScope(ctx.memberships, input.schoolId);
  if (!can(scope.role, "results:view")) {
    throw new ServiceError("FORBIDDEN", `${scope.role} cannot compute results`);
  }

  const school = await roster.getSchool(input.schoolId);
  if (!school?.activeYearId) {
    throw new ServiceError("STATE_CONFLICT", "School has no active academic year");
  }

  const enrollments = await roster.listEnrollments(input.schoolId, school.activeYearId);
  const studentIds = rosterFor(enrollments, school.activeYearId);
  if (studentIds.length === 0) {
    return { studentCount: 0, complete: 0, incomplete: 0 };
  }

  const subject = (await roster.listSubjects(input.schoolId)).find((s) => s.id === input.subjectId);
  if (!subject) throw new ServiceError("NOT_FOUND", "Subject not found");
  const components = (await roster.listComponents(input.schoolId)).filter(
    (c) => c.active && (c.subjectId === null || c.subjectId === input.subjectId)
  );

  const allMarks = await marks.listMarks(input.schoolId, {
    termId: input.termId,
    subjectId: input.subjectId,
    studentIds,
  });

  let complete = 0;
  let incomplete = 0;

  for (const studentId of studentIds) {
    const subjectInput: SubjectInput = {
      subjectId: subject.id,
      name: subject.name,
      compulsory: subject.compulsory,
      principal: subject.principal,
      subsidiary: subject.subsidiary,
      maxMarks: subject.maxMarks,
      marks: allMarks
        .filter((m) => m.studentId === studentId)
        .map((m) => ({
          componentId: m.componentId,
          componentCode: components.find((c) => c.id === m.componentId)?.code ?? "?",
          componentKind: components.find((c) => c.id === m.componentId)?.kind ?? "EXAM",
          type: m.type,
          score: m.score,
          maxScore: m.maxScore,
        })),
    };
    const r = computeSubject(input.scheme, subjectInput);
    if (r.complete) complete += 1;
    else incomplete += 1;

    await results.upsertTermResult(
      input.schoolId,
      { studentId, termId: input.termId, subjectId: subject.id },
      {
        total: r.total,
        percentage: r.percentage,
        grade: r.grade,
        points: r.points,
        remark: r.remark,
        complete: r.complete,
        blockingReasons: r.blockingReasons,
        calculatedAt: ctx.now,
      }
    );
  }

  await audit.record(input.schoolId, {
    schoolId: input.schoolId,
    userId: ctx.userId,
    action: "RESULTS_RECOMPUTED",
    entity: "TermResult",
    after: { subjectId: input.subjectId, termId: input.termId, complete, incomplete },
    createdAt: ctx.now,
  });

  return { studentCount: studentIds.length, complete, incomplete };
}

