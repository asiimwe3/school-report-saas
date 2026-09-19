import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/src/db/prisma";
import { billingRepo } from "@/src/db/prismaRepos";
import { getBilling } from "@/src/services/billing";
import { isConfigured } from "@/src/billing/pesapal";
import { BILLING_MODEL } from "@/src/billing/plans";
import { jsonError, requireCtx } from "@/src/api/session";
import { serviceErrorToResponse } from "@/src/api/errors";

export const dynamic = "force-dynamic";

const Q = z.object({ schoolId: z.string().min(1) });

export async function GET(req: NextRequest) {
  const authed = await requireCtx(req);
  if ("res" in authed) return authed.res;

  const parsed = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return jsonError("VALIDATION", "schoolId required", 400);

  try {
    const out = await getBilling(authed.ctx, parsed.data.schoolId, billingRepo(prisma()));
    return Response.json({ ...out, gatewayConfigured: isConfigured(), billingModel: BILLING_MODEL });
  } catch (e) {
    return serviceErrorToResponse(e);
  }
}
