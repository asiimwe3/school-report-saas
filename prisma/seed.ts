/**
 * Demo seed — one school covering all three curricula (PLE / UCE / UACE)
 * with users for every role, a live term, marks computed through the real
 * grading engine, comments, attendance and a trial subscription.
 *
 * Run ONLY against a dev/staging database:
 *   npx tsx prisma/seed.ts           # seeds if demo school absent
 *   npx tsx prisma/seed.ts --reset   # wipes and reseeds the demo school
 *
 * Guarded by DEMO_SEED_ALLOWED=1 to prevent accidents in production.
 */
import { PrismaClient, Level, Role, MembershipStatus, MarkType, SheetState } from "@prisma/client";
import { hashPassword } from "../src/auth/passwords";
import { computeSubject, SubjectInput, ComponentMark } from "../src/grading/engine";
import { PLE_SCHEME, UCE_SCHEME, UACE_SCHEME } from "../src/grading/schemes";

const db = new PrismaClient();
const DEMO_SCHOOL_NAME = "DeryCode Demo Secondary School";

// deterministic pseudo-random so reseeds look identical
let seedState = 42;
const rnd = () => ((seedState = (seedState * 1103515245 + 12345) % 2147483648) / 2147483648);

const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const FIRST_M = ["Emmanuel","Isaac","Joseph","Ronald","Patrick","Timothy","Julius","Moses","Eric","Denis","Collin","Felix"];
const FIRST_F = ["Grace","Sarah","Joan","Esther","Brenda","Patricia","Alice","Vanessa","Doreen","Millicent","Sharon","Irene"];
const LAST = ["Atuhaire","Mugisha","Tumwesigye","Nabukenya","Kyomuhendo","Asiimwe","Byaruhanga","Ainemukama","Tushabe","Natukunda","Kabagambe","Rukundo"];

const USERS = [
  { email: "owner@demo.derycode.online", fullName: "Demo Owner", role: Role.SCHOOL_OWNER },
  { email: "head@demo.derycode.online", fullName: "Demo Head Teacher", role: Role.HEAD_TEACHER },
  { email: "admin@demo.derycode.online", fullName: "Demo Administrator", role: Role.SCHOOL_ADMIN },
  { email: "teacher@demo.derycode.online", fullName: "Demo Teacher", role: Role.TEACHER },
  { email: "bursar@demo.derycode.online", fullName: "Demo Bursar", role: Role.BURSAR },
  { email: "data@demo.derycode.online", fullName: "Demo Data Entry", role: Role.DATA_ENTRY },
] as const;

const CLASSES = [
  { name: "Primary 7", level: Level.PRIMARY, scheme: PLE_SCHEME, subjects: ["Mathematics","English","Integrated Science","Social Studies"] },
  { name: "Senior 4", level: Level.O_LEVEL, scheme: UCE_SCHEME, subjects: ["Mathematics","English","Physics","Chemistry","Biology","History"] },
  { name: "Senior 6", level: Level.A_LEVEL, scheme: UACE_SCHEME, subjects: ["General Paper","Mathematics","Physics","Economics"] },
] as const;

