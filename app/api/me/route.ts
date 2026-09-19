import { NextRequest } from "next/server";
import { prisma } from "@/src/db/prisma";
import { jsonError, requireCtx } from "@/src/api/session";

export const dynamic = "force-dynamic";

/** Who am I + which schools am I in, with role and active year/term names. */
export async function GET(req: NextRequest) {
  const authed = await requireCtx(req);
  if ("res" in authed) return authed.res;

  const db = prisma();
  const schools = await prisma().school.findMany({
    where: { id: { in: authed.ctx.memberships.map((m) => m.schoolId) } },
  });

  return Response.json({
    user: { id: authed.ctx.userId },
    csrfSecret: authed.csrfSecret,
    schools: authed.ctx.memberships.map((m) => {
      const s = schools.find((x) => x.id === m.schoolId);
      return {
        id: m.schoolId,
        role: m.role,
        status: m.status,
        name: s?.name ?? m.schoolId,
        activeYearId: s?.activeYearId ?? null,
        activeTermId: s?.activeTermId ?? null,
      };
    }),
    assignments: authed.ctx.assignments,
  });
}
