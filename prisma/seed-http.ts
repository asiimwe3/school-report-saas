/**
 * HTTP variant of prisma/seed.ts for environments where Postgres TCP (5432)
 * is blocked — executes the same demo data over Neon's HTTPS SQL proxy.
 * seed.ts remains the canonical script for normal environments.
 * Usage: DATABASE_URL=<pooled-url> DEMO_SEED_ALLOWED=1 npx tsx prisma/seed-http.ts [--reset]
 */
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { hashPassword } from "../src/auth/passwords";
import { computeSubject, SubjectInput, ComponentMark } from "../src/grading/engine";
import { PLE_SCHEME, UCE_SCHEME, UACE_SCHEME } from "../src/grading/schemes";

const q = neon(process.env.DATABASE_URL!);
const reset = process.argv.includes("--reset");
const DEMO_SCHOOL_NAME = "DeryCode Demo Secondary School";

let seedState = 42;
const rnd = () => ((seedState = (seedState * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

let COLS: Record<string, Set<string>> = {};
async function loadCols() {
  const r = (await q.query(`SELECT "table_name","column_name" FROM information_schema.columns WHERE table_schema='public'`)) as any;
  for (const row of r.rows ?? r) {
    (COLS[row.table_name] ??= new Set()).add(row.column_name);
  }
}
async function ins(table: string, cols: string[], vals: unknown[]): Promise<string> {
  const id = randomUUID();
  const ph = cols.map((_, i) => `$${i + 2}`).join(",");
  const extra: string[] = [], extraV: string[] = [];
  if (COLS[table]?.has("createdAt")) { extra.push(`"createdAt"`); extraV.push("CURRENT_TIMESTAMP"); }
  if (COLS[table]?.has("updatedAt")) { extra.push(`"updatedAt"`); extraV.push("CURRENT_TIMESTAMP"); }
  const extraSql = extra.length ? `,${extra.join(",")}` : "";
  const extraVals = extraV.length ? `,${extraV.join(",")}` : "";
  const sql = `INSERT INTO "${table}" ("id",${cols.map((c) => `"${c}"`).join(",")}${extraSql}) VALUES ($1,${ph}${extraVals}) RETURNING "id"`;
  const r = (await q.query(sql, [id, ...vals])) as any;
  return r.rows?.[0]?.id ?? id;
}

const FIRST_M = ["Emmanuel","Isaac","Joseph","Ronald","Patrick","Timothy","Julius","Moses","Eric","Denis","Collin","Felix"];
const FIRST_F = ["Grace","Sarah","Joan","Esther","Brenda","Patricia","Alice","Vanessa","Doreen","Millicent","Sharon","Irene"];
const LAST = ["Atuhaire","Mugisha","Tumwesigye","Nabukenya","Kyomuhendo","Asiimwe","Byaruhanga","Ainemukama","Tushabe","Natukunda","Kabagambe","Rukundo"];

const USERS = [
  { email: "owner@demo.derycode.online", fullName: "Demo Owner", role: "SCHOOL_OWNER" },
  { email: "head@demo.derycode.online", fullName: "Demo Head Teacher", role: "HEAD_TEACHER" },
  { email: "admin@demo.derycode.online", fullName: "Demo Administrator", role: "SCHOOL_ADMIN" },
  { email: "teacher@demo.derycode.online", fullName: "Demo Teacher", role: "TEACHER" },
  { email: "bursar@demo.derycode.online", fullName: "Demo Bursar", role: "BURSAR" },
  { email: "data@demo.derycode.online", fullName: "Demo Data Entry", role: "DATA_ENTRY" },
];

const CLASSES = [
  { name: "Primary 7", level: "PRIMARY", scheme: PLE_SCHEME, isA: false, isO: false, subjects: ["Mathematics","English","Integrated Science","Social Studies"] },
  { name: "Senior 4", level: "O_LEVEL", scheme: UCE_SCHEME, isA: false, isO: true, subjects: ["Mathematics","English","Physics","Chemistry","Biology","History"] },
  { name: "Senior 6", level: "A_LEVEL", scheme: UACE_SCHEME, isA: true, isO: false, subjects: ["General Paper","Mathematics","Physics","Economics"] },
];

async function main() {
  if (process.env.DEMO_SEED_ALLOWED !== "1") throw new Error("Refusing to seed: set DEMO_SEED_ALLOWED=1 (dev/staging only).");

  const existing = (await q.query(`SELECT "id" FROM "School" WHERE "name"=$1`, [DEMO_SCHOOL_NAME])) as any;
  const ex = existing.rows ?? existing;
  if (ex.length && !reset) { console.log("Demo school already exists — use --reset to reseed."); return; }
  if (ex.length) {
    console.log("Resetting demo school…");
    await q.query(`DELETE FROM "School" WHERE "id"=$1`, [ex[0].id]);
  }
  // demo users persist across schools (multi-tenant model) — remove them on reset
  await q.query(`DELETE FROM "User" WHERE "email" LIKE '%@demo.derycode.online'`);

  await loadCols();
  console.log("Creating demo school…");
  const school = await ins("School", ["name", "shortName", "district"], [DEMO_SCHOOL_NAME, "Knowledge is Light", "Kyenjojo"]);

  const users: Record<string, string> = {};
  for (const u of USERS) {
    const uid = await ins("User", ["email", "fullName", "passwordHash"], [u.email, u.fullName, hashPassword("Demo1234!")]);
    await ins("SchoolMembership", ["schoolId", "userId", "role", "status"], [school, uid, u.role, "ACTIVE"]);
    users[u.role] = uid;
    console.log(`  user ${u.email} (${u.role})`);
  }

  const year = await ins("AcademicYear", ["schoolId", "year", "isCurrent"], [school, "2026", true]);
  const term = await ins("Term",
    ["schoolId", "academicYearId", "number", "name", "startDate", "endDate", "nextTermBegins", "status", "isCurrent"],
    [school, year, 3, "Term 3", new Date("2026-09-07").toISOString(), new Date("2026-12-04").toISOString(), new Date("2027-01-25").toISOString(), "OPEN", true]);
  await q.query(`UPDATE "School" SET "activeYearId"=$1, "activeTermId"=$2 WHERE "id"=$3`, [year, term, school]);

  const comps = [
    { code: "BOT", name: "Beginning of Term", kind: "CA", weight: 20, levels: "'O_LEVEL'" },
    { code: "MID", name: "Mid Term", kind: "CA", weight: 20, levels: "'O_LEVEL'" },
    { code: "EOT", name: "End of Term Exam", kind: "EXAM", weight: 60, levels: "'PRIMARY','O_LEVEL','A_LEVEL'" },
    { code: "CA", name: "Continuous Assessment", kind: "CA", weight: 100, levels: "'PRIMARY','A_LEVEL'" },
  ];
  const compIds: Record<string, string> = {};
  for (const c of comps) {
    const id = randomUUID();
    await q.query(
      `INSERT INTO "AssessmentComponent" ("id","schoolId","code","name","weightPercent","kind","levels","active") VALUES ($1,$2,$3,$4,$5,$6,ARRAY[${c.levels}]::"Level"[],true)`,
      [id, school, c.code, c.name, c.weight, c.kind]);
    compIds[c.code] = id;
  }

  let admNo = 1000;
  for (const cls of CLASSES) {
    const klass = await ins("SchoolClass", ["schoolId", "name", "level", "active"], [school, cls.name, cls.level, true]);
    const east = await ins("Stream", ["schoolId", "classId", "name"], [school, klass, "East"]);
    const west = await ins("Stream", ["schoolId", "classId", "name"], [school, klass, "West"]);

    // subjects + sheets first
    const subjectIds: [string, string][] = [];
    for (const subjectName of cls.subjects) {
      const subject = await ins("Subject", ["schoolId", "name", "level", "compulsory", "code"], [school, subjectName, cls.level, true, subjectName.slice(0, 3).toUpperCase() + "-" + cls.level.slice(0, 2)]);
      await ins("MarkSheet", ["schoolId", "classId", "subjectId", "termId", "state"], [school, klass, subject, term, "APPROVED"]);
      subjectIds.push([subject, subjectName]);
    }

    // then 12 students, each marked in EVERY subject
    for (let i = 0; i < 12; i++) {
      const sex = i % 2 === 0 ? "F" : "M";
      const first = (sex === "F" ? FIRST_F : FIRST_M)[between(0, 11)];
      const last = pick(LAST);
      admNo += 1;
      const dobYears = cls.level === "PRIMARY" ? 2 : cls.level === "O_LEVEL" ? 3 : 5;
      const student = await ins("Student",
        ["schoolId", "admissionNo", "firstName", "lastName", "sex", "dateOfBirth", "guardianName", "guardianPhone"],
        [school, `D${admNo}`, first, last, sex,
         new Date(2009 - dobYears, between(1, 12) - 1, between(1, 28)).toISOString(),
         `${pick(LAST)} ${first}`, "+2567" + between(10000000, 99999999)]);
      const stream = i < 6 ? east : west;
      const enrollment = await ins("Enrollment",
        ["schoolId", "studentId", "academicYearId", "classId", "streamId", "rollNo", "status"],
        [school, student, year, klass, stream, i + 1, "ACTIVE"]);

      await ins("AttendanceRecord",
        ["schoolId", "studentId", "enrollmentId", "termId", "classId", "streamId", "daysPresent", "daysAbsent", "daysTotal"],
        [school, student, enrollment, term, klass, stream, between(78, 92), between(0, 6), 92]);
      await ins("Comment", ["schoolId", "studentId", "termId", "authorRole", "text", "createdBy"],
        [school, student, term, "CLASS_TEACHER", `${first} is ${rnd() > 0.5 ? "hardworking and disciplined" : "improving steadily"}. Keep it up.`, users["TEACHER"]]);
      await ins("Comment", ["schoolId", "studentId", "termId", "authorRole", "text", "createdBy"],
        [school, student, term, "HEAD_TEACHER", `Promoted to the next class. ${rnd() > 0.5 ? "Excellent" : "Good"} performance overall.`, users["HEAD_TEACHER"]]);

      for (const [subject, subjectName_] of subjectIds) {
        const parts = cls.isO
          ? [ { code: "BOT", score: between(20, 90), max: 100 }, { code: "MID", score: between(20, 90), max: 100 }, { code: "EOT", score: between(20, 95), max: 100 } ]
          : [ { code: "CA", score: between(20, 90), max: 100 }, { code: "EOT", score: between(20, 95), max: 100 } ];
        for (const p of parts) {
          await ins("Mark",
            ["schoolId", "studentId", "subjectId", "termId", "componentId", "enrollmentId", "type", "score", "maxScore", "enteredBy", "sheetState"],
            [school, student, subject, term, compIds[p.code], enrollment, "VALUE", p.score, p.max, users["TEACHER"], "APPROVED"]);
        }
        const marks: ComponentMark[] = parts.map((p) => ({
          componentId: compIds[p.code],
          componentCode: p.code,
          componentKind: p.code === "EOT" ? ("EXAM" as const) : ("CA" as const),
          type: "VALUE" as ComponentMark["type"],
          score: p.score,
          maxScore: p.max,
        }));
        const input: SubjectInput = {
          subjectId: subject, name: subjectName_, compulsory: true,
          principal: cls.isA, subsidiary: false, maxMarks: 100, marks,
        };
        const r = computeSubject(cls.scheme, input);
        await q.query(
          `INSERT INTO "TermResult" ("id","schoolId","studentId","enrollmentId","termId","subjectId","total","percentage","grade","points","remark","complete","blockingReasons") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,ARRAY(SELECT jsonb_array_elements_text($13::jsonb)))`,
          [randomUUID(), school, student, enrollment, term, subject,
           r.total, r.percentage, r.grade, r.points, r.remark, r.complete, JSON.stringify(r.blockingReasons ?? [])]);
      }
    }
    console.log(`  ${cls.name}: 12 students × ${cls.subjects.length} subjects marked & graded`);
  }

  await ins("SubscriptionAccount",
    ["schoolId", "plan", "status", "provider", "trialEndsAt", "maxStudents", "maxStaff"],
    [school, "FREE_TRIAL", "TRIALING", "pesapal", new Date(Date.now() + 14 * 86400 * 1000).toISOString(), 999999, 999]);

  const counts = (await q.query(`SELECT (SELECT count(*) FROM "Student") s, (SELECT count(*) FROM "Mark") m, (SELECT count(*) FROM "TermResult") t`)) as any;
  const c = counts.rows?.[0] ?? counts[0];
  console.log(`\nDone. School ${DEMO_SCHOOL_NAME} (${school})`);
  console.log(`   students=${c.s} marks=${c.m} termResults=${c.t}`);
  console.log("   Log in with e.g. head@demo.derycode.online / Demo1234!");
}

main().catch((e) => { console.error(e); process.exit(1); });
