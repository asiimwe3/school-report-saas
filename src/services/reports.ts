/**
 * Report card service — assembles validated data for one student's term
 * report card, RBAC-gated to reports:generate. Rendering (DOCX / print
 * HTML) lives in src/reports and consumes the ReportCardData produced here.
 */
import { can } from "../auth/rbac";
import { requireScope } from "../auth/tenant";
import { ServiceError, type Ctx } from "../db/types";

export interface ReportSubjectRow {
  subject: string;
  total: number | null;
  percentage: number | null;
  grade: string | null;
  points: number | null;
  remark: string | null;
}

export interface ReportCardData {
  schoolName: string;
  schoolMotto?: string;
  student: { name: string; admissionNo: string; sex: string; className: string; stream?: string; rollNo?: number | null };
  term: { name: string; year: string; endDate?: Date | null; nextTermBegins?: Date | null };
  subjects: ReportSubjectRow[];
  summary: { pointsTotal: number | null; division: string | null; rankLabel?: string | null };
  attendance: { present: number; absent: number; total: number } | null;
  comments: { classTeacher?: string; headTeacher?: string };
  generatedAt: Date;
}

export interface ReportsRepo {
  getSchool(schoolId: string): Promise<{ id: string; name: string; motto?: string | null } | null>;
  getStudent(schoolId: string, studentId: string): Promise<{
    id: string; firstName: string; middleName?: string | null; lastName: string;
    sex: string; admissionNo: string;
  } | null>;
  getEnrollment(schoolId: string, studentId: string, termId: string): Promise<{
    classId: string; className: string; level: string; streamName?: string | null; rollNo?: number | null;
  } | null>;
  getTerm(schoolId: string, termId: string): Promise<{
    id: string; name: string; year: string; endDate?: Date | null; nextTermBegins?: Date | null;
  } | null>;
  getSubjectResults(schoolId: string, studentId: string, termId: string): Promise<ReportSubjectRow[]>;
  getAttendance(schoolId: string, studentId: string, termId: string): Promise<{
    present: number; absent: number; total: number;
  } | null>;
  getComments(schoolId: string, studentId: string, termId: string): Promise<{
    classTeacher?: string; headTeacher?: string;
  }>;
}

const sum = (xs: Array<number | null>) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

export async function buildReportCard(
  ctx: Ctx,
  input: { schoolId: string; studentId: string; termId: string },
  repo: ReportsRepo
): Promise<ReportCardData> {
  const scope = requireScope(ctx.memberships, input.schoolId);
  if (!can(scope.role, "reports:generate")) {
    throw new ServiceError("FORBIDDEN", `${scope.role} cannot generate reports`);
  }

  const school = await repo.getSchool(input.schoolId);
  if (!school) throw new ServiceError("NOT_FOUND", "School not found");

  const student = await repo.getStudent(input.schoolId, input.studentId);
  if (!student) throw new ServiceError("NOT_FOUND", "Student not found");

  const term = await repo.getTerm(input.schoolId, input.termId);
  if (!term) throw new ServiceError("NOT_FOUND", "Term not found");

  const enrollment = await repo.getEnrollment(input.schoolId, input.studentId, input.termId);
  if (!enrollment) {
    throw new ServiceError("NOT_FOUND", "Student is not enrolled in this term's academic year");
  }

  const subjects = await repo.getSubjectResults(input.schoolId, input.studentId, input.termId);
  const [attendance, comments] = await Promise.all([
    repo.getAttendance(input.schoolId, input.studentId, input.termId),
    repo.getComments(input.schoolId, input.studentId, input.termId),
  ]);

  const graded = subjects.filter((s) => s.points !== null);
  const pointsTotal = graded.length ? sum(graded.map((s) => s.points)) : null;
  const division =
    enrollment.level === "PLE"
      ? pointsTotal !== null
        ? `Division ${pointsTotal <= 12 ? "One" : pointsTotal <= 17 ? "Two" : pointsTotal <= 21 ? "Three" : pointsTotal <= 25 ? "Four" : "U"}`
        : null
      : enrollment.level === "UCE"
        ? pointsTotal !== null
          ? `Aggregate ${pointsTotal}`
          : null
        : pointsTotal !== null
          ? `${pointsTotal} points`
          : null;

  return {
    schoolName: school.name,
    schoolMotto: school.motto ?? undefined,
    student: {
      name: `${student.firstName} ${student.middleName ? student.middleName + " " : ""}${student.lastName}`,
      admissionNo: student.admissionNo,
      sex: student.sex,
      className: enrollment.className,
      stream: enrollment.streamName ?? undefined,
      rollNo: enrollment.rollNo ?? null,
    },
    term: {
      name: term.name,
      year: term.year,
      endDate: term.endDate ?? null,
      nextTermBegins: term.nextTermBegins ?? null,
    },
    subjects,
    summary: { pointsTotal, division },
    attendance,
    comments,
    generatedAt: new Date(),
  };
}
