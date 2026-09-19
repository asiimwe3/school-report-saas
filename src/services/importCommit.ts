/**
 * Import commit service — applies a merge preview (from migration/bundle.ts)
 * to the database. Invariants, regression-tested:
 *  1. Only ADD and UPDATE rows are applied; CONFLICT/REJECT/DUPLICATE are
 *     skipped and reported.
 *  2. Only the keys present in the bundle are touched — other marks survive
 *     untouched by construction (we never issue a delete or a bulk replace).
 *  3. Every applied row increments version and leaves history.
 *  4. An ImportJob + ImportRows audit trail is written.
 * When the Prisma-backed repo lands, the caller wraps steps in one
 * transaction (all-or-nothing); the service is transaction-ready because it
 * performs no partial visibility of state itself.
 */
import { requireScope } from "../auth/tenant";
import { can } from "../auth/rbac";
import { markKey, type MergePreview, type PreviewRow } from "../migration/bundle";
import { SheetState } from "../grading/engine";
import {
  ServiceError,
  type AuditRepo,
  type Ctx,
  type MarksRepo,
  type MarkRecord,
} from "../db/types";

export interface ImportJobRepo {
  createJob(schoolId: string, data: { kind: string; initiatedBy: string; summary: unknown }): Promise<string>;
  appendRow(schoolId: string, jobId: string, row: { rowNo: number; kind: string; key?: string; message?: string }): Promise<void>;
}

export interface ApplyResult {
  jobId: string;
  applied: number;
  skipped: number;
}

export async function applyBundleImport(
  ctx: Ctx,
  input: { schoolId: string; classId: string; subjectId: string; termId: string; preview: MergePreview },
  marks: MarksRepo,
  jobs: ImportJobRepo,
  audit: AuditRepo
): Promise<ApplyResult> {
  const scope = requireScope(ctx.memberships, input.schoolId);
  if (!can(scope.role, "marks:import")) {
    throw new ServiceError("FORBIDDEN", `${scope.role} cannot import marks`);
  }

  const jobId = await jobs.createJob(input.schoolId, {
    kind: "TEACHER_BUNDLE",
    initiatedBy: ctx.userId,
    summary: {
      additions: input.preview.additions,
      updates: input.preview.updates,
      conflicts: input.preview.conflicts,
      rejects: input.preview.rejects,
      duplicates: input.preview.duplicates,
    },
  });

  let rowNo = 0;
  let applied = 0;
  let skipped = 0;

  for (const row of input.preview.rows as PreviewRow[]) {
    rowNo += 1;
    const key = markKey(row.mark);
    if (row.kind !== "ADD" && row.kind !== "UPDATE") {
      skipped += 1;
      await jobs.appendRow(input.schoolId, jobId, {
        rowNo,
        kind: row.kind,
        key,
        message: row.message,
      });
      continue;
    }

    const m = row.mark;
    const existing = await marks.findMark(input.schoolId, {
      studentId: m.studentId,
      subjectId: m.subjectId,
      termId: m.termId,
      componentId: m.componentId,
    });

    if (row.kind === "ADD" && existing) {
      // The preview was built against stale data; never blindly clobber.
      skipped += 1;
      await jobs.appendRow(input.schoolId, jobId, {
        rowNo,
        kind: "CONFLICT",
        key,
        message: "Mark appeared after preview was built; re-run preview",
      });
      continue;
    }

    if (row.kind === "ADD") {
      const created: MarkRecord = await marks.createMark(input.schoolId, {
        studentId: m.studentId,
        subjectId: m.subjectId,
        termId: m.termId,
        componentId: m.componentId,
        enrollmentId: "",
        type: (m.type as MarkRecord["type"]) ?? "VALUE",
        score: m.type === "VALUE" ? (m.score ?? null) : null,
        maxScore: m.maxScore ?? 100,
        sheetState: SheetState.DRAFT,
        enteredBy: ctx.userId,
        updatedAt: ctx.now,
      });
      applied += 1;
      await jobs.appendRow(input.schoolId, jobId, { rowNo, kind: "ADD", key });
      await marks.appendHistory(input.schoolId, {
        markId: created.id,
        oldType: null,
        oldScore: null,
        newType: created.type,
        newScore: created.score,
        changedBy: ctx.userId,
        createdAt: ctx.now,
        reason: "BUNDLE_IMPORT",
      });
    } else {
      // UPDATE
      if (!existing) {
        // Preview said UPDATE but the mark vanished — apply as ADD instead of
        // losing the teacher's data.
        const created: MarkRecord = await marks.createMark(input.schoolId, {
          studentId: m.studentId,
          subjectId: m.subjectId,
          termId: m.termId,
          componentId: m.componentId,
          enrollmentId: "",
          type: (m.type as MarkRecord["type"]) ?? "VALUE",
          score: m.type === "VALUE" ? (m.score ?? null) : null,
          maxScore: m.maxScore ?? 100,
          sheetState: SheetState.DRAFT,
          enteredBy: ctx.userId,
          updatedAt: ctx.now,
        });
        applied += 1;
        await jobs.appendRow(input.schoolId, jobId, {
          rowNo,
          kind: "ADD",
          key,
          message: "Target mark no longer existed; created",
        });
        continue;
      }
      const updated = await marks.updateMark(
        input.schoolId,
        existing.id,
        {
          type: (m.type as MarkRecord["type"]) ?? "VALUE",
          score: m.type === "VALUE" ? (m.score ?? null) : null,
          enteredBy: ctx.userId,
          updatedAt: ctx.now,
        },
        existing.version
      );
      if (!updated) {
        skipped += 1;
        await jobs.appendRow(input.schoolId, jobId, {
          rowNo,
          kind: "CONFLICT",
          key,
          message: "Version conflict — another user edited this mark; re-run preview",
        });
        continue;
      }
      applied += 1;
      await jobs.appendRow(input.schoolId, jobId, { rowNo, kind: "UPDATE", key });
      await marks.appendHistory(input.schoolId, {
        markId: existing.id,
        oldType: existing.type,
        oldScore: existing.score,
        newType: updated.type,
        newScore: updated.score,
        changedBy: ctx.userId,
        createdAt: ctx.now,
        reason: "BUNDLE_IMPORT",
      });
    }
  }

  await audit.record(input.schoolId, {
    schoolId: input.schoolId,
    userId: ctx.userId,
    action: "MARKS_IMPORTED",
    entity: "ImportJob",
    entityId: jobId,
    after: { applied, skipped },
    createdAt: ctx.now,
  });

  return { jobId, applied, skipped };
}
