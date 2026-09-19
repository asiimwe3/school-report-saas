import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/src/db/prisma";
import { marksRepo, importJobsRepo, auditRepo } from "@/src/db/prismaRepos";
import { applyBundleImport } from "@/src/services/importCommit";
import type { MergePreview } from "@/src/migration/bundle";
import { serviceErrorToResponse } from "@/src/api/errors";
import { assertCsrf, jsonError, rateLimited, requireCtx } from "@/src/api/session";

export const dynamic = "force-dynamic";

const PreviewRow = z.object({
  kind: z.string(),
  mark: z.record(z.unknown()),
  message: z.string().optional(),
});

const Body = z.object({
  schoolId: z.string().min(1),
  classId: z.string().min(1),
  subjectId: z.string().min(1),
  termId: z.string().min(1),
  preview: z.object({
    rows: z.array(PreviewRow),
    additions: z.number(),
    updates: z.number(),
    conflicts: z.number(),
    rejects: z.number(),
    duplicates: z.number(),
  }),
});

export async function POST(req: NextRequest) {
  const authed = await requireCtx(req);
  if ("res" in authed) return authed.res;
  const csrf = assertCsrf(req, authed.csrfSecret);
  if (csrf) return csrf;

  const rl = rateLimited(`import:${authed.ctx.userId}`, 10, 60_000);
  if (rl) return rl;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("VALIDATION", "Invalid commit request", 400);

  const db = prisma();
  try {
    // Re-verify every row against live data inside applyBundleImport; the
    // client-supplied preview is only a hint, never an instruction.
    const result = await applyBundleImport(
      authed.ctx,
      { ...parsed.data, preview: parsed.data.preview as unknown as MergePreview },
      marksRepo(db),
      importJobsRepo(db),
      auditRepo(db)
    );
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return serviceErrorToResponse(e);
  }
}
