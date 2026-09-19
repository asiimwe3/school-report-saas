import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Browser callback after the hosted checkout. Pesapal appends
 * ?OrderTrackingId=...&OrderMerchantReference=... — we just send the user
 * back to the billing page, which shows live order/subscription state.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const tracking = url.searchParams.get("OrderTrackingId") ?? "";
  const target = new URL("/billing?checkout=" + encodeURIComponent(tracking.slice(0, 64)), url.origin);
  return NextResponse.redirect(target);
}
