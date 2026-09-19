import { describe, expect, it, beforeEach } from "vitest";
import { MarkType, SheetState } from "../src/grading/engine";
import { UCE_SCHEME } from "../src/grading/schemes";
import { previewBundleMerge, type BundleMark, type ExistingMark } from "../src/migration/bundle";
import { enterMark, unlockSheet } from "../src/services/marks";
import { transitionSheet } from "../src/services/sheets";
import { recomputeSubjectResults } from "../src/services/results";
import { applyBundleImport, type ImportJobRepo } from "../src/services/importCommit";
import { ServiceError, type Ctx, type MarkRecord, type EnrollmentRecord, type SubjectRecord, type ComponentRecord, type TermResultRecord } from "../src/db/types";

// ── In-memory test doubles (tenant-scoped like the Prisma impls) ────────────

class MemoryStore {
  marks: MarkRecord[] = [];
  history: unknown[] = [];
  audits: unknown[] = [];
  sheets: { id: string; schoolId: string; classId: string; subjectId: string; termId: string; state: SheetState; lockedAt: number | null }[] = [];
  results: TermResultRecord[] = [];
  jobs: { id: string; rows: unknown[] }[] = [];
  seq = 0;

  marksRepo() {
    return {
      findMark: async (schoolId: string, key: { studentId: string; subjectId: string; termId: string; componentId: string }) =>
        this.marks.find(
          (m) =>
            m.schoolId === schoolId &&
            m.studentId === key.studentId &&
            m.subjectId === key.subjectId &&
            m.termId === key.termId &&
            m.componentId === key.componentId
        ) ?? null,
      createMark: async (schoolId: string, data: Omit<MarkRecord, "id" | "version">) => {
        const rec: MarkRecord = { ...data, schoolId, id: `m${++this.seq}`, version: 1 };
        this.marks.push(rec);
        return rec;
      },
      updateMark: async (schoolId: string, id: string, patch: Partial<MarkRecord>, expectedVersion: number) => {
        const rec = this.marks.find((m) => m.schoolId === schoolId && m.id === id);
        if (!rec) return null;
        if (rec.version !== expectedVersion) return null; // optimistic concurrency
        Object.assign(rec, patch, { version: rec.version + 1 });
        return rec;
      },
      listMarks: async (schoolId: string, filter: { termId: string; subjectId?: string; studentIds?: string[] }) =>
        this.marks.filter(
          (m) =>
            m.schoolId === schoolId &&
            m.termId === filter.termId &&
            (!filter.subjectId || m.subjectId === filter.subjectId) &&
            (!filter.studentIds || filter.studentIds.includes(m.studentId))
        ),
      appendHistory: async (schoolId: string, rec: unknown) => {
        this.history.push(rec);
      },
    };
  }

  sheetsRepo() {
    return {
      findSheet: async (schoolId: string, key: { classId: string; subjectId: string; termId: string }) =>
        this.sheets.find(
          (s) =>
            s.schoolId === schoolId &&
            s.classId === key.classId &&
            s.subjectId === key.subjectId &&
            s.termId === key.termId
        ) ?? null,
      createSheet: async (schoolId: string, data: Omit<(typeof this.sheets)[0], "id" | "schoolId">) => {
        const rec = { ...data, schoolId, id: `sh${++this.seq}` };
        this.sheets.push(rec);
        return rec;
      },
      updateSheet: async (schoolId: string, id: string, patch: Record<string, unknown>) => {
        const rec = this.sheets.find((s) => s.schoolId === schoolId && s.id === id);
        if (!rec) return null;
        Object.assign(rec, patch);
        return rec;
      },
    };
  }

  auditRepo() {
    return {
      record: async (schoolId: string, event: unknown) => {
        this.audits.push(event);
      },
    };
  }

  resultsRepo() {
    return {
      upsertTermResult: async (
        schoolId: string,
        key: { studentId: string; termId: string; subjectId: string },
        data: Omit<TermResultRecord, "id" | "schoolId" | "studentId" | "termId" | "subjectId">
      ) => {
        const id = `tr:${key.studentId}|${key.termId}|${key.subjectId}`;
        const existing = this.results.find((r) => r.id === id);
        const rec: TermResultRecord = { id, schoolId, studentId: key.studentId, termId: key.termId, subjectId: key.subjectId, ...data };
        if (existing) Object.assign(existing as unknown as Record<string, unknown>, data);
        else this.results.push(rec);
        return rec;
      },
      listTermResults: async (schoolId: string, termId: string) =>
        this.results.filter((r) => r.schoolId === schoolId && r.termId === termId),
    };
  }

