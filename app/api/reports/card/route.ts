import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/src/db/prisma";
import { reportsRepo } from "@/src/db/prismaRepos";
import { buildReportCard } from "@/src/services/reports";
import { renderPrintHtml, renderDocx } from "@/src/reports/render";
import { requireCtx } from "@/src/api/session";
import { serviceErrorToResponse } from "@/src/api/errors";
import { can } from "@/src/auth/rbac";

export const dynamic = "force-dynamic";

const Q = z.object({
  schoolId: z.string().min(1),
  studentId: z.string().min(1),
  termId: z.string().min(1),
  format: z.enum(["html", "docx"]).default("html"),
});

export async function GET(req: NextRequest) {
  const authed = await requireCtx(req);
  if ("res" in authed) return authed.res;

  const parsed = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return serviceErrorToResponse(
    Object.assign(new Error("schoolId, studentId and termId are required"), { code: "VALIDATION" })
  );

  const db = prisma();
  try {
    const data = await buildReportCard(authed.ctx, parsed.data, reportsRepo(db));
    await db.auditEvent.create({
      data: {
        schoolId: parsed.data.schoolId,
        userId: authed.ctx.userId,
        action: "reports.report_card_generated",
        entity: "Student",
        entityId: parsed.data.studentId,
        after: { termId: parsed.data.termId, format: parsed.data.format },
      },
    }).catch(() => {});

    if (parsed.data.format === "docx") {
      const buf = await renderDocx(data);
      const fname = `report-card-${data.student.admissionNo}-${data.term.name.replace(/\s+/g, "-")}.docx`;
      return new Response(new Uint8Array(buf), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="${fname}"`,
        },
      });
    }
    return new Response(renderPrintHtml(data), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch (e) {
    return serviceErrorToResponse(e);
  }
}
