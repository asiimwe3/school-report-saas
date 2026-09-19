/**
 * Grading engine — single source of truth, ported from the Kotlin core
 * (core/.../grading/Grading.kt). Report renderers, dashboards, merit lists
 * and every API must consume the result objects produced here. No renderer
 * may recalculate averages or grades.
 *
 * All boundaries, weights, thresholds and best-subject counts are data
 * (GradingScheme), never hard-coded logic.
 */

export enum Level {
  PRIMARY = "PRIMARY",
  O_LEVEL = "O_LEVEL",
  A_LEVEL = "A_LEVEL",
}

export enum MarkType {
  VALUE = "VALUE",
  ABS = "ABS", // absent
  MISSING = "MISSING", // not yet provided
  EXEMPT = "EXEMPT", // student exempted from the component
  NA = "NA", // not applicable
}

export enum SheetState {
  DRAFT = "DRAFT",
  SUBMITTED = "SUBMITTED",
  REVIEWED = "REVIEWED",
  APPROVED = "APPROVED",
  LOCKED = "LOCKED",
}

/** Special (non-VALUE) marks must NEVER silently become zero. */
export const isSpecial = (t: MarkType): boolean => t !== MarkType.VALUE;

export interface GradeBoundary {
  minScore: number;
  maxScore: number;
  grade: string;
  label: string;
  points: number;
  remark: string;
}

export interface DivisionBoundary {
  maxAggregate: number;
  division: string;
  note?: string;
}

export interface GradingScheme {
  id: string;
  name: string;
  level: Level;
  aggregateRule: "PLE_AGGREGATE" | "UCE_INDICATOR" | "UACE_POINTS";
  aggregateBestSubjects?: number;
  caWeightPercent?: number;
  examWeightPercent?: number;
  principalCount?: number;
  subsidiaryCounts?: boolean;
  subsidiaryThresholdGrade?: string;
  boundaries: GradeBoundary[];
  divisionTable?: DivisionBoundary[];
}

/** One component mark as stored (VALUE or special). */
export interface ComponentMark {
  componentId: string;
  componentCode: string;
  componentKind: "CA" | "EXAM";
  type: MarkType;
  score?: number | null;
  maxScore: number;
}

export interface SubjectInput {
  subjectId: string;
  name: string;
  compulsory: boolean;
  principal: boolean;
  subsidiary: boolean;
  maxMarks: number;
  marks: ComponentMark[];
}

export interface SubjectResult {
  subjectId: string;
  name: string;
  total: number | null;
  percentage: number | null;
  grade: string | null;
  points: number | null;
  remark: string | null;
  complete: boolean;
  blockingReasons: string[];
  principal: boolean;
  subsidiary: boolean;
  /** true when the subject counts toward the aggregate/points pool */
  countsTowardAggregate: boolean;
}

export interface AggregateResult {
  rule: GradingScheme["aggregateRule"];
  aggregate: number | null;
  division: string | null;
  points: number | null;
  resultIndicator?: string; // UCE: Result 1 / 2 / 3
  basedOnSubjects: string[];
}

export interface TermResult {
  subjects: SubjectResult[];
  aggregate: AggregateResult | null;
  complete: boolean;
  blockingReasons: string[];
}

// ── Boundary lookup (ported: gap/overflow clamp behaviour preserved) ─────────

export function boundaryFor(scheme: GradingScheme, percentage: number): GradeBoundary | undefined {
  const exact = scheme.boundaries.find((b) => percentage >= b.minScore && percentage <= b.maxScore);
  if (exact) return exact;
  // Between ranges (e.g. 89.4 in an ..89 scheme): highest boundary starting at/below.
  const below = scheme.boundaries.filter((b) => percentage >= b.minScore);
  if (below.length > 0) return below.reduce((a, b) => (b.minScore > a.minScore ? b : a));
  // Below every range: clamp to the lowest boundary.
  return scheme.boundaries.reduce((a, b) => (b.minScore < a.minScore ? b : a));
}

export function grade(scheme: GradingScheme, pct: number): string {
  return boundaryFor(scheme, pct)?.grade ?? "—";
}
export function points(scheme: GradingScheme, pct: number): number {
  return boundaryFor(scheme, pct)?.points ?? 0;
}
export function remark(scheme: GradingScheme, pct: number): string {
  return boundaryFor(scheme, pct)?.remark ?? "";
}

export function divisionForAggregate(scheme: GradingScheme, aggregate: number): string {
  if (!scheme.divisionTable) return "—";
  return (
    scheme.divisionTable.find((d) => aggregate <= d.maxAggregate)?.division ?? "Division U"
  );
}

// ── Subject computation ──────────────────────────────────────────────────────

/**
 * Compute one subject's result for one student.
 * UCE (weighted): total = CA*(caW/100) + EXAM*(examW/100); a missing CA or
 * EXAM component makes the subject INCOMPLETE (never silently zero).
 * Unweighted (PLE): total = sum of VALUE components / sum of maxScores * maxMarks.
 * ABS/MISSING/EXEMPT/NA never contribute zero.
 */
