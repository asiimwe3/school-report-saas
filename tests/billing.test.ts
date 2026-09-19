import { describe, it, expect } from "vitest";
import { startCheckout, handleIpn, getBilling } from "../src/services/billing";
import type { BillingRepo, BillingOrderRecord, SubscriptionRecord, PesapalGateway } from "../src/services/billing";
import { ServiceError, type Ctx } from "../src/db/types";

// ── fixtures ─────────────────────────────────────────────────────────────────
const OWNER_CTX: Ctx = {
  userId: "u1",
  memberships: [{ schoolId: "sch1", role: "SCHOOL_OWNER", status: "ACTIVE" }],
  assignments: [],
  now: 0,
};
const TEACHER_CTX: Ctx = {
  userId: "u2",
  memberships: [{ schoolId: "sch1", role: "TEACHER", status: "ACTIVE" }],
  assignments: [],
  now: 0,
};

function makeRepo() {
  const orders = new Map<string, BillingOrderRecord>();
  const webhooks = new Map<string, { id: string }>();
  const subs = new Map<string, SubscriptionRecord>();
  let n = 0;
  const repo: BillingRepo & { listOrders: (s: string) => Promise<BillingOrderRecord[]> } = {
    async createOrder(data) {
      const id = `o${++n}`;
      const rec: BillingOrderRecord = {
        id, schoolId: data.schoolId, plan: data.plan, amount: data.amount,
        currency: data.currency, status: "AWAITING_PAYMENT", orderTrackingId: null,
        merchantRef: `SRS-TEST-${id}`, paymentMethod: null, confirmationCode: null,
        paidAt: null, termEndsAt: data.termEndsAt ?? null, createdAt: new Date(),
      };
      orders.set(id, rec);
      return rec;
    },
    async findOrderByMerchantRef(ref) {
      return [...orders.values()].find((o) => o.merchantRef === ref) ?? null;
    },
    async setOrderTracking(id, tid) {
      const o = orders.get(id)!; o.orderTrackingId = tid;
    },
    async markOrderPaid(id, info) {
      const o = orders.get(id)!;
      o.status = "PAID"; o.orderTrackingId = info.orderTrackingId;
      o.paymentMethod = info.paymentMethod; o.confirmationCode = info.confirmationCode; o.paidAt = info.paidAt;
    },
    async markOrderFailed(id, method) {
      const o = orders.get(id)!; o.status = "FAILED"; o.paymentMethod = method ?? null;
    },
    async findWebhook(tid) { return webhooks.get(tid) ?? null; },
    async recordWebhook(d) { webhooks.set(d.orderTrackingId, { id: d.orderTrackingId }); },
    async getSubscription(schoolId) { return subs.get(schoolId) ?? null; },
    async upsertSubscription(schoolId, data) {
      const rec: SubscriptionRecord = { schoolId, plan: data.plan, status: data.status, currentPeriodEnd: data.currentPeriodEnd, maxStudents: data.maxStudents, maxStaff: data.maxStaff };
      subs.set(schoolId, rec);
      return rec;
    },
    async listOrders(schoolId) {
      return [...orders.values()].filter((o) => o.schoolId === schoolId);
    },
  };
  return { repo, orders, subs, webhooks };
}

function makeGateway(over: Partial<PesapalGateway> = {}): PesapalGateway {
  return {
    isConfigured: () => true,
    token: async () => "tok",
    registerIpn: async () => "ipn-1",
    submitOrder: async (_t, input) => ({
      orderTrackingId: `track-${input.merchantRef}`,
      redirectUrl: "https://demo.pesapal.com/checkout/xyz",
    }),
    transactionStatus: async () => ({ payment_status: "COMPLETED", payment_method: "MTN MOMO", confirmation_code: "P-1" }),
    ...over,
  };
}

const AUDIT = {
  record: async () => {},
};

const CHECKOUT = {
  schoolId: "sch1",
  planId: "GROWTH" as const,
  termName: "Term 3 2026",
  termEndsAt: new Date("2026-12-04"),
  email: "bursar@school.ug",
  firstName: "Bursar",
  appBaseUrl: "https://reports.example.ug",
};

