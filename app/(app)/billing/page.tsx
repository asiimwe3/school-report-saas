"use client";
import { useEffect, useState } from "react";
import { get, post } from "@/src/lib/client";
import { useMe } from "@/src/lib/useMe";

interface Plan {
  id: string; name: string; priceUgx: number; maxStudents: number | null; maxStaff: number;
  description: string; features: string[];
}
interface BillingResp {
  plans: Plan[];
  subscription: { plan: string; status: string; currentPeriodEnd: string | null; maxStudents: number | null } | null;
  orders: { merchantRef: string; plan: string; amount: number; status: string; paidAt: string | null }[];
  gatewayConfigured: boolean;
  billingModel: string;
}

const fmt = (ugx: number) => `UGX ${ugx.toLocaleString("en-UG")}`;

export default function BillingPage() {
  const { me, schoolId } = useMe();
  const [data, setData] = useState<BillingResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    if (!schoolId) return;
    try {
      const d = await get<BillingResp>(`/api/billing?schoolId=${schoolId}`);
      setData(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load billing");
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  async function checkout(planId: string) {
    setBusy(planId);
    setErr(null);
    try {
      const res = await post<{ redirectUrl: string }>("/api/billing/checkout", { schoolId, planId });
      window.location.href = res.redirectUrl;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Checkout failed");
      setBusy(null);
    }
  }

  const role = me?.schools.find((s) => s.id === schoolId)?.role;
  const canPay = role === "SCHOOL_OWNER" || role === "BURSAR";
  const currentPlan = data?.subscription?.plan;

  if (!data) return <p className="sub">{err ?? "Loading…"}</p>;

  return (
    <>
      <h1>Billing</h1>
      <p className="sub">{data.billingModel}</p>

      {data.subscription && (
        <div className="banner" style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 22,
          background: data.subscription.status === "ACTIVE" ? "linear-gradient(135deg,#0f2f24,#12331f)" : "var(--panel)",
          border: data.subscription.status === "ACTIVE" ? "1px solid #1f4a37" : "1px solid var(--line)",
          borderRadius: 14, padding: "16px 20px" }}>
          <span className="dot" style={{ width: 10, height: 10, borderRadius: "50%",
            background: data.subscription.status === "ACTIVE" ? "var(--ok)" : "var(--warn)",
            boxShadow: data.subscription.status === "ACTIVE" ? "0 0 12px var(--ok)" : "none" }}></span>
          <div>
            <b>{data.subscription.plan.replace("_", " ")} — {data.subscription.status}</b>
            {data.subscription.currentPeriodEnd && (
              <div style={{ color: "var(--muted)", fontSize: 13 }}>
                Active until {new Date(data.subscription.currentPeriodEnd).toLocaleDateString("en-GB")}
              </div>
            )}
          </div>
        </div>
      )}

      {err && <div className="err">{err}</div>}
      {notice && <div style={{ color: "var(--ok)", fontSize: 14, marginBottom: 12 }}>{notice}</div>}
      {!data.gatewayConfigured && (
        <div className="err" style={{ marginBottom: 12 }}>
          Payments not configured on the server yet (PESAPAL_CONSUMER_KEY/SECRET missing) — checkout is disabled.
        </div>
      )}

      <div className="grid cols">
        {data.plans.map((p) => {
          const isCurrent = currentPlan === p.id;
          return (
            <div key={p.id} className="card" style={{ margin: 0,
              borderColor: p.name === "Growth" ? "var(--accent)" : "var(--line)",
              boxShadow: p.name === "Growth" ? "0 0 40px rgba(59,130,246,.15)" : "none" }}>
              <div style={{ fontSize: 11, letterSpacing: ".08em", color: "var(--muted)", textTransform: "uppercase" }}>
                {p.id === "FREE_TRIAL" ? "Get started" : p.name === "Growth" ? "Most schools" : p.name === "Premium" ? "Large / boarding" : "Small schools"}
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, margin: "6px 0 2px" }}>{p.name}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: "var(--accent2)", margin: "10px 0 2px" }}>
                {p.priceUgx === 0 ? "Free" : fmt(p.priceUgx)}
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>
                {p.priceUgx === 0 ? "14 days, full features" : `per term · ${p.maxStudents === null ? "unlimited" : `up to ${p.maxStudents.toLocaleString()}`} students`}
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {p.features.map((f) => (
                  <li key={f} style={{ fontSize: 13, color: "#c9d6ec", padding: "5px 0 5px 22px", position: "relative" }}>
                    <span style={{ position: "absolute", left: 0, color: "var(--ok)" }}>✓</span>{f}
                  </li>
                ))}
              </ul>
              {p.priceUgx > 0 ? (
                <button className="primary" style={{ marginTop: 16, width: "100%" }}
                  disabled={!canPay || !data.gatewayConfigured || busy === p.id}
                  onClick={() => checkout(p.id)}>
                  {busy === p.id ? "Opening Pesapal…" : isCurrent ? "Renew / current" : "Pay with Pesapal"}
                </button>
              ) : (
                <button className="primary" style={{ marginTop: 16, width: "100%", opacity: 0.4 }} disabled>
                  {isCurrent ? "Current" : "Included"}
                </button>
              )}
              {!canPay && p.priceUgx > 0 && (
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
                  Only the owner or bursar can purchase.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {data.orders.length > 0 && (
        <div className="card" style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Payment history</h2>
          <table>
            <thead>
              <tr><th>Reference</th><th>Plan</th><th>Amount</th><th>Status</th><th>Paid</th></tr>
            </thead>
            <tbody>
              {data.orders.map((o) => (
                <tr key={o.merchantRef}>
                  <td style={{ fontFamily: "monospace", fontSize: 12 }}>{o.merchantRef}</td>
                  <td>{o.plan.replace("_", " ")}</td>
                  <td>{fmt(o.amount)}</td>
                  <td><span className={`badge ${o.status === "PAID" ? "APPROVED" : o.status === "FAILED" ? "LOCKED" : "SUBMITTED"}`}>{o.status}</span></td>
                  <td>{o.paidAt ? new Date(o.paidAt).toLocaleDateString("en-GB") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