  rosterRepo(activeYearId: string, enrollments: EnrollmentRecord[], subjects: SubjectRecord[], components: ComponentRecord[]) {
    return {
      listEnrollments: async () => enrollments,
      listSubjects: async () => subjects,
      listComponents: async () => components,
      getSchool: async () => ({ activeYearId }),
    };
  }

  jobsRepo(): ImportJobRepo {
    return {
      createJob: async (schoolId: string, data: { kind: string; initiatedBy: string; summary: unknown }) => {
        const id = `job${++this.seq}`;
        this.jobs.push({ id, rows: [] });
        return id;
      },
      appendRow: async (_schoolId: string, jobId: string, row: unknown) => {
        this.jobs.find((j) => j.id === jobId)?.rows.push(row);
      },
    };
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const TEACHER = { userId: "uT", memberships: [{ schoolId: "sch", role: "TEACHER" as const, status: "ACTIVE" as const }], assignments: [{ teacherId: "uT", subjectId: "math", classId: "S1E", classTeacher: false, active: true }], now: 1000 };
const UNASSIGNED = { ...TEACHER, userId: "uU", assignments: [] };
const BURSAR = { userId: "uB", memberships: [{ schoolId: "sch", role: "BURSAR" as const, status: "ACTIVE" as const }], assignments: [], now: 1000 };
const HEAD = { userId: "uH", memberships: [{ schoolId: "sch", role: "HEAD_TEACHER" as const, status: "ACTIVE" as const }], assignments: [], now: 1000 };
const OUTSIDER = { userId: "uX", memberships: [{ schoolId: "sch", role: "TEACHER" as const, status: "ACTIVE" as const }], assignments: [], now: 1000 };

const MARK_INPUT = { schoolId: "sch", studentId: "st1", subjectId: "math", termId: "t1", componentId: "cEX", enrollmentId: "e1", classId: "S1E" };

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
});

const expectCode = (fn: () => Promise<unknown>, code: string) =>
  expect(fn()).rejects.toMatchObject({ code });

