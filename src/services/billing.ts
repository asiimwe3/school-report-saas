/**
 * Billing service — per-term licenses paid via Pesapal (UGX).
 * Checkout: owner/bursar picks a plan → Pesapal hosted checkout.
 * Confirmation: Pesapal IPN hits /api/billing/ipn; we NEVER trust the
 * payload — the service re-verifies with GetTransactionStatus using our own
 * credentials before granting anything. Webhook events are idempotent by
 * orderTrackingId.
 */
import { can } from "../auth/rbac";
import { requireScope } from "../auth/tenant";
import { ServiceError, type Ctx } from "../db/types";
import { PLANS, planById, type Plan } from "../billing/plans";
import type { PlanTier } from "../billing/tiers";

export type BillingOrderRecord = {
  id: string;
  schoolId: string;
  plan: PlanTier;
  amount: number;
  currency: string;
  status: "PENDING" | "AWAITING_PAYMENT" | "PAID" | "FAILED" | "CANCELLED";
  orderTrackingId: string | null;
  merchantRef: string;
  paymentMethod?: string | null;
  confirmationCode?: string | null;
  paidAt?: Date | null;
  termEndsAt?: Date | null;
  createdAt?: Date | null;
};

export type SubscriptionRecord = {
  schoolId: string;
  plan: PlanTier;
  status: "TRIALING" | "ACTIVE" | "PAST_DUE" | "GRACE" | "CANCELED" | "UNPAID";
  trialEndsAt?: Date | null;
  currentPeriodEnd?: Date | null;
  maxStudents: number | null;
  maxStaff: number;
};

export interface BillingRepo {
  createOrder(
    data: Omit<BillingOrderRecord, "id" | "status" | "orderTrackingId" | "merchantRef">
  ): Promise<BillingOrderRecord & { merchantRef: string }>;
  findOrderByMerchantRef(ref: string): Promise<BillingOrderRecord | null>;
  setOrderTracking(id: string, orderTrackingId: string): Promise<void>;
  markOrderPaid(
    id: string,
    info: { orderTrackingId: string; paymentMethod?: string; confirmationCode?: string; paidAt: Date }
  ): Promise<void>;
  markOrderFailed(id: string, method?: string): Promise<void>;
  findWebhook(orderTrackingId: string): Promise<{ id: string } | null>;
  recordWebhook(data: {
    orderTrackingId: string;
    merchantRef: string;
    status: string;
    payload: unknown;
  }): Promise<void>;
  getSubscription(schoolId: string): Promise<SubscriptionRecord | null>;
  upsertSubscription(schoolId: string, data: {
    plan: PlanTier;
    status: "TRIALING" | "ACTIVE" | "PAST_DUE" | "GRACE" | "CANCELED" | "UNPAID";
    currentPeriodEnd: Date;
    maxStudents: number | null;
    maxStaff: number;
  }): Promise<SubscriptionRecord>;
}

export interface PesapalGateway {
  isConfigured(): boolean;
  token(): Promise<string>;
  registerIpn(t: string, ipnUrl: string): Promise<string>;
  submitOrder(
    t: string,
    input: { merchantRef: string; amount: number; description: string; callbackUrl: string; ipnId: string; email: string; firstName: string; phone?: string }
  ): Promise<{ orderTrackingId: string; redirectUrl: string }>;
  transactionStatus(t: string, orderTrackingId: string): Promise<{
    payment_status: string;
    payment_method?: string;
    confirmation_code?: string;
  }>;
}

export interface AuditSink {
  record(schoolId: string, event: {
    schoolId: string; userId: string; action: string; entity: string; entityId?: string; after?: unknown; createdAt: number;
  }): Promise<void>;
}

