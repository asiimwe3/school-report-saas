import { describe, it, expect } from "vitest";
import { buildReportCard } from "../src/services/reports";
import type { ReportsRepo } from "../src/services/reports";
import { renderPrintHtml } from "../src/reports/render";
import { renderDocx } from "../src/reports/render";
import type { Ctx } from "../src/db/types";

const OWNER_CTX: Ctx = {
  userId: "u1",
  memberships: [{ schoolId: "sch1", role: "SCHOOL_OWNER", status: "ACTIVE" }],
  assignments: [], now: 0,
};
const BURSAR_CTX: Ctx = {
  userId: "u2",
  memberships: [{ schoolId: "sch1", role: "BURSAR", status: "ACTIVE" }],
  assignments: [], now: 0,
};

const REPO: ReportsRepo = {
  async getSchool(id) { return id === "sch1" ? { id, name: "Kyebi High School", motto: "Knowledge is Light" } : null; },
  async getStudent(schoolId, studentId) {
    return studentId === "stu1"
      ? { id: "stu1", firstName: "Grace", middleName: null, lastName: "Atuhaire", sex: "F", admissionNo: "S1034" }
      : null;
  },
  async getEnrollment() {
    return { classId: "c1", className: "Senior 4", level: "UCE", streamName: "East", rollNo: 7 };
  },
  async getTerm(schoolId, termId) {
    return termId === "t1"
      ? { id: "t1", name: "Term 3", year: "2026", endDate: new Date("2026-12-04"), nextTermBegins: new Date("2027-01-25") }
      : null;
  },
  async getSubjectResults() {
    return [
      { subject: "Mathematics", total: 78, percentage: 78, grade: "B", points: 3, remark: "Good" },
      { subject: "English", total: 64, percentage: 64, grade: "C", points: 5, remark: "Fair" },
      { subject: "Physics", total: null, percentage: null, grade: null, points: null, remark: null },
    ];
  },
  async getAttendance() { return { present: 88, absent: 4, total: 92 }; },
  async getComments() { return { classTeacher: "Hard working.", headTeacher: "Promote her." }; },
};

const INPUT = { schoolId: "sch1", studentId: "stu1", termId: "t1" };

describe("buildReportCard", () => {
  it("assembles a full report card from the repos", async () => {
    const d = await buildReportCard(OWNER_CTX, INPUT, REPO);
    expect(d.schoolName).toBe("Kyebi High School");
    expect(d.student.name).toBe("Grace Atuhaire");
    expect(d.student.className).toBe("Senior 4");
    expect(d.subjects.length).toBe(3);
    expect(d.summary.pointsTotal).toBe(8); // 3 + 5, null Physics excluded
    expect(d.summary.division).toBe("Aggregate 8"); // UCE level
    expect(d.attendance).toEqual({ present: 88, absent: 4, total: 92 });
    expect(d.comments.headTeacher).toBe("Promote her.");
  });

  it("renders a PLE division for a PLE-level class", async () => {
    const pleRepo: ReportsRepo = {
      ...REPO,
      async getEnrollment() { return { classId: "c1", className: "Primary 7", level: "PLE", streamName: null, rollNo: null }; },
    };
    const d = await buildReportCard(OWNER_CTX, INPUT, pleRepo);
    expect(d.summary.division).toBe("Division One"); // PLE: aggregate 4–12 ⇒ Div 1
  });

  it("blocks roles without reports:generate (bursar)", async () => {
    await expect(buildReportCard(BURSAR_CTX, INPUT, REPO)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects unknown students, terms and schools", async () => {
    await expect(buildReportCard(OWNER_CTX, { ...INPUT, studentId: "nope" }, REPO)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(buildReportCard(OWNER_CTX, { ...INPUT, termId: "nope" }, REPO)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A school outside the caller's memberships hits the tenant guard first.
    await expect(buildReportCard(OWNER_CTX, { ...INPUT, schoolId: "schX" }, REPO)).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });

  it("handles a student with no results at all", async () => {
    const empty: ReportsRepo = { ...REPO, async getSubjectResults() { return []; } };
    const d = await buildReportCard(OWNER_CTX, INPUT, empty);
    expect(d.subjects).toEqual([]);
    expect(d.summary.pointsTotal).toBeNull();
    expect(d.summary.division).toBeNull();
  });
});

describe("renderers", () => {
  it("print HTML is a valid document containing the student and subjects", async () => {
    const d = await buildReportCard(OWNER_CTX, INPUT, REPO);
    const html = renderPrintHtml(d);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Grace Atuhaire");
    expect(html).toContain("Mathematics");
    expect(html).toContain("Kyebi High School");
    expect(html).toContain("window.print()");
  });

  it("escapes user-controlled text in HTML", async () => {
    const evil: ReportsRepo = {
      ...REPO,
      async getStudent() {
        return { id: "stu1", firstName: "<script>", middleName: null, lastName: "X", sex: "F", admissionNo: "S1" };
      },
    };
    const d = await buildReportCard(OWNER_CTX, INPUT, evil);
    const html = renderPrintHtml(d);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("DOCX renders to a non-empty OpenXML buffer", async () => {
    const d = await buildReportCard(OWNER_CTX, INPUT, REPO);
    const buf = await renderDocx(d);
    expect(buf.length).toBeGreaterThan(2000);
    // DOCX = ZIP: magic bytes PK
    expect(buf.subarray(0, 2).toString()).toBe("PK");
  });
});
