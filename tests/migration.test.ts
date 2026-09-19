import { describe, expect, it } from "vitest";
import { previewBundleMerge, parseMarkPayload, type BundleMark, type ExistingMark } from "../src/migration/bundle";
import { parseSchoolData } from "../src/migration/schoolData";

const bm = (over: Partial<BundleMark> = {}): BundleMark => ({
  studentId: "st1",
  subjectId: "sub1",
  termId: "t1",
  componentId: "cEX",
  type: "VALUE",
  score: 70,
  updatedAt: 1000,
  ...over,
});

const ex = (over: Partial<ExistingMark> = {}): ExistingMark => ({
  studentId: "st1",
  subjectId: "sub1",
  termId: "t1",
  componentId: "cEX",
  score: 50,
  version: 1,
  updatedAt: 500,
  ...over,
});

describe("bundle merge preview", () => {
  it("classifies adds, updates, duplicates, rejects and conflicts", () => {
    const incoming = [
      bm(), // st1/sub1 newer → UPDATE
      bm({ subjectId: "sub2", updatedAt: undefined }), // new → ADD
      bm({ score: -5 }), // negative → REJECT
      bm({ subjectId: "sub1", updatedAt: 1000 }), // duplicate key inside bundle → DUPLICATE
      bm({ score: 120 }), // over max → REJECT
      bm({ type: "NONSENSE" }), // invalid type → REJECT
    ];
    const existing = [ex()];
    const p = previewBundleMerge(incoming, existing);
    expect(p.additions).toBe(1);
    expect(p.updates).toBe(1);
    expect(p.rejects).toBe(3);
    expect(p.duplicates).toBe(1);
    expect(p.conflicts).toBe(0);
  });

  it("KEY SAFETY: importing one subject never touches other subjects' marks", () => {
    // Bundle contains ONLY math marks. Existing store has math + english + science.
    const existing = [ex(), ex({ subjectId: "eng" }), ex({ subjectId: "sci" })];
    const p = previewBundleMerge([bm()], existing);
    // Only rows for incoming marks exist; english and science are untouched —
    // proven by the merge plan referencing exactly one key.
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]?.kind).toBe("UPDATE");
    const touchedKeys = p.rows.map((r) => `${r.mark.subjectId}`);
    expect(touchedKeys).not.toContain("eng");
    expect(touchedKeys).not.toContain("sci");
  });

  it("older incoming versions become conflicts under forceNewerOnly", () => {
    const incoming = bm({ updatedAt: 100 }); // older
    const existing = [ex({ updatedAt: 500 })];
    const p = previewBundleMerge([incoming], existing, { forceNewerOnly: true });
    expect(p.conflicts).toBe(1);
  });

  it("identical values are duplicates, not updates", () => {
    const p = previewBundleMerge([bm({ score: 50, updatedAt: 400 })], [ex({ score: 50, updatedAt: 500 })]);
    expect(p.duplicates).toBe(1);
    expect(p.updates).toBe(0);
  });

  it("special marks (ABS/MISSING/EXEMPT/NA) are valid without scores", () => {
    const p = previewBundleMerge([bm({ type: "ABS", score: null }), bm({ type: "MISSING", score: null, componentId: "cCA" })], []);
    expect(p.additions).toBe(2);
    expect(p.rejects).toBe(0);
  });
});

describe("payload parsing", () => {
  it("parses a teacher-app marks array", () => {
    const { marks, warnings } = parseMarkPayload([
      { studentId: "a", subjectId: "b", termId: "c", componentId: "d", score: 60, type: "VALUE", updatedAt: 123 },
      "garbage row",
    ]);
    expect(marks).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });
});

describe("SchoolData migration parsing", () => {
  const schoolData = {
    schemaVersion: 2,
    school: { id: "sch", name: "Test Primary" },
    students: [
      { id: "s1", admissionNo: "001", firstName: "A", lastName: "B" },
      { id: "s2", admissionNo: "001", firstName: "C", lastName: "D" }, // duplicate admission no
    ],
    subjects: [{ id: "sub1", name: "Maths" }],
    academicYears: [{ id: "y1", year: "2026", terms: [{ id: "t1", number: 1 }] }],
    components: [{ id: "cEX", code: "EOT", name: "End of term" }],
    enrollments: [{ id: "e1", studentId: "s1", academicYearId: "y1", classId: "P7" }],
    marks: [
      { id: "m1", studentId: "s1", subjectId: "sub1", termId: "t1", componentId: "cEX", score: 80, type: "VALUE" },
      { id: "m2", studentId: "sX", subjectId: "sub1", termId: "t1", componentId: "cEX", score: 10, type: "VALUE" }, // invalid student ref
      { id: "m3", studentId: "s1", subjectId: "sub1", termId: "t1", componentId: "cEX", score: 90, type: "VALUE" }, // duplicate key
    ],
    feePayments: [{ id: "f1", studentId: "s1", amount: -500 }],
    teachers: [{ id: "tch1", fullName: "Mr. X" }],
    classes: [{ id: "P7", name: "Primary 7" }],
  };

  it("produces a dry-run report with duplicates and invalid references", () => {
    const { report } = parseSchoolData(schoolData);
    expect(report.counts.students).toBe(2);
    expect(report.counts.marks).toBe(3);
    expect(report.duplicateStudents).toHaveLength(1);
    expect(report.duplicateMarks).toHaveLength(1);
    expect(report.invalidReferences.some((r) => r.includes("sX"))).toBe(true);
    expect(report.errors.some((e) => e.includes("f1"))).toBe(true);
    expect(report.valid).toBe(false); // invalid payment blocked commit
  });

  it("clean data is valid", () => {
    const clean = { ...schoolData, students: [schoolData.students[0]], marks: [schoolData.marks[0]], feePayments: [{ id: "f1", studentId: "s1", amount: 500 }] };
    const { report } = parseSchoolData(clean);
    expect(report.valid).toBe(true);
    expect(report.duplicateStudents).toHaveLength(0);
    expect(report.invalidReferences).toHaveLength(0);
  });
});