const genRef = () => `SRS-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

export interface CheckoutInput {
  schoolId: string;
  planId: PlanTier;
  /** Term the licence covers — used for the description + period end. */
  termName?: string;
  termEndsAt?: Date;
  email: string;
  firstName: string;
  phone?: string;
  /** Public origin of the app, e.g. https://reports.derycode.online */
  appBaseUrl: string;
}

/**
 * Creates a Pesapal order for the plan and returns the hosted-checkout URL.
 * RBAC: only billing:manage (owner/bursar) can start a checkout, and only
 * for a school the caller is a member of.
 */
export async function startCheckout(
  ctx: Ctx,
  input: CheckoutInput,
  repo: BillingRepo,
  gw: PesapalGateway,
  audit: AuditSink
): Promise<{ redirectUrl: string; merchantRef: string; orderTrackingId: string }> {
  const scope = requireScope(ctx.memberships, input.schoolId);
  if (!can(scope.role, "billing:manage")) {
    throw new ServiceError("FORBIDDEN", `${scope.role} cannot manage billing`);
  }
  const plan = planById(input.planId);
  if (!plan || plan.priceUgx <= 0) {
    throw new ServiceError("VALIDATION", "Pick a paid plan (STARTER, GROWTH or INSTITUTION)");
  }
  if (!gw.isConfigured()) {
    throw new ServiceError(
      "NOT_CONFIGURED",
      "Payments are not configured yet — set PESAPAL_CONSUMER_KEY and PESAPAL_CONSUMER_SECRET"
    );
  }

  const order = await repo.createOrder({
    schoolId: input.schoolId,
    plan: plan.id,
    amount: plan.priceUgx,
    currency: "UGX",
    termEndsAt: input.termEndsAt ?? null,
  });

  const t = await gw.token();
  const ipnId = await gw.registerIpn(t, `${input.appBaseUrl}/api/billing/ipn`);
  const sub = await gw.submitOrder(t, {
    merchantRef: order.merchantRef,
    amount: plan.priceUgx,
    description: `DeryCode Reports ${plan.name} licence${input.termName ? ` — ${input.termName}` : ""}`,
    callbackUrl: `${input.appBaseUrl}/api/billing/callback`,
    ipnId,
    email: input.email,
    firstName: input.firstName,
    phone: input.phone,
  });
  await repo.setOrderTracking(order.id, sub.orderTrackingId);

  await audit.record(input.schoolId, {
    schoolId: input.schoolId,
    userId: ctx.userId,
    action: "billing.checkout_started",
    entity: "BillingOrder",
    entityId: order.id,
    after: { plan: plan.id, amountUgx: plan.priceUgx, orderTrackingId: sub.orderTrackingId },
    createdAt: Date.now(),
  });

  return { redirectUrl: sub.redirectUrl, merchantRef: order.merchantRef, orderTrackingId: sub.orderTrackingId };
}

export interface IpnInput {
  orderTrackingId: string;
  orderMerchantReference: string;
}

export interface IpnOutcome {
  handled: boolean;
  status: "PAID" | "FAILED" | "PENDING";
  plan?: PlanTier;
}

/**
 * Processes a Pesapal IPN. The payload is untrusted — after recording it for
 * audit, we re-verify via GetTransactionStatus. Granting the subscription is
 * idempotent via the webhook-events table.
 */
export async function handleIpn(
  input: IpnInput,
  repo: BillingRepo,
  gw: PesapalGateway,
  audit: AuditSink
): Promise<IpnOutcome> {
  if (!input.orderTrackingId || !input.orderMerchantReference) {
    throw new ServiceError("VALIDATION", "Missing OrderTrackingId / OrderMerchantReference");
  }
  if (!gw.isConfigured()) {
    // Still record the hit, but never grant without verification.
    throw new ServiceError("NOT_CONFIGURED", "Gateway not configured");
  }

  // Idempotency: an already-processed tracking id is a no-op.
  const seen = await repo.findWebhook(input.orderTrackingId);
  if (seen) return { handled: false, status: "PENDING" };

  const order = await repo.findOrderByMerchantRef(input.orderMerchantReference);
  if (!order) {
    throw new ServiceError("NOT_FOUND", "Unknown merchant reference — ignoring IPN");
  }

  // NEVER trust the IPN body — verify server-to-server.
  const t = await gw.token();
  const status = await gw.transactionStatus(t, input.orderTrackingId);

  await repo.recordWebhook({
    orderTrackingId: input.orderTrackingId,
    merchantRef: input.orderMerchantReference,
    status: status.payment_status,
    payload: { ipn: input, verified: status },
  });

  if (status.payment_status !== "COMPLETED") {
    if (status.payment_status === "FAILED" || status.payment_status === "INVALID") {
      await repo.markOrderFailed(order.id, status.payment_method);
    }
    return { handled: false, status: "FAILED" };
  }

  const paidAt = new Date();
  await repo.markOrderPaid(order.id, {
    orderTrackingId: input.orderTrackingId,
    paymentMethod: status.payment_method,
    confirmationCode: status.confirmation_code,
    paidAt,
  });

  const plan = planById(order.plan as PlanTier);
  const periodEnd = order.termEndsAt ?? new Date(paidAt.getTime() + 90 * 24 * 3600 * 1000);
  const sub = await repo.upsertSubscription(order.schoolId, {
    plan: order.plan as PlanTier,
    status: "ACTIVE",
    currentPeriodEnd: periodEnd,
    maxStudents: plan?.maxStudents ?? null,
    maxStaff: plan?.maxStaff ?? 50,
  });

  await audit.record(order.schoolId, {
    schoolId: order.schoolId,
    userId: "pesapal",
    action: "billing.payment_confirmed",
    entity: "BillingOrder",
    entityId: order.id,
    after: {
      plan: sub.plan,
      amountUgx: order.amount,
      confirmationCode: status.confirmation_code,
      currentPeriodEnd: sub.currentPeriodEnd,
    },
    createdAt: Date.now(),
  });

  return { handled: true, status: "PAID", plan: sub.plan };
}

/** Billing dashboard payload: plans + current subscription + order history. */
export async function getBilling(
  ctx: Ctx,
  schoolId: string,
  repo: {
    getSubscription(schoolId: string): Promise<SubscriptionRecord | null>;
    listOrders(schoolId: string): Promise<BillingOrderRecord[]>;
  }
): Promise<{
  plans: ReturnType<typeof planCatalog>;
  subscription: SubscriptionRecord | null;
  orders: Array<Pick<BillingOrderRecord, "merchantRef" | "plan" | "amount" | "status" | "paidAt" | "createdAt">>;
}> {
  const scope = requireScope(ctx.memberships, schoolId);
  if (!can(scope.role, "billing:view")) {
    throw new ServiceError("FORBIDDEN", `${scope.role} cannot view billing`);
  }
  const [sub, orders] = await Promise.all([repo.getSubscription(schoolId), repo.listOrders(schoolId)]);
  return {
    plans: planCatalog(sub?.plan ?? null),
    subscription: sub,
    orders: orders.slice(0, 20).map((o) => ({
      merchantRef: o.merchantRef,
      plan: o.plan,
      amount: o.amount,
      status: o.status,
      paidAt: o.paidAt ?? null,
      createdAt: o.createdAt ?? null,
    })),
  };
}

function planCatalog(_current: PlanTier | null): Plan[] {
  return PLANS;
}
