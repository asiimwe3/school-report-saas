import { describe, expect, it } from "vitest";
import {
  MarkType,
  boundaryFor,
  computeSubject,
  computeTermResult,
  rank,
  rosterFor,
  uceResultIndicator,
  type SubjectInput,
} from "../src/grading/engine";
import { PLE_SCHEME, UCE_SCHEME, UACE_SCHEME } from "../src/grading/schemes";

const subj = (over: Partial<SubjectInput> = {}): SubjectInput => ({
  subjectId: "s1",
  name: "Mathematics",
  compulsory: true,
  principal: false,
  subsidiary: false,
  maxMarks: 100,
  marks: [],
  ...over,
});

const mark = (score: number, kind: "CA" | "EXAM" = "EXAM", max = 100) => ({
  componentId: kind === "CA" ? "cCA" : "cEX",
  componentCode: kind,
  componentKind: kind,
  type: MarkType.VALUE,
  score,
  maxScore: max,
});

const special = (type: MarkType, kind: "CA" | "EXAM" = "EXAM") => ({
  componentId: kind === "CA" ? "cCA" : "cEX",
  componentCode: kind,
  componentKind: kind,
  type,
  score: null,
  maxScore: 100,
});

describe("boundary lookup", () => {
  it("hits exact boundaries", () => {
    expect(boundaryFor(PLE_SCHEME, 90)?.grade).toBe("1");
    expect(boundaryFor(PLE_SCHEME, 0)?.grade).toBe("9");
    expect(boundaryFor(PLE_SCHEME, 100)?.grade).toBe("1");
  });

  it("handles decimal values between ranges by clamping to the boundary below", () => {
    // 89.4 falls between the 80–89 and 90–100 ranges → clamps to grade 2.
    expect(boundaryFor(PLE_SCHEME, 89.4)?.grade).toBe("2");
    expect(boundaryFor(UCE_SCHEME, 79.5)?.grade).toBe("B");
  });

  it("handles values below the lowest boundary", () => {
    expect(boundaryFor(PLE_SCHEME, -5)?.grade).toBe("9");
  });
});

describe("PLE subject + aggregate", () => {
  it("computes best-4 aggregate and division from the table", () => {
    const subjects: SubjectInput[] = [
      subj({ subjectId: "a", marks: [mark(95)], name: "Eng" }),
      subj({ subjectId: "b", marks: [mark(85)], name: "Math" }),
      subj({ subjectId: "c", marks: [mark(75)], name: "Sci" }),
      subj({ subjectId: "d", marks: [mark(65)], name: "SST" }),
      subj({ subjectId: "e", marks: [mark(55)], name: "Rel" }), // 5th subject must NOT count
    ];
    const res = computeTermResult(PLE_SCHEME, subjects);
    expect(res.complete).toBe(true);
    expect(res.aggregate?.aggregate).toBe(1 + 2 + 3 + 4); // best four, excludes 5
    expect(res.aggregate?.division).toBe("Division 2");
    expect(res.aggregate?.basedOnSubjects).not.toContain("e");
  });

  it("a 4-aggregate is Division 1 (boundary value)", () => {
    const subjects: SubjectInput[] = [1, 1, 1, 1].map((_, i) =>
      subj({ subjectId: `x${i}`, marks: [mark(95)], name: `S${i}` })
    );
    expect(computeTermResult(PLE_SCHEME, subjects).aggregate?.division).toBe("Division 1");
  });

  it("aggregate 12 → Division 2; aggregate 13 → Division 3 (table boundary)", () => {
    const mk = (pts: number[]) =>
      pts.map((p, i) => subj({ subjectId: `y${i}`, marks: [mark(100 - p * 10)], name: `S${i}` }));
    expect(computeTermResult(PLE_SCHEME, mk([3, 3, 3, 3])).aggregate?.division).toBe("Division 2");
    expect(computeTermResult(PLE_SCHEME, mk([3, 3, 3, 4])).aggregate?.division).toBe("Division 3");
  });

  it("incomplete subjects are excluded from the aggregate pool", () => {
    const subjects: SubjectInput[] = [
      subj({ subjectId: "a", marks: [mark(95)], name: "Eng" }),
      subj({ subjectId: "b", marks: [mark(85)], name: "Math" }),
      subj({ subjectId: "c", marks: [mark(75)], name: "Sci" }),
      subj({ subjectId: "d", marks: [special(MarkType.MISSING)], name: "SST" }), // MISSING ≠ zero
    ];
    const res = computeTermResult(PLE_SCHEME, subjects);
    expect(res.subjects.find((s) => s.subjectId === "d")?.complete).toBe(false);
    expect(res.subjects.find((s) => s.subjectId === "d")?.percentage).toBeNull();
    // Aggregate still computes over the 3 complete subjects, and is reported incomplete.
    expect(res.complete).toBe(false);
    expect(res.aggregate?.basedOnSubjects).toHaveLength(3);
  });
});