export function computeSubject(scheme: GradingScheme, subject: SubjectInput): SubjectResult {
  const reasons: string[] = [];
  const weighted = scheme.caWeightPercent !== undefined && scheme.examWeightPercent !== undefined;

  const valued = subject.marks.filter((m) => m.type === MarkType.VALUE && typeof m.score === "number");
  const specials = new Map(subject.marks.filter((m) => isSpecial(m.type)).map((m) => [m.type, m]));

  let total: number | null = null;
  let pct: number | null = null;

  if (weighted) {
    const ca = valued.find((m) => m.componentKind === "CA");
    const exam = valued.find((m) => m.componentKind === "EXAM");
    const caW = scheme.caWeightPercent ?? 0;
    const examW = scheme.examWeightPercent ?? 0;
    if (!ca) reasons.push("MISSING_CA");
    if (!exam) reasons.push("MISSING_EXAM");
    if (ca && exam) {
      // CA scores are stored out of their maxScore; normalise to weight base 100.
      const caPct = ((ca.score as number) / ca.maxScore) * 100;
      const examPct = ((exam.score as number) / exam.maxScore) * 100;
      total = round2((caPct * caW) / 100 + (examPct * examW) / 100);
      pct = total;
    } else {
      total = null;
      pct = null;
    }
  } else {
    if (subject.marks.length === 0 || valued.length === 0) {
      reasons.push("NO_MARKS");
    } else {
      const sum = valued.reduce((a, m) => a + (m.score as number), 0);
      const maxSum = valued.reduce((a, m) => a + m.maxScore, 0);
      pct = round2((sum / (maxSum || 100)) * subject.maxMarks);
      total = round2(sum);
    }
  }

  const complete = reasons.length === 0 && pct !== null;
  const b = pct !== null ? boundaryFor(scheme, pct) : undefined;

  return {
    subjectId: subject.subjectId,
    name: subject.name,
    total,
    percentage: pct,
    grade: b?.grade ?? null,
    points: b?.points ?? null,
    remark: b?.remark ?? null,
    complete,
    blockingReasons: reasons.filter(Boolean),
    principal: subject.principal,
    subsidiary: subject.subsidiary,
    countsTowardAggregate: complete,
  };
}

// ── Aggregate computation ────────────────────────────────────────────────────

/**
 * PLE: aggregate = sum of grade points of the best `aggregateBestSubjects`
 * complete subjects (configurable; default 4). Division from the table.
 */
function pleAggregate(scheme: GradingScheme, subjects: SubjectResult[]): AggregateResult {
  const pool = subjects.filter((s) => s.countsTowardAggregate && s.points !== null);
  const best = [...pool]
    .sort((a, b) => (a.points as number) - (b.points as number))
    .slice(0, scheme.aggregateBestSubjects ?? 4);
  if (best.length === 0) {
    return { rule: "PLE_AGGREGATE", aggregate: null, division: null, points: null, basedOnSubjects: [] };
  }
  const aggregate = best.reduce((a, s) => a + (s.points as number), 0);
  return {
    rule: "PLE_AGGREGATE",
    aggregate,
    division: divisionForAggregate(scheme, aggregate),
    points: aggregate,
    basedOnSubjects: best.map((s) => s.subjectId),
  };
}

/**
 * UCE result indicator (ported rule):
 *  Result 2 = a compulsory subject is missing/incomplete,
 *  Result 3 = all graded compulsory subjects are E,
 *  Result 1 = qualified (at least one D or better among compulsory subjects).
 */
export function uceResultIndicator(allE: boolean, missingCompulsory: boolean): string {
  if (missingCompulsory) return "Result 2";
  if (allE) return "Result 3";
  return "Result 1";
}

/**
 * UACE: principal points = sum of points of the configured number of
 * principal subjects ONLY (a subsidiary can never substitute a principal).
 * A subsidiary adds 1 point only when its grade satisfies the configured
 * threshold (e.g. not "F").
 */
function uaceAggregate(scheme: GradingScheme, subjects: SubjectResult[]): AggregateResult {
  // Lower points are better (A=1 … E=5, O=6): the best principals are the
  // three with the FEWEST points. A subsidiary never enters this pool.
  const principals = subjects
    .filter((s) => s.principal && s.countsTowardAggregate && s.points !== null)
    .sort((a, b) => (a.points as number) - (b.points as number))
    .slice(0, scheme.principalCount ?? 3);

  let pointsSum = principals.reduce((a, s) => a + (s.points as number), 0);
  const basedOn = principals.map((s) => s.subjectId);

  if (scheme.subsidiaryCounts) {
    const threshold = scheme.subsidiaryThresholdGrade ?? "F";
    const subs = subjects.filter(
      (s) => s.subsidiary && s.countsTowardAggregate && s.grade !== null && s.grade !== threshold && s.grade !== "F"
    );
    for (const sub of subs) {
      pointsSum += 1; // subsidiary credit: one point per qualifying subsidiary
      basedOn.push(sub.subjectId);
    }
  }

  const enoughPrincipals = principals.length === (scheme.principalCount ?? 3);
  return {
    rule: "UACE_POINTS",
    aggregate: enoughPrincipals ? pointsSum : null,
    division: null,
    points: enoughPrincipals ? pointsSum : null,
    basedOnSubjects: basedOn,
  };
}

