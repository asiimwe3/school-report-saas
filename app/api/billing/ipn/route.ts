import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/db/prisma";
import { billingRepo } from "@/src/db/prismaRepos";
import { handleIpn } from "@/src/services/billing";
import * as pesapal from "@/src/billing/pesapal";

export const dynamic = "force-dynamic";

/**
 * Pesapal IPN endpoint — called by Pesapal's servers (POST body or GET query).
 * The payload is untrusted; handleIpn re-verifies via GetTransactionStatus.
 * Always answers 200 so Pesapal does not retry forever; outcome is recorded
 * in the webhook/order tables and the audit log.
 */
async function process(orderTrackingId?: string | null, orderMerchantReference?: string | null) {
  if (!orderTrackingId || !orderMerchantReference) {
    return NextResponse.json({ ok: false, reason: "missing params" }, { status: 200 });
  }
  const db = prisma();
  try {
    const out = await handleIpn(
      { orderTrackingId, orderMerchantReference },
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
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    const anyE = e as { code?: string; message?: string };
    // Unknown refs / transient errors: acknowledge without granting.
    return NextResponse.json({ ok: false, code: anyE?.code, message: anyE?.message }, { status: 200 });
  }
}

export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams;
  return process(q.get("OrderTrackingId"), q.get("OrderMerchantReference"));
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, string>;
  return process(body.OrderTrackingId, body.OrderMerchantReference);
}
