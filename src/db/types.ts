/**
 * Repository interfaces the service layer depends on. The Prisma-backed
 * implementations (src/db/prisma/*.ts) land with the API routes; tests use
 * in-memory doubles. Every repo method takes schoolId FIRST — tenant scope
 * is not optional at the persistence boundary.
 */
import type { MarkType, SheetState } from "../grading/engine";
import type { Role } from "../auth/rbac";

export class ServiceError extends Error {
  constructor(
    readonly code:
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "VERSION_CONFLICT"
      | "VALIDATION"
      | "SHEET_LOCKED"
      | "STATE_CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface MarkRecord {
  id: string;
  schoolId: string;
  studentId: string;
  subjectId: string;
  termId: string;
  componentId: string;
  enrollmentId: string;
  type: MarkType;
  score: number | null;
  maxScore: number;
  version: number;
  sheetState: SheetState;
  enteredBy: string | null;
  updatedAt: number; // epoch ms
}

export interface MarkHistoryRecord {
  markId: string;
  oldType: MarkType | null;
  oldScore: number | null;
  newType: MarkType;
  newScore: number | null;
  changedBy: string;
  reason?: string;
  createdAt: number;
}

export interface SheetRecord {
  id: string;
  schoolId: string;
  classId: string;
  subjectId: string;
  termId: string;
  state: SheetState;
  lockedAt: number | null;
}

export interface EnrollmentRecord {
  studentId: string;
  academicYearId: string;
  classId: string;
  streamId: string | null;
  status: string;
}

export interface SubjectRecord {
  id: string;
  schoolId: string;
  name: string;
  level: "PRIMARY" | "O_LEVEL" | "A_LEVEL";
  compulsory: boolean;
  principal: boolean;
  subsidiary: boolean;
  maxMarks: number;
  active: boolean;
}

export interface ComponentRecord {
  id: string;
  schoolId: string;
  subjectId: string | null;
  code: string;
  kind: "CA" | "EXAM";
  active: boolean;
}

export interface TermResultRecord {
  id: string;
  schoolId: string;
  studentId: string;
  termId: string;
  subjectId: string;
  total: number | null;
  percentage: number | null;
  grade: string | null;
  points: number | null;
  remark: string | null;
  complete: boolean;
  blockingReasons: string[];
  calculatedAt: number;
}

export interface AuditRecord {
  schoolId: string;
  userId: string;
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  createdAt: number;
}

export interface MarksRepo {
  findMark(schoolId: string, key: { studentId: string; subjectId: string; termId: string; componentId: string }): Promise<MarkRecord | null>;
  createMark(schoolId: string, data: Omit<MarkRecord, "id" | "version" | "schoolId">): Promise<MarkRecord>;
  /** Returns null on optimistic-concurrency mismatch. */
  updateMark(schoolId: string, id: string, patch: Partial<MarkRecord>, expectedVersion: number): Promise<MarkRecord | null>;
  listMarks(schoolId: string, filter: { termId: string; subjectId?: string; studentIds?: string[] }): Promise<MarkRecord[]>;
  appendHistory(schoolId: string, record: MarkHistoryRecord): Promise<void>;
}

export interface SheetsRepo {
  findSheet(schoolId: string, key: { classId: string; subjectId: string; termId: string }): Promise<SheetRecord | null>;
  createSheet(schoolId: string, data: Omit<SheetRecord, "id" | "schoolId">): Promise<SheetRecord>;
  updateSheet(schoolId: string, id: string, patch: Partial<SheetRecord>): Promise<SheetRecord | null>;
}

export interface RosterRepo {
  listEnrollments(schoolId: string, academicYearId: string): Promise<EnrollmentRecord[]>;
  listSubjects(schoolId: string): Promise<SubjectRecord[]>;
  listComponents(schoolId: string): Promise<ComponentRecord[]>;
  getSchool(schoolId: string): Promise<{ activeYearId: string | null } | null>;
}

export interface ResultsRepo {
  upsertTermResult(
    schoolId: string,
    key: { studentId: string; termId: string; subjectId: string },
    data: Omit<TermResultRecord, "id" | "schoolId" | "studentId" | "termId" | "subjectId">
  ): Promise<TermResultRecord>;
  listTermResults(schoolId: string, termId: string): Promise<TermResultRecord[]>;
}

export interface AuditRepo {
  record(schoolId: string, event: AuditRecord): Promise<void>;
}

/** Authenticated request context assembled by the route adapter. */
export interface Ctx {
  userId: string;
  memberships: { schoolId: string; role: Role; status: "INVITED" | "ACTIVE" | "SUSPENDED" | "REMOVED" }[];
  assignments: {
    teacherId: string;
    subjectId: string;
    classId: string;
    classTeacher: boolean;
    active: boolean;
  }[];
  now: number;
}
