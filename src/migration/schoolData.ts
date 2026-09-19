/**
 * SchoolData (desktop JSON v2) migration parser + validation.
 * Produces a dry-run report BEFORE any commit; nothing here writes to a DB.
 * Invalid references, duplicate students and duplicate marks are detected and
 * reported for download — the operator confirms before commit.
 */

export interface MigrationReport {
  counts: { students: number; enrollments: number; subjects: number; classes: number; marks: number; teachers: number; academicYears: number; feePayments: number };
  duplicateStudents: { admissionNo: string; names: string[] }[];
  duplicateMarks: string[];
  invalidReferences: string[];
  errors: string[];
  valid: boolean;
}

interface LooseRecord { [k: string]: unknown }

const asArray = (v: unknown): LooseRecord[] => (Array.isArray(v) ? (v as LooseRecord[]) : []);

export function parseSchoolData(raw: unknown): { report: MigrationReport; students: LooseRecord[]; marks: LooseRecord[]; enrollments: LooseRecord[]; subjects: LooseRecord[]; classes: LooseRecord[]; teachers: LooseRecord[]; academicYears: LooseRecord[]; feePayments: LooseRecord[] } {
  const report: MigrationReport = {
    counts: { students: 0, enrollments: 0, subjects: 0, classes: 0, marks: 0, teachers: 0, academicYears: 0, feePayments: 0 },
    duplicateStudents: [],
    duplicateMarks: [],
    invalidReferences: [],
    errors: [],
    valid: true,
  };

  if (typeof raw !== "object" || raw === null) {
    report.errors.push("Not a JSON object");
    report.valid = false;
    return { report, students: [], marks: [], enrollments: [], subjects: [], classes: [], teachers: [], academicYears: [], feePayments: [] };
  }
  const data = raw as LooseRecord;

  const students = asArray(data.students);
  const enrollments = asArray(data.enrollments);
  const subjects = asArray(data.subjects);
  const classes = asArray(data.classes);
  const teachers = asArray(data.teachers);
  const academicYears = asArray(data.academicYears);
  const marks = asArray(data.marks);
  const feePayments = asArray(data.feePayments);

  report.counts = {
    students: students.length,
    enrollments: enrollments.length,
    subjects: subjects.length,
    classes: classes.length,
    marks: marks.length,
    teachers: teachers.length,
    academicYears: academicYears.length,
    feePayments: feePayments.length,
  };

  // duplicate students (same admissionNo)
  const byAdm = new Map<string, string[]>();
  for (const s of students) {
    const adm = String(s.admissionNo ?? "");
    const name = [s.firstName, s.middleName, s.lastName].filter(Boolean).join(" ");
    if (!byAdm.has(adm)) byAdm.set(adm, []);
    byAdm.get(adm)!.push(name);
  }
  for (const [adm, names] of byAdm) {
    if (names.length > 1) report.duplicateStudents.push({ admissionNo: adm, names });
  }

  // valid reference sets
  const studentIds = new Set(students.map((s) => String(s.id ?? "")));
  const subjectIds = new Set(subjects.map((s) => String(s.id ?? "")));
  const termIds = new Set<string>();
  for (const y of academicYears) {
    for (const t of asArray(y.terms)) termIds.add(String(t.id ?? ""));
  }
  const componentIds = new Set(asArray(data.components).map((c) => String(c.id ?? "")));

  // duplicate marks by unique key
  const seenMark = new Map<string, number>();
  for (const m of marks) {
    const key = `${m.studentId}|${m.subjectId}|${m.termId}|${m.componentId}`;
    seenMark.set(key, (seenMark.get(key) ?? 0) + 1);
    if (!studentIds.has(String(m.studentId))) report.invalidReferences.push(`mark→student "${m.studentId}"`);
    if (!subjectIds.has(String(m.subjectId))) report.invalidReferences.push(`mark→subject "${m.subjectId}"`);
    if (!termIds.has(String(m.termId))) report.invalidReferences.push(`mark→term "${m.termId}"`);
    if (!componentIds.has(String(m.componentId))) report.invalidReferences.push(`mark→component "${m.componentId}"`);
  }
  for (const [key, n] of seenMark) if (n > 1) report.duplicateMarks.push(key);

  for (const e of enrollments) {
    if (!studentIds.has(String(e.studentId))) report.invalidReferences.push(`enrollment→student "${e.studentId}"`);
  }

  // negative / invalid payments
  for (const p of feePayments) {
    const amt = Number(p.amount ?? 0);
    if (Number.isNaN(amt) || amt < 0) report.errors.push(`feePayment "${p.id}": invalid amount ${p.amount}`);
  }

  report.valid = report.errors.length === 0;
  return { report, students, marks, enrollments, subjects, classes, teachers, academicYears, feePayments };
}
