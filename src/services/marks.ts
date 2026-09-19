/**
 * Mark entry service — the heart of the API layer. Every write path passes
 * through: tenant scope → RBAC → teacher assignment check → sheet-state
 * gate → optimistic concurrency, and always leaves a history row.
 */
import { requireScope, TenantAccessError } from "../auth/tenant";
import { can, canTeacher } from "../auth/rbac";
import { MarkType, SheetState } from "../grading/engine";
import {
  ServiceError,
  type Ctx,
  type MarksRepo,
  type MarkRecord,
  type SheetsRepo,
  type AuditRepo,
} from "../db/types";

export interface EnterMarkInput {
  schoolId: string;
  studentId: string;
  subjectId: string;
  termId: string;
  componentId: string;
  enrollmentId: string;
  /** resolved server-side from the enrollment — never trusted from the client */
  classId: string;
  type: MarkType;
  score: number | null;
  maxScore?: number;
}

const EDITABLE: SheetState[] = [SheetState.DRAFT, SheetState.SUBMITTED, SheetState.REVIEWED];

export async function enterMark(
  ctx: Ctx,
  input: EnterMarkInput,
  marks: MarksRepo,
  sheets: SheetsRepo,
  audit: AuditRepo
): Promise<MarkRecord> {
  const scope = requireScope(ctx.memberships, input.schoolId);

  if (!can(scope.role, "marks:enter")) {
    throw new ServiceError("FORBIDDEN", `${scope.role} cannot enter marks`);
  }
  if (scope.role === "TEACHER" && !canTeacher(ctx.assignments, ctx.userId, input.classId, input.subjectId)) {
    throw new ServiceError("FORBIDDEN", "Teacher is not assigned to this class/subject");
  }

  if (input.type === MarkType.VALUE) {
    const max = input.maxScore ?? 100;
    if (input.score === null || Number.isNaN(input.score) || input.score < 0) {
      throw new ServiceError("VALIDATION", "VALUE mark requires a non-negative score");
    }
    if (input.score > max) {
      throw new ServiceError("VALIDATION", `Score ${input.score} exceeds maximum ${max}`);
    }
  } else if (input.score !== null) {
    throw new ServiceError("VALIDATION", `Special mark (${input.type}) must not carry a score`);
  }

  const sheet = await sheets.findSheet(input.schoolId, {
    classId: input.classId,
    subjectId: input.subjectId,
    termId: input.termId,
  });
  const state = sheet?.state ?? SheetState.DRAFT;
  if (!EDITABLE.includes(state)) {
    throw new ServiceError("SHEET_LOCKED", `Sheet is ${state}; marks can no longer be entered`);
  }

  const existing = await marks.findMark(input.schoolId, {
    studentId: input.studentId,
    subjectId: input.subjectId,
    termId: input.termId,
    componentId: input.componentId,
  });

  if (!existing) {
    const created = await marks.createMark(input.schoolId, {
      studentId: input.studentId,
      subjectId: input.subjectId,
      termId: input.termId,
      componentId: input.componentId,
      enrollmentId: input.enrollmentId,
      type: input.type,
      score: input.type === MarkType.VALUE ? input.score : null,
      maxScore: input.maxScore ?? 100,
      sheetState: state,
      enteredBy: ctx.userId,
      updatedAt: ctx.now,
    });
    await marks.appendHistory(input.schoolId, {
      markId: created.id,
      oldType: null,
      oldScore: null,
      newType: input.type,
      newScore: input.score,
      changedBy: ctx.userId,
      createdAt: ctx.now,
    });
    await audit.record(input.schoolId, {
      schoolId: input.schoolId,
      userId: ctx.userId,
      action: "MARK_ENTERED",
      entity: "Mark",
      entityId: created.id,
      after: { type: input.type, score: input.score },
      createdAt: ctx.now,
    });
    return created;
  }

  const updated = await marks.updateMark(
    input.schoolId,
    existing.id,
    {
      type: input.type,
      score: input.type === MarkType.VALUE ? input.score : null,
      enteredBy: ctx.userId,
      updatedAt: ctx.now,
    },
    existing.version
  );
  if (!updated) {
    throw new ServiceError("VERSION_CONFLICT", "Mark changed elsewhere; reload and retry");
  }
  await marks.appendHistory(input.schoolId, {
    markId: existing.id,
    oldType: existing.type,
    oldScore: existing.score,
    newType: input.type,
    newScore: input.score,
    changedBy: ctx.userId,
    createdAt: ctx.now,
  });
  await audit.record(input.schoolId, {
    schoolId: input.schoolId,
    userId: ctx.userId,
    action: "MARK_UPDATED",
    entity: "Mark",
    entityId: existing.id,
    before: { type: existing.type, score: existing.score },
    after: { type: input.type, score: input.score },
    createdAt: ctx.now,
  });
  return updated;
}

/** Explicit unlock: head teacher only, reason mandatory, audited. */
export async function unlockSheet(
  ctx: Ctx,
  input: { schoolId: string; classId: string; subjectId: string; termId: string; reason: string },
  sheets: SheetsRepo,
  audit: AuditRepo
): Promise<void> {
  const scope = requireScope(ctx.memberships, input.schoolId);
  if (!can(scope.role, "marks:unlock")) {
    throw new ServiceError("FORBIDDEN", `${scope.role} cannot unlock sheets`);
  }
  if (!input.reason || input.reason.trim().length < 5) {
    throw new ServiceError("VALIDATION", "An explicit reason is required to unlock a sheet");
  }
  const sheet = await sheets.findSheet(input.schoolId, {
    classId: input.classId,
    subjectId: input.subjectId,
    termId: input.termId,
  });
  if (!sheet) throw new ServiceError("NOT_FOUND", "Sheet not found");
  if (sheet.state !== SheetState.APPROVED && sheet.state !== SheetState.LOCKED) {
    throw new ServiceError("STATE_CONFLICT", `Sheet is ${sheet.state}, not locked`);
  }
  const updated = await sheets.updateSheet(input.schoolId, sheet.id, {
    state: SheetState.DRAFT,
    lockedAt: null,
  });
  await audit.record(input.schoolId, {
    schoolId: input.schoolId,
    userId: ctx.userId,
    action: "SHEET_UNLOCKED",
    entity: "MarkSheet",
    entityId: sheet.id,
    after: { reason: input.reason, previousState: sheet.state },
    createdAt: ctx.now,
  });
  if (!updated) throw new ServiceError("NOT_FOUND", "Sheet vanished during update");
}