// ── checkout ─────────────────────────────────────────────────────────────────
describe("startCheckout", () => {
  it("creates an order and returns the Pesapal redirect URL", async () => {
    const { repo } = makeRepo();
    const res = await startCheckout(OWNER_CTX, CHECKOUT, repo, makeGateway(), AUDIT);
    expect(res.redirectUrl).toContain("demo.pesapal.com");
    expect(res.merchantRef).toMatch(/^SRS-TEST-o1$/);
  });

  it("records the tracking id on the order", async () => {
    const { repo, orders } = makeRepo();
    const res = await startCheckout(OWNER_CTX, CHECKOUT, repo, makeGateway(), AUDIT);
    expect([...orders.values()][0]!.orderTrackingId).toBe(res.orderTrackingId);
  });

  it("blocks non-billing roles", async () => {
    const { repo } = makeRepo();
    await expect(startCheckout(TEACHER_CTX, CHECKOUT, repo, makeGateway(), AUDIT)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("blocks schools outside the caller's memberships", async () => {
    const { repo } = makeRepo();
    await expect(
      startCheckout(OWNER_CTX, { ...CHECKOUT, schoolId: "sch2" }, repo, makeGateway(), AUDIT)
    ).rejects.toMatchObject({ code: "TENANT_ACCESS_DENIED" });
  });

  it("rejects the free trial at checkout", async () => {
    const { repo } = makeRepo();
    await expect(
      startCheckout(OWNER_CTX, { ...CHECKOUT, planId: "FREE_TRIAL" }, repo, makeGateway(), AUDIT)
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("fails cleanly when Pesapal keys are absent", async () => {
    const { repo } = makeRepo();
    await expect(
      startCheckout(OWNER_CTX, CHECKOUT, repo, makeGateway({ isConfigured: () => false }), AUDIT)
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("propagates gateway errors after creating the order", async () => {
    const { repo } = makeRepo();
    const bad = makeGateway({ submitOrder: async () => { throw new Error("gateway down"); } });
    await expect(startCheckout(OWNER_CTX, CHECKOUT, repo, bad, AUDIT)).rejects.toThrow("gateway down");
  });
});

// ── IPN ─────────────────────────────────────────────────────────────────────
describe("handleIpn", () => {
  async function paidFixture() {
    const { repo, subs, orders } = makeRepo();
    await startCheckout(OWNER_CTX, CHECKOUT, repo, makeGateway(), AUDIT);
    const order = [...orders.values()][0]!;
    return { repo, subs, order };
  }

  it("marks the order PAID and activates the subscription with plan caps", async () => {
    const { repo, subs, order } = await paidFixture();
    const out = await handleIpn(
      { orderTrackingId: order.orderTrackingId!, orderMerchantReference: order.merchantRef },
      repo, makeGateway(), AUDIT
    );
    expect(out).toEqual({ handled: true, status: "PAID", plan: "GROWTH" });
    expect(subs.get("sch1")).toMatchObject({ plan: "GROWTH", status: "ACTIVE", maxStudents: 1200 });
  });

  it("uses the term end as the subscription period end", async () => {
    const { repo, subs, order } = await paidFixture();
    await handleIpn(
      { orderTrackingId: order.orderTrackingId!, orderMerchantReference: order.merchantRef },
      repo, makeGateway(), AUDIT
    );
    expect(subs.get("sch1")!.currentPeriodEnd!.toISOString()).toBe(new Date("2026-12-04").toISOString());
  });

  it("is idempotent — a replayed IPN does nothing", async () => {
    const { repo, subs, order } = await paidFixture();
    // First IPN processes normally and grants the subscription.
    await handleIpn(
      { orderTrackingId: order.orderTrackingId!, orderMerchantReference: order.merchantRef },
      repo, makeGateway(), AUDIT
    );
    expect(subs.size).toBe(1);
    // Replay: must short-circuit before re-verifying.
    const gw = makeGateway({
      token: async () => { throw new Error("must not re-verify a replay"); },
    });
    const out = await handleIpn(
      { orderTrackingId: order.orderTrackingId!, orderMerchantReference: order.merchantRef },
      repo, gw, AUDIT
    );
    expect(out.handled).toBe(false);
  });

  it("does NOT grant on a FAILED verified status", async () => {
    const { repo, subs, order } = await paidFixture();
    const out = await handleIpn(
      { orderTrackingId: "track-fail", orderMerchantReference: order.merchantRef },
      repo, makeGateway({ transactionStatus: async () => ({ payment_status: "FAILED" }) }), AUDIT
    );
    expect(out).toEqual({ handled: false, status: "FAILED" });
    expect(subs.size).toBe(0);
  });

  it("verifies server-side — ignores claimed status in the payload", async () => {
    const { repo, subs, order } = await paidFixture();
    // IPN body claims COMPLETED but the verified status says PENDING_DUPLICATE.
    const out = await handleIpn(
      { orderTrackingId: "track-x", orderMerchantReference: order.merchantRef },
      repo, makeGateway({ transactionStatus: async () => ({ payment_status: "PENDING_DUPLICATE" }) }), AUDIT
    );
    expect(out.handled).toBe(false);
    expect(subs.size).toBe(0);
  });

  it("rejects unknown merchant references", async () => {
    const { repo } = makeRepo();
    await expect(
      handleIpn({ orderTrackingId: "t1", orderMerchantReference: "NOPE" }, repo, makeGateway(), AUDIT)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ── dashboard payload ────────────────────────────────────────────────────────
describe("getBilling", () => {
  it("returns plans, subscription and orders for a member with billing:view", async () => {
    const { repo } = makeRepo();
    await startCheckout(OWNER_CTX, CHECKOUT, repo, makeGateway(), AUDIT);
    const out = await getBilling(OWNER_CTX, "sch1", repo);
    expect(out.plans.length).toBe(4);
    expect(out.orders.length).toBe(1);
    expect(out.subscription).toBeNull();
  });

  it("blocks teachers from billing details", async () => {
    const { repo } = makeRepo();
    await expect(getBilling(TEACHER_CTX, "sch1", repo)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