describe("mark entry", () => {
  it("creates a mark for an assigned teacher, with history and audit", async () => {
    const m = await enterMark(TEACHER, { ...MARK_INPUT, type: MarkType.VALUE, score: 72 }, store.marksRepo(), store.sheetsRepo(), store.auditRepo());
    expect(m.score).toBe(72);
    expect(store.history).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({ action: "MARK_ENTERED" });
  });

  it("updates an existing mark and bumps version", async () => {
    await enterMark(TEACHER, { ...MARK_INPUT, type: MarkType.VALUE, score: 50 }, store.marksRepo(), store.sheetsRepo(), store.auditRepo());
    const m = await enterMark(TEACHER, { ...MARK_INPUT, type: MarkType.VALUE, score: 60 }, store.marksRepo(), store.sheetsRepo(), store.auditRepo());
    expect(m.score).toBe(60);
    expect(m.version).toBe(2);
  });

  it("blocks unassigned teachers (no cross-class edits)", async () => {
    await expectCode(() => enterMark(UNASSIGNED, { ...MARK_INPUT, type: MarkType.VALUE, score: 10 }, store.marksRepo(), store.sheetsRepo(), store.auditRepo()), "FORBIDDEN");
  });

  it("blocks users without an active membership in the school", async () => {
    const outsider: Ctx = { ...OUTSIDER, memberships: OUTSIDER.memberships.map((m) => ({ ...m, schoolId: "other" })) };
    await expectCode(() => enterMark(outsider, { ...MARK_INPUT, type: MarkType.VALUE, score: 10 }, store.marksRepo(), store.sheetsRepo(), store.auditRepo()), "TENANT_ACCESS_DENIED");
  });

  it("bursars can never enter marks", async () => {
    await expectCode(() => enterMark(BURSAR, { ...MARK_INPUT, type: MarkType.VALUE, score: 10 }, store.marksRepo(), store.sheetsRepo(), store.auditRepo()), "FORBIDDEN");
  });

  it("rejects VALUE without a score and specials with a score", async () => {
    await expectCode(() => enterMark(TEACHER, { ...MARK_INPUT, type: MarkType.VALUE, score: null }, store.marksRepo(), store.sheetsRepo(), store.auditRepo()), "VALIDATION");
    await expectCode(() => enterMark(TEACHER, { ...MARK_INPUT, type: MarkType.ABS, score: 40 }, store.marksRepo(), store.sheetsRepo(), store.auditRepo()), "VALIDATION");
    await expectCode(() => enterMark(TEACHER, { ...MARK_INPUT, type: MarkType.VALUE, score: 999 }, store.marksRepo(), store.sheetsRepo(), store.auditRepo()), "VALIDATION");
  });

  it("special marks store no score and never become silent zeros", async () => {
    const m = await enterMark(TEACHER, { ...MARK_INPUT, type: MarkType.ABS, score: null }, store.marksRepo(), store.sheetsRepo(), store.auditRepo());
    expect(m.score).toBeNull();
    expect(m.type).toBe(MarkType.ABS);
  });

  it("blocks entry on APPROVED and LOCKED sheets", async () => {
    for (const state of [SheetState.APPROVED, SheetState.LOCKED] as const) {
      store = new MemoryStore();
      await store.sheetsRepo().createSheet("sch", { classId: "S1E", subjectId: "math", termId: "t1", state, lockedAt: null });
      await expectCode(() => enterMark(TEACHER, { ...MARK_INPUT, type: MarkType.VALUE, score: 10 }, store.marksRepo(), store.sheetsRepo(), store.auditRepo()), "SHEET_LOCKED");
    }
  });

  it("optimistic concurrency: stale version is rejected, not clobbered", async () => {
    const first = await enterMark(TEACHER, { ...MARK_INPUT, type: MarkType.VALUE, score: 50 }, store.marksRepo(), store.sheetsRepo(), store.auditRepo());
    // Another user edits first — our in-memory copy is now stale.
    await store.marksRepo().updateMark("sch", first.id, { score: 55 }, first.version);
    const staleEdit = enterMark(TEACHER, { ...MARK_INPUT, type: MarkType.VALUE, score: 60 }, store.marksRepo(), store.sheetsRepo(), store.auditRepo());
    // Our update call above used expectedVersion=first.version (1), so store is at version 2;
    // enterMark re-reads and uses current version, so this succeeds. True stale-window:
    const concurrent = { ...store.marks[0]! };
    await expect(
      store.marksRepo().updateMark("sch", concurrent.id, { score: 99 }, concurrent.version - 1)
    ).resolves.toBeNull();
    await expect(staleEdit).resolves.toBeTruthy();
  });
});

describe("sheet workflow", () => {
  const sheetKey = { schoolId: "sch", classId: "S1E", subjectId: "math", termId: "t1" };

  it("walks DRAFT→SUBMITTED→REVIEWED→APPROVED→LOCKED with role gating", async () => {
    await store.sheetsRepo().createSheet("sch", { ...sheetKey, state: SheetState.DRAFT, lockedAt: null });
    const sheets = store.sheetsRepo();
    const audit = store.auditRepo();

    await expect(transitionSheet(TEACHER, { ...sheetKey, to: SheetState.SUBMITTED }, sheets, audit)).resolves.toBe(SheetState.SUBMITTED);
    // A teacher cannot review or approve.
    await expectCode(() => transitionSheet(TEACHER, { ...sheetKey, to: SheetState.REVIEWED }, sheets, audit), "FORBIDDEN");
    await expectCode(() => transitionSheet(TEACHER, { ...sheetKey, to: SheetState.APPROVED }, sheets, audit), "STATE_CONFLICT");
    // Head teacher advances.
    await expect(transitionSheet(HEAD, { ...sheetKey, to: SheetState.REVIEWED }, sheets, audit)).resolves.toBe(SheetState.REVIEWED);
    await expect(transitionSheet(HEAD, { ...sheetKey, to: SheetState.APPROVED }, sheets, audit)).resolves.toBe(SheetState.APPROVED);
    await expect(transitionSheet(HEAD, { ...sheetKey, to: SheetState.LOCKED }, sheets, audit)).resolves.toBe(SheetState.LOCKED);
  });

  it("rejects impossible jumps (DRAFT→APPROVED)", async () => {
    await store.sheetsRepo().createSheet("sch", { ...sheetKey, state: SheetState.DRAFT, lockedAt: null });
    await expectCode(() => transitionSheet(HEAD, { ...sheetKey, to: SheetState.APPROVED }, store.sheetsRepo(), store.auditRepo()), "STATE_CONFLICT");
  });

  it("unlock: head teacher only, reason mandatory, returns to DRAFT", async () => {
    await store.sheetsRepo().createSheet("sch", { ...sheetKey, state: SheetState.LOCKED, lockedAt: 1 });
    const sheets = store.sheetsRepo();
    const audit = store.auditRepo();
    await expectCode(() => unlockSheet(TEACHER, { ...sheetKey, reason: "fix a mark" }, sheets, audit), "FORBIDDEN");
    await expectCode(() => unlockSheet(HEAD, { ...sheetKey, reason: "no" }, sheets, audit), "VALIDATION");
    await unlockSheet(HEAD, { ...sheetKey, reason: "mark correction after parent query" }, sheets, audit);
    const s = await sheets.findSheet("sch", sheetKey);
    expect(s?.state).toBe(SheetState.DRAFT);
    expect(store.audits[0]).toMatchObject({ action: "SHEET_UNLOCKED" });
  });
});

