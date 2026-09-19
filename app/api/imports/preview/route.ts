import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/src/db/prisma";
import { marksRepo } from "@/src/db/prismaRepos";
import { previewBundleMerge, type BundleMark } from "@/src/migration/bundle";
import { assertCsrf, jsonError, rateLimited, requireCtx } from "@/src/api/session";
import { requireScope } from "@/src/auth/tenant";
import { can } from "@/src/auth/rbac";
import { ServiceError } from "@/src/db/types";

export const dynamic = "force-dynamic";

const Mark = z.object({
  studentId: z.string().min(1),
  subjectId: z.string().min(1),
  termId: z.string().min(1),
  componentId: z.string().min(1),
  type: z.enum(["VALUE", "ABS", "MISSING", "EXEMPT", "NA"]),
  score: z.number().min(0).nullable().optional(),
  maxScore: z.number().int().min(1).max(1000).optional(),
  updatedAt: z.number(),
});

const Body = z.object({
  schoolId: z.string().min(1),
  marks: z.array(Mark).max(5000),
});

export async function POST(req: NextRequest) {
  const authed = await requireCtx(req);
  if ("res" in authed) return authed.res;
  const csrf = assertCsrf(req, authed.csrfSecret);
  if (csrf) return csrf;

  const rl = rateLimited(`import:${authed.ctx.userId}`, 10, 60_000);
  if (rl) return rl;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("VALIDATION", "Invalid bundle preview request", 400);

  try {
    const scope = requireScope(authed.ctx.memberships, parsed.data.schoolId);
    if (!can(scope.role, "marks:import")) {
      throw new ServiceError("FORBIDDEN", `${scope.role} cannot import marks`);
    }

    const db = prisma();
    // Load ALL existing marks for the affected (term, subject) pairs — the
    // preview must see current server state, never trust client snapshots.
    const termIds = [...new Set(parsed.data.marks.map((m) => m.termId))];
    const subjectIds = [...new Set(parsed.data.marks.map((m) => m.subjectId))];
    const existingRows = await db.mark.findMany({
      where: {
        schoolId: parsed.data.schoolId,
        termId: { in: termIds },
        subjectId: { in: subjectIds },
      },
    });

    const incoming: BundleMark[] = parsed.data.marks.map((m) => ({
      ...m,
      type: m.type as BundleMark["type"],
      score: m.score ?? null,
    }));
    const existing = existingRows.map((m) => ({
      studentId: m.studentId,
      subjectId: m.subjectId,
      termId: m.termId,
      componentId: m.componentId,
      score: m.score === null ? null : Number(m.score),
      version: m.version,
      updatedAt: m.updatedAt.getTime(),
    }));

    const preview = previewBundleMerge(incoming, existing, { forceNewerOnly: true });
    return Response.json({ ok: true, preview });
  } catch (e) {
    const anyE = e as { code?: string; message?: string };
    const status = anyE?.code === "FORBIDDEN" || anyE?.code === "TENANT_ACCESS_DENIED" ? 403 : 400;
    return Response.json(
      { error: { code: anyE?.code ?? "INTERNAL", message: anyE?.message ?? "Preview failed" } },
      { status }
    );
  }
}
