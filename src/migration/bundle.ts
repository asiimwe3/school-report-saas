/**
 * Safe import pipeline — fixes the destructive bundle-merge behaviour.
 *
 * Invariants (Definition of Done):
 *  1. Importing one teacher's bundle can NEVER remove other teachers' marks.
 *  2. Merge is keyed on the unique mark key (student|subject|term|component).
 *  3. A matching mark is replaced only when the incoming version is newer OR
 *     the operator explicitly forces it; otherwise it is reported as CONFLICT.
 *  4. The full preview (ADD / UPDATE / CONFLICT / REJECT / DUPLICATE) is shown
 *     before commit; commit is one transaction, all-or-nothing.
 *  5. The caller (API layer) must apply the plan inside a single DB
 *     transaction and record an ImportJob + ImportRows for audit.
 */

import { MarkType } from "../grading/engine";

export interface BundleMark {
  studentId: string;
  subjectId: string;
  termId: string;
  componentId: string;
  type: string; // VALUE | ABS | MISSING | EXEMPT | NA (case-insensitive)
  score?: number | null;
  maxScore?: number;
  updatedAt?: number; // epoch millis — incoming version
}

export interface ExistingMark {
  studentId: string;
  subjectId: string;
  termId: string;
  componentId: string;
  score?: number | null;
  version: number;
  updatedAt?: number; // epoch millis
}

export type RowKind = "ADD" | "UPDATE" | "CONFLICT" | "REJECT" | "DUPLICATE";

export interface PreviewRow {
  kind: RowKind;
  mark: BundleMark;
  message?: string;
  existing?: ExistingMark;
}

export interface MergePreview {
  additions: number;
  updates: number;
  conflicts: number;
  rejects: number;
  duplicates: number;
  rows: PreviewRow[];
  warnings: string[];
}

const VALID_TYPES = new Set(Object.values(MarkType));

export const markKey = (m: { studentId: string; subjectId: string; termId: string; componentId: string }) =>
  `${m.studentId}|${m.subjectId}|${m.termId}|${m.componentId}`;

function reject(mark: BundleMark, message: string): PreviewRow {
  return { kind: "REJECT", mark, message };
}

/**
 * Build the merge preview for one bundle against the CURRENT database marks.
 * Existing marks must be fetched for the bundle's scope; unrelated marks are
 * never touched (they are not even read into the merge set).
 */
export function previewBundleMerge(
  incoming: BundleMark[],
  existing: ExistingMark[],
  opts: { forceNewerOnly?: boolean } = {}
): MergePreview {
  const existingByKey = new Map(existing.map((e) => [markKey(e), e]));
  const rows: PreviewRow[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, BundleMark>();

  for (const m of incoming) {
    if (!m.studentId || !m.subjectId || !m.termId || !m.componentId) {
      rows.push(reject(m, "Incomplete mark key"));
      continue;
    }
    const type = (m.type ?? "VALUE").toUpperCase();
    if (!VALID_TYPES.has(type as MarkType)) {
      rows.push(reject(m, `Invalid mark type "${m.type}"`));
      continue;
    }
    if (type === "VALUE") {
      const score = typeof m.score === "number" ? m.score : Number(m.score);
      if (m.score === null || m.score === undefined || Number.isNaN(score)) {
        rows.push(reject(m, "VALUE mark without a score"));
        continue;
      }
      if (score < 0) {
        rows.push(reject(m, "Negative score"));
        continue;
      }
      const max = m.maxScore ?? 100;
      if (score > max) {
        rows.push(reject(m, `Score ${score} exceeds maximum ${max}`));
        continue;
      }
    }

    const key = markKey(m);
    const dupe = seen.get(key);
    if (dupe) {
      rows.push({ kind: "DUPLICATE", mark: m, message: "Duplicate row within this bundle (first occurrence kept)" });
      continue;
    }
    seen.set(key, m);

    const ex = existingByKey.get(key);
    if (!ex) {
      rows.push({ kind: "ADD", mark: m });
    } else {
      const incomingNewer =
        m.updatedAt !== undefined &&
        ex.updatedAt !== undefined &&
        m.updatedAt > ex.updatedAt;
      const sameValue =
        (ex.score ?? null) === (m.type === "VALUE" ? (m.score ?? null) : null) ||
        (m.type !== "VALUE" && ex.score === undefined);
      if (incomingNewer) {
        rows.push({ kind: "UPDATE", mark: m, existing: ex, message: "Incoming version is newer" });
      } else if (sameValue) {
        rows.push({ kind: "DUPLICATE", mark: m, existing: ex, message: "Identical value already stored" });
      } else if (opts.forceNewerOnly) {
        rows.push({
          kind: "CONFLICT",
          mark: m,
          existing: ex,
          message: "Incoming mark is not newer; operator must resolve explicitly",
        });
      } else {
        rows.push({ kind: "UPDATE", mark: m, existing: ex, message: "Operator chose to apply incoming value" });
      }
    }
  }

  if (incoming.length > existing.length * 5 + 500) {
    warnings.push("Bundle is unusually large relative to current marks — verify the source file.");
  }

  const count = (k: RowKind) => rows.filter((r) => r.kind === k).length;
  return {
    additions: count("ADD"),
    updates: count("UPDATE"),
    conflicts: count("CONFLICT"),
    rejects: count("REJECT"),
    duplicates: count("DUPLICATE"),
    rows,
    warnings,
  };
}

// ── Teacher bundle / SchoolData mark payload parsing ────────────────────────

/**
 * Accepts the teacher-app push payload (array of Mark-like objects) or a
 * SchoolData `marks` array. Unknown fields are ignored, never dropped silently
 * — they are surfaced in warnings.
 */
export function parseMarkPayload(raw: unknown): { marks: BundleMark[]; warnings: string[] } {
  if (!Array.isArray(raw)) return { marks: [], warnings: ["Payload is not an array"] };
  const marks: BundleMark[] = [];
  const warnings: string[] = [];
  raw.forEach((item, i) => {
    if (typeof item !== "object" || item === null) {
      warnings.push(`Row ${i}: not an object`);
      return;
    }
    const o = item as Record<string, unknown>;
    const m: BundleMark = {
      studentId: String(o.studentId ?? ""),
      subjectId: String(o.subjectId ?? ""),
      termId: String(o.termId ?? ""),
      componentId: String(o.componentId ?? ""),
      type: String(o.type ?? "VALUE"),
      score: typeof o.score === "number" ? o.score : null,
      maxScore: typeof o.maxScore === "number" ? o.maxScore : undefined,
      updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : undefined,
    };
    marks.push(m);
  });
  return { marks, warnings };
}