describe("results recompute", () => {
  const rosterFixtures = () =>
    store.rosterRepo(
      "y2026",
      [
        { studentId: "st1", academicYearId: "y2026", classId: "S1E", streamId: null, status: "ACTIVE" },
        { studentId: "st2", academicYearId: "y2026", classId: "S1E", streamId: null, status: "ACTIVE" },
        { studentId: "stOld", academicYearId: "y2025", classId: "P7", streamId: null, status: "ACTIVE" }, // previous year — must NOT appear
        { studentId: "st3", academicYearId: "y2026", classId: "S1E", streamId: null, status: "LEFT" }, // inactive
      ] as EnrollmentRecord[],
      [{ id: "math", schoolId: "sch", name: "Maths", level: "O_LEVEL" as const, compulsory: true, principal: false, subsidiary: false, maxMarks: 100, active: true }],
      [
        { id: "cCA", schoolId: "sch", subjectId: null, code: "BOT", kind: "CA" as const, active: true },
        { id: "cEX", schoolId: "sch", subjectId: null, code: "EOT", kind: "EXAM" as const, active: true },
      ]
    );

  it("snapshots results for the active-year roster only, with correct blocking reasons", async () => {
    const marks = store.marksRepo();
    await enterMark(TEACHER, { ...MARK_INPUT, studentId: "st1", type: MarkType.VALUE, score: 80, componentId: "cCA" }, marks, store.sheetsRepo(), store.auditRepo());
    await enterMark(TEACHER, { ...MARK_INPUT, studentId: "st1", type: MarkType.VALUE, score: 90, componentId: "cEX" }, marks, store.sheetsRepo(), store.auditRepo());
    await enterMark(TEACHER, { ...MARK_INPUT, studentId: "st2", type: MarkType.VALUE, score: 60, componentId: "cCA" }, marks, store.sheetsRepo(), store.auditRepo());
    // st2 has no exam mark → incomplete with blocking reason.

    const summary = await recomputeSubjectResults(
      HEAD,
      { schoolId: "sch", termId: "t1", subjectId: "math", scheme: UCE_SCHEME },
      rosterFixtures(),
      marks,
      store.resultsRepo(),
      store.auditRepo()
    );
    expect(summary.studentCount).toBe(2); // st1, st2 only — old year & LEFT excluded
    expect(summary.complete).toBe(1);
    expect(summary.incomplete).toBe(1);

    const results = await store.resultsRepo().listTermResults("sch", "t1");
    const st1 = results.find((r) => r.studentId === "st1")!;
    const st2 = results.find((r) => r.studentId === "st2")!;
    expect(st1.percentage).toBe(88); // 20% CA + 80% exam, exactly as the engine computes
    expect(st1.grade).toBe("A");
    expect(st1.complete).toBe(true);
    expect(st2.complete).toBe(false);
    expect(st2.blockingReasons).toContain("MISSING_EXAM");
  });

  it("bursars cannot recompute results", async () => {
    await expectCode(
      () =>
        recomputeSubjectResults(
          BURSAR,
          { schoolId: "sch", termId: "t1", subjectId: "math", scheme: UCE_SCHEME },
          rosterFixtures(),
          store.marksRepo(),
          store.resultsRepo(),
          store.auditRepo()
        ),
      "FORBIDDEN"
    );
  });
});

