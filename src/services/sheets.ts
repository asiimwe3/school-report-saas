/**
 * Mark sheet workflow — state machine with role gating:
 * DRAFT → SUBMITTED → REVIEWED → APPROVED → LOCKED.
 * Only the head teacher (or owner) advances past SUBMITTED; unlocking goes
 * back to DRAFT and always requires a reason (see marks.ts unlockSheet).
 */
import { requireScope } from "../auth/tenant";
import { can } from "../auth/rbac";
import { SheetState } from "../grading/engine";
import { ServiceError, type AuditRepo, type Ctx, type SheetsRepo } from "../db/types";

const TRANSITIONS: Partial<Record<SheetState, { to: SheetState; action: string; permission: "marks:enter" | "marks:approve" | "marks:lock" }[]>> = {
  [SheetState.DRAFT]: [
    { to: SheetState.SUBMITTED, action: "SHEET_SUBMITTED", permission: "marks:enter" },
  ],
  [SheetState.SUBMITTED]: [
    { to: SheetState.REVIEWED, action: "SHEET_REVIEWED", permission: "marks:approve" },
    { to: SheetState.DRAFT, action: "SHEET_RETURNED", permission: "marks:approve" },
  ],
  [SheetState.REVIEWED]: [
    { to: SheetState.APPROVED, action: "SHEET_APPROVED", permission: "marks:approve" },
    { to: SheetState.DRAFT, action: "SHEET_RETURNED", permission: "marks:approve" },
  ],
  [SheetState.APPROVED]: [
    { to: SheetState.LOCKED, action: "SHEET_LOCKED", permission: "marks:lock" },
  ],
};

export async function transitionSheet(
  ctx: Ctx,
  input: { schoolId: string; classId: string; subjectId: string; termId: string; to: SheetState },
  sheets: SheetsRepo,
  audit: AuditRepo
): Promise<SheetState> {
  const scope = requireScope(ctx.memberships, input.schoolId);
  const sheet = await sheets.findSheet(input.schoolId, {
    classId: input.classId,
    subjectId: input.subjectId,
    termId: input.termId,
  });
  if (!sheet) throw new ServiceError("NOT_FOUND", "Sheet not found");

  const allowed = TRANSITIONS[sheet.state]?.find((t) => t.to === input.to);
  if (!allowed) {
    throw new ServiceError("STATE_CONFLICT", `Cannot move sheet from ${sheet.state} to ${input.to}`);
  }
  if (!can(scope.role, allowed.permission)) {
    throw new ServiceError("FORBIDDEN", `${scope.role} cannot ${allowed.action}`);
  }

  const updated = await sheets.updateSheet(input.schoolId, sheet.id, {
    state: input.to,
    lockedAt: input.to === SheetState.LOCKED ? ctx.now : null,
  });
  if (!updated) throw new ServiceError("NOT_FOUND", "Sheet vanished during update");

  await audit.record(input.schoolId, {
    schoolId: input.schoolId,
    userId: ctx.userId,
    action: allowed.action,
    entity: "MarkSheet",
    entityId: sheet.id,
    before: { state: sheet.state },
    after: { state: input.to },
    createdAt: ctx.now,
  });
  return input.to;
}
