import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/src/db/prisma";
import { billingRepo } from "@/src/db/prismaRepos";
import { startCheckout } from "@/src/services/billing";
import * as pesapal from "@/src/billing/pesapal";
import type { PlanTier } from "@/src/billing/tiers";
import { assertCsrf, rateLimited, requireCtx } from "@/src/api/session";
import { serviceErrorToResponse } from "@/src/api/errors";

export const dynamic = "force-dynamic";

const Body = z.object({
  schoolId: z.string().min(1),
  planId: z.enum(["STARTER", "GROWTH", "INSTITUTION"]),
});

export async function POST(req: NextRequest) {
  const authed = await requireCtx(req);
  if ("res" in authed) return authed.res;
  const csrf = assertCsrf(req, authed.csrfSecret);
  if (csrf) return csrf;

  const rl = rateLimited(`checkout:${authed.ctx.userId}`, 10, 60_000);
  if (rl) return rl;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json(
    { error: { code: "VALIDATION", message: "planId must be STARTER, GROWTH or INSTITUTION" } },
    { status: 400 }
  );

  const db = prisma();
  try {
    const user = await db.user.findFirst({ where: { id: authed.ctx.userId } });
    const school = await db.school.findFirst({ where: { id: parsed.data.schoolId } });
    if (!school) throw new (await import("@/src/db/types")).ServiceError("NOT_FOUND", "School not found");

    // Cover the school's active term when one exists.
    const term = school.activeTermId
      ? await db.term.findFirst({ where: { id: school.activeTermId } })
      : null;

    const appBaseUrl = process.env.APP_BASE_URL ?? new URL(req.url).origin;

    const res = await startCheckout(
      authed.ctx,
      {
        schoolId: parsed.data.schoolId,
        planId: parsed.data.planId as PlanTier,
        termName: term?.name,
        termEndsAt: term?.endDate ?? undefined,
        email: user?.email ?? `billing@${school.id}.school.ug`,
        firstName: user?.fullName?.split(" ")[0] ?? "Billing",
        phone: user?.phone ?? undefined,
        appBaseUrl,
      },
      billingRepo(db),
      pesapal as never,
      {
        record: async (schoolId, event) => {
          await db.auditEvent.create({
            data: {
              schoolId,
              userId: event.userId,
              action: event.action,
              entity: event.entity,
              entityId: event.entityId ?? null,
              after: (event.after ?? {}) as object,
            },
          }).catch(() => {});
        },
      }
    );

    return Response.json({ ok: true, ...res });
  } catch (e) {
    return serviceErrorToResponse(e);
  }
}