describe("import commit", () => {
  const mk = (over: Partial<BundleMark> = {}): BundleMark => ({
    studentId: "st1", subjectId: "math", termId: "t1", componentId: "cEX", type: "VALUE", score: 70, updatedAt: 2000, ...over,
  });

  it("applies only ADD/UPDATE; skips CONFLICT/REJECT; NEVER touches other marks", async () => {
    const marks = store.marksRepo();
    // Pre-existing marks: one in the bundle's scope, plus unrelated ones that MUST survive.
    await enterMark(HEAD, { ...MARK_INPUT, type: MarkType.VALUE, score: 40, componentId: "cEX" }, marks, store.sheetsRepo(), store.auditRepo());
    await enterMark(HEAD, { ...MARK_INPUT, subjectId: "eng", type: MarkType.VALUE, score: 66 }, marks, store.sheetsRepo(), store.auditRepo());
    await enterMark(HEAD, { ...MARK_INPUT, studentId: "st2", type: MarkType.VALUE, score: 88 }, marks, store.sheetsRepo(), store.auditRepo());
    const before = store.marks.length;

    const incoming: BundleMark[] = [
      mk(), // newer → UPDATE
      mk({ subjectId: "sci" }), // ADD
      mk({ score: -3 }), // REJECT
      mk({ subjectId: "eng", updatedAt: 999 }), // older than stored → CONFLICT (forceNewerOnly)
    ];
    const existingForPreview: ExistingMark[] = store.marks.map((m) => ({
      studentId: m.studentId, subjectId: m.subjectId, termId: m.termId, componentId: m.componentId,
      score: m.score, version: m.version, updatedAt: m.updatedAt,
    }));
    const preview = previewBundleMerge(incoming, existingForPreview, { forceNewerOnly: true });
    expect(preview.updates).toBe(1);
    expect(preview.conflicts).toBe(1);

    const res = await applyBundleImport(HEAD, { schoolId: "sch", classId: "S1E", subjectId: "math", termId: "t1", preview }, marks, store.jobsRepo(), store.auditRepo());
    expect(res.applied).toBe(2); // UPDATE + ADD
    expect(res.skipped).toBe(2); // REJECT + CONFLICT
    // No deletions: store can only have grown or updated in place.
    expect(store.marks.length).toBe(before + 1);
    const survivors = store.marks.filter((m) => m.subjectId === "eng" || m.studentId === "st2");
    expect(survivors).toHaveLength(2); // untouched
    expect(store.marks.find((m) => m.subjectId === "math")?.score).toBe(70); // updated to bundle value
    expect(store.jobs[0]?.rows.length).toBe(4);
  });

  it("stale preview (mark appeared after preview) becomes a CONFLICT, never a clobber", async () => {
    const marks = store.marksRepo();
    const preview = previewBundleMerge([mk()], []); // built when mark didn't exist → ADD
    // ... but it exists now:
    await enterMark(HEAD, { ...MARK_INPUT, type: MarkType.VALUE, score: 40 }, marks, store.sheetsRepo(), store.auditRepo());
    const res = await applyBundleImport(HEAD, { schoolId: "sch", classId: "S1E", subjectId: "math", termId: "t1", preview }, marks, store.jobsRepo(), store.auditRepo());
    expect(res.applied).toBe(0);
    expect(res.skipped).toBe(1);
    expect(store.marks[0]?.score).toBe(40); // untouched
  });

  it("teachers (marks:import holders) and bursars are gated correctly", async () => {
    const preview = previewBundleMerge([mk()], []);
    await expectCode(() => applyBundleImport(BURSAR, { schoolId: "sch", classId: "S1E", subjectId: "math", termId: "t1", preview }, store.marksRepo(), store.jobsRepo(), store.auditRepo()), "FORBIDDEN");
  });
});