export function computeTermResult(
  scheme: GradingScheme,
  subjects: SubjectInput[]
): TermResult {
  const results = subjects.map((s) => computeSubject(scheme, s));
  const blockingReasons = results.flatMap((r) => r.blockingReasons.map((x) => `${r.name}:${x}`));

  let aggregate: AggregateResult | null = null;
  if (scheme.aggregateRule === "PLE_AGGREGATE") aggregate = pleAggregate(scheme, results);
  else if (scheme.aggregateRule === "UACE_POINTS") aggregate = uaceAggregate(scheme, results);
  else {
    // UCE: indicator over complete subjects; compulsory gating applies.
    const complete = results.filter((r) => r.complete && r.grade !== null);
    const anyIncomplete = results.some((r) => !r.complete);
    // Compulsory-subject gating: an incomplete compulsory subject ⇒ Result 2.
    const missingCompulsory = results.some((r) => !r.complete && subjectIsCompulsory(r, subjects));
    const gradedCompulsory = complete.filter((r) => subjectIsCompulsory(r, subjects));
    const allE = gradedCompulsory.length > 0 && gradedCompulsory.every((r) => r.grade === "E");
    aggregate = {
      rule: "UCE_INDICATOR",
      aggregate: null,
      division: null,
      points: null,
      resultIndicator: uceResultIndicator(allE, missingCompulsory),
      basedOnSubjects: complete.map((r) => r.subjectId),
    };
    if (anyIncomplete) blockingReasons.push("INCOMPLETE_SUBJECTS_PRESENT");
  }

  return {
    subjects: results,
    aggregate,
    complete: blockingReasons.length === 0,
    blockingReasons: [...new Set(blockingReasons)],
  };
}

function subjectIsCompulsory(r: SubjectResult, inputs: SubjectInput[]): boolean {
  return inputs.find((i) => i.subjectId === r.subjectId)?.compulsory ?? false;
}

// ── Ranking (competition: 1, 2, 2, 4) ───────────────────────────────────────

export interface RankRow {
  studentId: string;
  /** rank key: aggregate (PLE), points (UACE) or average percentage */
  key: number | null;
  streamId?: string | null;
}

export interface RankedRow extends RankRow {
  position: number | null; // null when unrankable
  streamPosition: number | null;
}

/**
 * Competition ranking (1, 2, 2, 4). Students with null keys (incomplete or
 * invalid results) are NOT ranked unless `rankIncomplete` is explicitly
 * enabled by the school.
 */
export function rank(
  rows: RankRow[],
  opts: { rankIncomplete?: boolean } = {}
): RankedRow[] {
  const rankable = rows.filter((r) => r.key !== null);
  const sorted = [...rankable].sort((a, b) => (a.key as number) - (b.key as number));

  const positionOf = new Map<string, number>();
  let pos = 0;
  let prev: number | null = null;
  let prevPos = 0;
  for (const r of sorted) {
    pos += 1;
    if (prev === null || r.key !== prev) {
      prevPos = pos;
      prev = r.key;
    }
    positionOf.set(r.studentId, prevPos);
  }

  const streams = new Map<string, RankRow[]>();
  for (const r of rankable) {
    const k = r.streamId ?? "_";
    if (!streams.has(k)) streams.set(k, []);
    streams.get(k)!.push(r);
  }
  const streamPosOf = new Map<string, number>();
  for (const [, srows] of streams) {
    const sSorted = [...srows].sort((a, b) => (a.key as number) - (b.key as number));
    let sp = 0;
    let sPrev: number | null = null;
    let sPrevPos = 0;
    for (const r of sSorted) {
      sp += 1;
      if (sPrev === null || r.key !== sPrev) {
        sPrevPos = sp;
        sPrev = r.key;
      }
      streamPosOf.set(r.studentId, sPrevPos);
    }
  }

  return rows.map((r) => ({
    ...r,
    position: r.key !== null ? positionOf.get(r.studentId) ?? null : opts.rankIncomplete ? 0 : null,
    streamPosition: r.key !== null && r.streamId ? streamPosOf.get(r.studentId) ?? null : null,
  }));
}

// ── Roster scoping (academic year + term explicit, never inferred) ──────────

export interface EnrollmentLike {
  studentId: string;
  academicYearId: string;
  classId: string;
  status: string;
}

/**
 * Current roster = ACTIVE enrollments for the explicit academic year.
 * A previous-year enrollment must NEVER leak into the current roster.
 */
export function rosterFor(enrollments: EnrollmentLike[], academicYearId: string, classId?: string): string[] {
  return enrollments
    .filter((e) => e.academicYearId === academicYearId && e.status === "ACTIVE")
    .filter((e) => !classId || e.classId === classId)
    .map((e) => e.studentId);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