async function main() {
  if (process.env.DEMO_SEED_ALLOWED !== "1") {
    throw new Error("Refusing to seed: set DEMO_SEED_ALLOWED=1 (dev/staging only).");
  }
  const reset = process.argv.includes("--reset");

  const existing = await db.school.findFirst({ where: { name: DEMO_SCHOOL_NAME } });
  if (existing && !reset) {
    console.log(`Demo school already exists (id ${existing.id}) — nothing to do. Use --reset to wipe and reseed.`);
    return;
  }
  if (existing) {
    console.log("Resetting demo school…");
    await db.school.delete({ where: { id: existing.id } }); // cascades everything
  }

  console.log("Creating demo school…");
  const school = await db.school.create({
    data: {
      name: DEMO_SCHOOL_NAME,
      shortName: "Knowledge is Light",
      district: "Kyenjojo",
      activeYearId: null,
      activeTermId: null,
    },
  });

  // ── Users & memberships ────────────────────────────────────────────────
  const users: Record<string, string> = {};
  for (const u of USERS) {
    const user = await db.user.create({
      data: {
        email: u.email,
        fullName: u.fullName,
        passwordHash: hashPassword("Demo1234!"),
        memberships: { create: { schoolId: school.id, role: u.role, status: MembershipStatus.ACTIVE } },
      },
    });
    users[u.role] = user.id;
    console.log(`  user ${u.email} (${u.role}) password: Demo1234!`);
  }

  // ── Academic year & current term ───────────────────────────────────────
  const year = await db.academicYear.create({
    data: { schoolId: school.id, year: "2026", isCurrent: true },
  });
  const term = await db.term.create({
    data: {
      schoolId: school.id, academicYearId: year.id, number: 3, name: "Term 3",
      startDate: new Date("2026-09-07"), endDate: new Date("2026-12-04"),
      nextTermBegins: new Date("2027-01-25"), status: "OPEN", isCurrent: true,
    },
  });
  await db.school.update({
    where: { id: school.id },
    data: { activeYearId: year.id, activeTermId: term.id },
  });

  // ── Classes, streams, subjects ──────────────────────────────────────────
  const comps = await db.assessmentComponent.createMany({
    data: [
      { schoolId: school.id, code: "BOT", name: "Beginning of Term", kind: "CA", weightPercent: 20, levels: [Level.O_LEVEL] },
      { schoolId: school.id, code: "MID", name: "Mid Term", kind: "CA", weightPercent: 20, levels: [Level.O_LEVEL] },
      { schoolId: school.id, code: "EOT", name: "End of Term Exam", kind: "EXAM", weightPercent: 60, levels: [Level.PRIMARY, Level.O_LEVEL, Level.A_LEVEL] },
      { schoolId: school.id, code: "CA", name: "Continuous Assessment", kind: "CA", weightPercent: 100, levels: [Level.PRIMARY, Level.A_LEVEL] },
    ],
  });
  const componentRows = await db.assessmentComponent.findMany({ where: { schoolId: school.id } });
  const compBy = (code: string) => componentRows.find((c) => c.code === code)!;

  let admNo = 1000;
  for (const cls of CLASSES) {
    const klass = await db.schoolClass.create({
      data: { schoolId: school.id, name: cls.name, level: cls.level, active: true },
    });
    const east = await db.stream.create({
      data: { schoolId: school.id, classId: klass.id, name: "East" },
    });
    const west = await db.stream.create({
      data: { schoolId: school.id, classId: klass.id, name: "West" },
    });

    // subjects + mark sheets first (unique code per level)
    const subjects: { id: string; name: string }[] = [];
    for (const subjectName of cls.subjects) {
      const subject = await db.subject.create({
        data: {
          schoolId: school.id, name: subjectName, level: cls.level,
          compulsory: true, code: subjectName.slice(0, 3).toUpperCase() + "-" + cls.level.slice(0, 2),
        },
      });
      await db.markSheet.create({
        data: {
          schoolId: school.id, classId: klass.id, subjectId: subject.id, termId: term.id,
          state: SheetState.APPROVED,
        },
      });
      subjects.push({ id: subject.id, name: subject.name });
    }

    // then 12 students (6 per stream), each marked in EVERY subject
    for (let i = 0; i < 12; i++) {
      const sex = i % 2 === 0 ? "F" : "M";
      const first = (sex === "F" ? FIRST_F : FIRST_M)[between(0, 11)];
      const last = pick(LAST);
      admNo += 1;
      const student = await db.student.create({
        data: {
          schoolId: school.id, admissionNo: `D${admNo}`,
          firstName: first, lastName: last, sex,
          dateOfBirth: new Date(2009 - (cls.level === Level.PRIMARY ? 2 : cls.level === Level.O_LEVEL ? 3 : 5), between(1, 12), between(1, 28)),
          guardianName: `${pick(LAST)} ${first}`, guardianPhone: "+2567" + between(10000000, 99999999),
        },
      });
      const stream = i < 6 ? east : west;
      const enrollment = await db.enrollment.create({
        data: {
          schoolId: school.id, studentId: student.id, academicYearId: year.id,
          classId: klass.id, streamId: stream.id, rollNo: i + 1, status: "ACTIVE",
        },
      });

      // Attendance + comments (once per student)
      await db.attendanceRecord.create({
        data: {
          schoolId: school.id, studentId: student.id, enrollmentId: enrollment.id,
          termId: term.id, classId: klass.id, streamId: stream.id,
          daysPresent: between(78, 92), daysAbsent: between(0, 6), daysTotal: 92,
        },
      });
      await db.comment.createMany({
        data: [
          { schoolId: school.id, studentId: student.id, termId: term.id, authorRole: "CLASS_TEACHER", text: `${first} is ${rnd() > 0.5 ? "hardworking and disciplined" : "improving steadily"}. Keep it up.`, createdBy: users[Role.TEACHER] },
          { schoolId: school.id, studentId: student.id, termId: term.id, authorRole: "HEAD_TEACHER", text: `Promoted to the next class. ${rnd() > 0.5 ? "Excellent" : "Good"} performance overall.`, createdBy: users[Role.HEAD_TEACHER] },
        ],
      });

      // Marks: CA components per level scheme
      const isO = cls.level === Level.O_LEVEL;
      for (const subject of subjects) {
        const parts: { code: string; score: number; max: number }[] = isO
          ? [
              { code: "BOT", score: between(20, 90), max: 100 },
              { code: "MID", score: between(20, 90), max: 100 },
              { code: "EOT", score: between(20, 95), max: 100 },
            ]
          : [
              { code: "CA", score: between(20, 90), max: 100 },
              { code: "EOT", score: between(20, 95), max: 100 },
            ];
        for (const p of parts) {
          await db.mark.create({
            data: {
              schoolId: school.id, studentId: student.id, subjectId: subject.id, termId: term.id,
              componentId: compBy(p.code).id, enrollmentId: enrollment.id,
              type: MarkType.VALUE, score: p.score, maxScore: p.max,
              enteredBy: users[Role.TEACHER], sheetState: SheetState.APPROVED,
            },
          });
        }

        // Term result snapshot via the real engine
        const marks: ComponentMark[] = parts.map((p) => ({
          componentId: compBy(p.code).id,
          componentCode: p.code,
          componentKind: p.code === "EOT" ? ("EXAM" as const) : ("CA" as const),
          type: "VALUE" as ComponentMark["type"],
          score: p.score,
          maxScore: p.max,
        }));
        const input: SubjectInput = {
          subjectId: subject.id,
          name: subject.name,
          compulsory: true,
          principal: cls.level === Level.A_LEVEL,
          subsidiary: false,
          maxMarks: 100,
          marks,
        };
        const r = computeSubject(cls.scheme, input);
        await db.termResult.create({
          data: {
            schoolId: school.id, studentId: student.id, enrollmentId: enrollment.id,
            termId: term.id, subjectId: subject.id,
            total: r.total, percentage: r.percentage, grade: r.grade,
            points: r.points, remark: r.remark, complete: r.complete,
            blockingReasons: r.blockingReasons as string[],
          },
        });
      }
    }
    console.log(`  ${cls.name}: 12 students × ${cls.subjects.length} subjects marked & graded`);
  }
  }

  // ── Trial subscription ──────────────────────────────────────────────────
  const trialEnds = new Date(Date.now() + 14 * 24 * 3600 * 1000);
  await db.subscriptionAccount.create({
    data: {
      schoolId: school.id, plan: "FREE_TRIAL", status: "TRIALING", provider: "pesapal",
      trialEndsAt: trialEnds, maxStudents: 999_999, maxStaff: 999,
    },
  });

  console.log("\n✅ Demo seed complete.");
  console.log(`   School: ${DEMO_SCHOOL_NAME} (${school.id})`);
  console.log("   Log in with e.g. head@demo.derycode.online / Demo1234!");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
