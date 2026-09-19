/**
 * Prisma-backed repository implementations of the service-layer contracts.
 * Every method takes schoolId and scopes the query with it — the DB is the
 * last line of tenant defence. Decimal→number conversions happen here so the
 * service layer stays pure.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  AuditRepo,
  ComponentRecord,
  EnrollmentRecord,
  MarkRecord,
  ResultsRepo,
  RosterRepo,
  SubjectRecord,
  AuditRecord,
} from "./types";
import type { ImportJobRepo } from "../services/importCommit";
import { MarkType, SheetState } from "../grading/engine";

const asNumber = (d: unknown): number => Number(d ?? 0);

export function marksRepo(db: PrismaClient) {
  return {
    findMark: async (
      schoolId: string,
      key: { studentId: string; subjectId: string; termId: string; componentId: string }
    ): Promise<MarkRecord | null> => {
      const m = await db.mark.findFirst({
        where: { ...key, schoolId },
      });
      return m ? toMarkRecord(m) : null;
    },

    createMark: async (schoolId: string, data: Omit<MarkRecord, "id" | "version" | "schoolId">): Promise<MarkRecord> => {
      const m = await db.mark.create({
        data: {
          schoolId,
          studentId: data.studentId,
          subjectId: data.subjectId,
          termId: data.termId,
          componentId: data.componentId,
          enrollmentId: data.enrollmentId,
          type: data.type,
          score: data.score,
          maxScore: data.maxScore,
          enteredBy: data.enteredBy,
          sheetState: data.sheetState,
          version: 1,
        },
      });
      return toMarkRecord(m);
    },

    updateMark: async (
      schoolId: string,
      id: string,
      patch: Partial<MarkRecord>,
      expectedVersion: number
    ): Promise<MarkRecord | null> => {
      // Optimistic concurrency enforced IN the query — no read-then-write race.
      const m = await db.mark.updateMany({
        where: { id, schoolId, version: expectedVersion },
        data: {
          ...(patch.type !== undefined ? { type: patch.type as never } : {}),
          ...(patch.score !== undefined ? { score: patch.score } : {}),
          ...(patch.enteredBy !== undefined ? { enteredBy: patch.enteredBy, updatedBy: patch.enteredBy } : {}),
          version: { increment: 1 },
        },
      });
      if (m.count === 0) return null;
      const updated = await db.mark.findFirst({ where: { id, schoolId } });
      return updated ? toMarkRecord(updated) : null;
    },

    listMarks: async (
      schoolId: string,
      filter: { termId: string; subjectId?: string; studentIds?: string[] }
    ): Promise<MarkRecord[]> => {
      const rows = await db.mark.findMany({
        where: {
          schoolId,
          termId: filter.termId,
          ...(filter.subjectId ? { subjectId: filter.subjectId } : {}),
          ...(filter.studentIds ? { studentId: { in: filter.studentIds } } : {}),
        },
      });
      return rows.map(toMarkRecord);
    },

    appendHistory: async (
      schoolId: string,
      rec: {
        markId: string;
        oldType: MarkType | null;
        oldScore: number | null;
        newType: MarkType;
        newScore: number | null;
        changedBy: string;
        reason?: string;
        createdAt: number;
      }
    ): Promise<void> => {
      await db.markHistory.create({
        data: {
          markId: rec.markId,
          oldType: rec.oldType ?? undefined,
          oldScore: rec.oldScore ?? undefined,
          newType: rec.newType as never,
          newScore: rec.newScore ?? undefined,
          changedBy: rec.changedBy,
          reason: rec.reason,
          createdAt: new Date(rec.createdAt),
        },
      });
    },
  };
}

function toMarkRecord(m: {
  id: string; schoolId: string; studentId: string; subjectId: string; termId: string; componentId: string;
  enrollmentId: string; type: string; score: unknown; maxScore: number; version: number;
  sheetState: string; enteredBy: string | null; updatedAt: Date;
}): MarkRecord {
  return {
    id: m.id,
    schoolId: m.schoolId,
    studentId: m.studentId,
    subjectId: m.subjectId,
    termId: m.termId,
    componentId: m.componentId,
    enrollmentId: m.enrollmentId,
    type: m.type as MarkType,
    score: m.score === null ? null : asNumber(m.score),
    maxScore: m.maxScore,
    version: m.version,
    sheetState: m.sheetState as SheetState,
    enteredBy: m.enteredBy,
    updatedAt: m.updatedAt.getTime(),
  };
}

export function sheetsRepo(db: PrismaClient) {
  return {
    findSheet: async (
      schoolId: string,
      key: { classId: string; subjectId: string; termId: string }
    ) => {
      const s = await db.markSheet.findFirst({
        where: { ...key, schoolId },
      });
      return s ? { ...s, lockedAt: s.lockedAt?.getTime() ?? null } : null;
    },

    createSheet: async (
      schoolId: string,
      data: Omit<{ id: string; classId: string; subjectId: string; termId: string; state: SheetState; lockedAt: number | null }, "id" | "schoolId">
    ) => {
      const s = await db.markSheet.create({
        data: {
          schoolId,
          classId: data.classId,
          subjectId: data.subjectId,
          termId: data.termId,
          state: data.state as never,
          lockedAt: data.lockedAt !== null && data.lockedAt !== undefined ? new Date(data.lockedAt) : null,
        },
      });
      return s;
    },

    updateSheet: async (schoolId: string, id: string, patch: Record<string, unknown>) => {
      const s = await db.markSheet.update({
        where: { id, schoolId },
        data: {
          ...(patch.state !== undefined ? { state: patch.state as never } : {}),
          ...(patch.lockedAt !== undefined
            ? { lockedAt: patch.lockedAt === null ? null : new Date(patch.lockedAt as number) }
            : {}),
        },
      });
      return s;
    },
  };
}

export function rosterRepo(db: PrismaClient): RosterRepo {
  return {
    listEnrollments: async (schoolId: string, academicYearId: string): Promise<EnrollmentRecord[]> => {
      const rows = await db.enrollment.findMany({
        where: { schoolId, academicYearId },
      });
      return rows.map((e) => ({
        studentId: e.studentId,
        academicYearId: e.academicYearId,
        classId: e.classId,
        streamId: e.streamId,
        status: e.status,
      }));
    },

    listSubjects: async (schoolId: string): Promise<SubjectRecord[]> => {
      const rows = await db.subject.findMany({ where: { schoolId } });
      return rows.map((s) => ({
        id: s.id,
        schoolId: s.schoolId,
        name: s.name,
        level: s.level as SubjectRecord["level"],
        compulsory: s.compulsory,
        principal: s.principal,
        subsidiary: s.subsidiary,
        maxMarks: s.maxMarks,
        active: s.active,
      }));
    },

    listComponents: async (schoolId: string): Promise<ComponentRecord[]> => {
      const rows = await db.assessmentComponent.findMany({ where: { schoolId } });
      return rows.map((c) => ({
        id: c.id,
        schoolId: c.schoolId,
        subjectId: c.subjectId,
        code: c.code,
        kind: (c.kind as ComponentRecord["kind"]) ?? "EXAM",
        active: c.active,
      }));
    },

    getSchool: async (schoolId: string) => {
      const s = await db.school.findFirst({
        where: { id: schoolId },
        select: { activeYearId: true },
      });
      return s?.activeYearId ? { activeYearId: s.activeYearId } : null;
    },
  };
}

export function resultsRepo(db: PrismaClient): ResultsRepo {
  return {
    upsertTermResult: async (schoolId: string, key: { studentId: string; termId: string; subjectId: string }, data) => {
      const enrollment = await db.enrollment.findFirst({
        where: { schoolId, studentId: key.studentId },
        orderBy: { createdAt: "desc" },
      });
      const row = await db.termResult.upsert({
        where: {
          studentId_termId_subjectId: {
            studentId: key.studentId,
            termId: key.termId,
            subjectId: key.subjectId,
          },
        },
        create: {
          schoolId,
          studentId: key.studentId,
          termId: key.termId,
          subjectId: key.subjectId,
          enrollmentId: enrollment?.id ?? "",
          total: data.total,
          percentage: data.percentage,
          grade: data.grade,
          points: data.points,
          remark: data.remark,
          complete: data.complete,
          blockingReasons: data.blockingReasons,
          calculatedAt: new Date(data.calculatedAt),
        },
        update: {
          total: data.total,
          percentage: data.percentage,
          grade: data.grade,
          points: data.points,
          remark: data.remark,
          complete: data.complete,
          blockingReasons: data.blockingReasons,
          calculatedAt: new Date(data.calculatedAt),
        },
      });
      return { ...row, calculatedAt: row.calculatedAt.getTime() } as never;
    },

    listTermResults: async (schoolId: string, termId: string) => {
      const rows = await db.termResult.findMany({ where: { schoolId, termId } });
      return rows.map((r) => ({
        id: r.id,
        schoolId: r.schoolId,
        studentId: r.studentId,
        termId: r.termId,
        subjectId: r.subjectId,
        total: r.total === null ? null : asNumber(r.total),
        percentage: r.percentage === null ? null : asNumber(r.percentage),
        grade: r.grade,
        points: r.points,
        remark: r.remark,
        complete: r.complete,
        blockingReasons: r.blockingReasons,
        calculatedAt: r.calculatedAt.getTime(),
      })) as never;
    },
  };
}

export function auditRepo(db: PrismaClient): AuditRepo {
  return {
    record: async (schoolId: string, event: AuditRecord) => {
      await db.auditEvent.create({
        data: {
          schoolId,
          userId: event.userId,
          action: event.action,
          entity: event.entity,
          entityId: event.entityId,
          before: event.before as Prisma.InputJsonValue | undefined,
          after: event.after as Prisma.InputJsonValue | undefined,
          createdAt: new Date(event.createdAt),
        },
      });
    },
  };
}

export function importJobsRepo(db: PrismaClient): ImportJobRepo {
  return {
    createJob: async (schoolId: string, data: { kind: string; initiatedBy: string; summary: unknown }) => {
      const job = await db.importJob.create({
        data: {
          schoolId,
          kind: data.kind,
          initiatedBy: data.initiatedBy,
          uploadedByKey: "",
          summary: data.summary as Prisma.InputJsonValue,
        },
      });
      return job.id;
    },
    appendRow: async (_schoolId: string, jobId: string, row: { rowNo: number; kind: string; key?: string; message?: string }) => {
      await db.importRow.create({
        data: { jobId, rowNo: row.rowNo, kind: row.kind, key: row.key, message: row.message, payload: {} },
      });
    },
  };
}

/** Auth lookups for the route adapter. */
export function authRepo(db: PrismaClient) {
  return {
    findSessionByTokenHash: (tokenHash: string) =>
      db.session.findFirst({
        where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
    listMemberships: (userId: string) =>
      db.schoolMembership.findMany({ where: { userId } }),
    listAssignments: (schoolId: string, userId: string) =>
      db.teacherAssignment.findMany({
        where: {
          schoolId,
          active: true,
          teacher: { userId, active: true },
        },
      }),
  };
}