describe("UCE weighted grading", () => {
  it("applies 20% CA + 80% exam", () => {
    // CA 80/100, Exam 90/100 → 0.2*80 + 0.8*90 = 88 → grade A
    const s = computeSubject(UCE_SCHEME, subj({ marks: [mark(80, "CA"), mark(90, "EXAM")] }));
    expect(s.percentage).toBe(88);
    expect(s.grade).toBe("A");
  });

  it("missing CA or exam makes the subject incomplete, never zero", () => {
    const s = computeSubject(UCE_SCHEME, subj({ marks: [mark(90, "EXAM")] }));
    expect(s.complete).toBe(false);
    expect(s.percentage).toBeNull();
    expect(s.blockingReasons).toContain("MISSING_CA");
  });

  it("ABS/EXEMPT/NA never silently become zero", () => {
    const s = computeSubject(UCE_SCHEME, subj({ marks: [mark(50, "CA"), special(MarkType.ABS)] }));
    expect(s.complete).toBe(false);
    expect(s.percentage).toBeNull();
  });

  it("Result 1/2/3 indicator (ported rule)", () => {
    expect(uceResultIndicator(false, true)).toBe("Result 2");
    expect(uceResultIndicator(true, false)).toBe("Result 3");
    expect(uceResultIndicator(false, false)).toBe("Result 1");
  });

  it("compulsory gating: incomplete compulsory subject forces Result 2", () => {
    const subjects: SubjectInput[] = [
      subj({ subjectId: "eng", name: "English", marks: [mark(90, "CA"), mark(85, "EXAM")], compulsory: true }),
      subj({ subjectId: "math", name: "Maths", marks: [mark(70, "CA"), mark(65, "EXAM")], compulsory: true }),
      subj({ subjectId: "art", name: "Art", marks: [mark(90, "EXAM")], compulsory: false }), // incomplete but optional
    ];
    const res = computeTermResult(UCE_SCHEME, subjects);
    expect(res.aggregate?.resultIndicator).toBe("Result 1");
    const withMissingCompulsory = [
      ...subjects.slice(0, 2),
      subj({ subjectId: "math", name: "Maths", marks: [mark(70, "CA")], compulsory: true }), // missing exam
    ];
    const res2 = computeTermResult(UCE_SCHEME, withMissingCompulsory);
    expect(res2.aggregate?.resultIndicator).toBe("Result 2");
  });

  it("all-E compulsory subjects yield Result 3", () => {
    const subjects: SubjectInput[] = [
      subj({ subjectId: "eng", name: "English", marks: [mark(40, "CA"), mark(30, "EXAM")] }), // 32 → E
      subj({ subjectId: "math", name: "Maths", marks: [mark(20, "CA"), mark(45, "EXAM")] }), // 40 → E
    ];
    expect(computeTermResult(UCE_SCHEME, subjects).aggregate?.resultIndicator).toBe("Result 3");
  });
});

describe("UACE principals and subsidiaries", () => {
  const pcm = (
    principals: number[],
    subsidiaries: number[] = []
  ): SubjectInput[] => {
    const mk = (pct: number) => [mark(pct)];
    const list: SubjectInput[] = principals.map((p, i) =>
      subj({ subjectId: `p${i}`, name: `Principal ${i}`, principal: true, compulsory: false, marks: mk(p) })
    );
    subsidiaries.forEach((p, i) =>
      list.push(
        subj({ subjectId: `sub${i}`, name: `Subsidiary ${i}`, subsidiary: true, principal: false, compulsory: false, marks: mk(p) })
      )
    );
    return list;
  };

  it("sums only the best 3 principal subject points (A=1…E=5, lower is better)", () => {
    // A(1) + B(2) + C(3) = 6; the fourth principal (D=4) must NOT be added.
    const res = computeTermResult(UACE_SCHEME, pcm([85, 75, 65, 55]));
    expect(res.subjects.filter((s) => s.principal)).toHaveLength(4);
    expect(res.aggregate?.points).toBe(6);
    expect(res.aggregate?.basedOnSubjects).not.toContain("p3");
  });

  it("subsidiary adds a point only when above the threshold grade", () => {
    const withPass = computeTermResult(UACE_SCHEME, pcm([85, 75, 65], [50])); // subsidiary D → passes
    const withFail = computeTermResult(UACE_SCHEME, pcm([85, 75, 65], [10])); // subsidiary F → no point
    const base = computeTermResult(UACE_SCHEME, pcm([85, 75, 65]));

    const passPts = withPass.aggregate?.points ?? 0;
    const failPts = withFail.aggregate?.points ?? 0;
    const basePts = base.aggregate?.points ?? 0;
    expect(passPts).toBe(basePts + 1);
    expect(failPts).toBe(basePts); // F subsidiary adds nothing
  });

  it("a subsidiary can NEVER substitute a missing principal subject", () => {
    const twoPrincipals = pcm([85, 75], [60, 55]); // only 2 principals + 2 passing subsidiaries
    const res = computeTermResult(UACE_SCHEME, twoPrincipals);
    expect(res.aggregate?.aggregate).toBeNull(); // needs 3 principals; subsidiaries don't fill the gap
  });
});

describe("ranking (competition: 1, 2, 2, 4)", () => {
  it("ties share a position and skip the next", () => {
    const rows = [
      { studentId: "a", key: 4 },
      { studentId: "b", key: 6 },
      { studentId: "c", key: 6 },
      { studentId: "d", key: 9 },
    ];
    const ranked = rank(rows);
    expect(ranked.find((r) => r.studentId === "a")?.position).toBe(1);
    expect(ranked.find((r) => r.studentId === "b")?.position).toBe(2);
    expect(ranked.find((r) => r.studentId === "c")?.position).toBe(2);
    expect(ranked.find((r) => r.studentId === "d")?.position).toBe(4);
  });

  it("incomplete students are unranked by default, ranked when school enables it", () => {
    const rows = [
      { studentId: "a", key: 4 },
      { studentId: "b", key: null },
    ];
    expect(rank(rows).find((r) => r.studentId === "b")?.position).toBeNull();
  });

  it("computes stream positions within each stream", () => {
    const rows = [
      { studentId: "a", key: 4, streamId: "east" },
      { studentId: "b", key: 5, streamId: "east" },
      { studentId: "c", key: 3, streamId: "west" },
    ];
    const ranked = rank(rows);
    expect(ranked.find((r) => r.studentId === "a")?.streamPosition).toBe(1);
    expect(ranked.find((r) => r.studentId === "c")?.streamPosition).toBe(1);
  });
});

describe("academic-year roster scoping", () => {
  it("previous-year enrollments never leak into the current roster", () => {
    const enrollments = [
      { studentId: "s1", academicYearId: "2025", classId: "P7", status: "ACTIVE" },
      { studentId: "s1", academicYearId: "2026", classId: "S1", status: "ACTIVE" },
      { studentId: "s2", academicYearId: "2025", classId: "P7", status: "ACTIVE" }, // left behind
      { studentId: "s3", academicYearId: "2026", classId: "S1", status: "ACTIVE" },
      { studentId: "s4", academicYearId: "2026", classId: "S1", status: "LEFT" }, // not active
    ];
    expect(rosterFor(enrollments, "2026")).toEqual(["s1", "s3"]);
    expect(rosterFor(enrollments, "2026", "S1")).toEqual(["s1", "s3"]);
    expect(rosterFor(enrollments, "2025")).toEqual(["s1", "s2"]);
  });
});
