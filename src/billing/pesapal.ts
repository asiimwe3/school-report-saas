/**
 * Pesapal client — same endpoints DeryCare uses (RequestToken, RegisterIPN,
 * SubmitOrderRequest, GetTransactionStatus). Env:
 *   PESAPAL_CONSUMER_KEY / PESAPAL_CONSUMER_SECRET  — from the Pesapal dashboard
 *   PESAPAL_ENV — "demo" (default) or "live"
 *   APP_BASE_URL — public origin of THIS app, used to build the callback/IPN URLs
 */
const base = () => {
  const env = (process.env.PESAPAL_ENV ?? "demo").toLowerCase();
  return env === "live" || env === "production"
    ? "https://pay.pesapal.com"
    : "https://demo.pesapal.com";
};

const FT = { signal: AbortSignal.timeout(20_000), headers: { Accept: "application/json" } } as const;

export class PesapalError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "PesapalError";
  }
}

export function isConfigured(): boolean {
  return Boolean(process.env.PESAPAL_CONSUMER_KEY && process.env.PESAPAL_CONSUMER_SECRET);
}

/** Fetches a fresh API token (short-lived — never cached across requests). */
export async function token(): Promise<string> {
  const res = await fetch(`${base()}/api/Auth/RequestToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...FT.headers },
    body: JSON.stringify({
      consumer_key: process.env.PESAPAL_CONSUMER_KEY,
      consumer_secret: process.env.PESAPAL_CONSUMER_SECRET,
    }),
    signal: FT.signal,
  });
  const d = (await res.json().catch(() => ({}))) as { token?: string; error?: { message?: string } };
  if (!res.ok || !d.token) {
    throw new PesapalError(d.error?.message ?? `Pesapal auth failed (${res.status})`, res.status);
  }
  return d.token;
}

let cachedIpn: { id: string; url: string } | null = null;

/** Registers (or re-uses) the IPN URL Pesapal should notify on payment. */
export async function registerIpn(t: string, ipnUrl: string): Promise<string> {
  if (cachedIpn?.url === ipnUrl) return cachedIpn.id;
  const res = await fetch(`${base()}/api/URLSetup/RegisterIPN`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", ...FT.headers },
    body: JSON.stringify({ url: ipnUrl, ipn_notification_type: "POST" }),
    signal: FT.signal,
  });
  const d = (await res.json().catch(() => ({}))) as { ipn_id?: string; error?: { message?: string } };
  if (!res.ok || !d.ipn_id) {
    throw new PesapalError(d.error?.message ?? `IPN registration failed (${res.status})`, res.status);
  }
  cachedIpn = { id: d.ipn_id, url: ipnUrl };
  return d.ipn_id;
}

export interface SubmitOrderInput {
  merchantRef: string;
  amount: number;
  description: string;
  callbackUrl: string;
  ipnId: string;
  email: string;
  phone?: string;
  firstName: string;
  lastName?: string;
}

export interface SubmitOrderResult {
  orderTrackingId: string;
  redirectUrl: string;
}

/** Creates a Pesapal order and returns the hosted-checkout redirect URL. */
export async function submitOrder(t: string, input: SubmitOrderInput): Promise<SubmitOrderResult> {
  const res = await fetch(`${base()}/api/Transactions/SubmitOrderRequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", ...FT.headers },
    body: JSON.stringify({
      id: input.merchantRef,
      currency: "UGX",
      amount: input.amount,
      description: input.description,
      callback_url: input.callbackUrl,
      notification_id: input.ipnId,
      first_name: input.firstName,
      last_name: input.lastName ?? "-",
      email_address: input.email,
      phone_number: input.phone,
      billing_address: {
        address_1: "Uganda",
        city: "Kampala",
        country: "UG",
        first_name: input.firstName,
        last_name: input.lastName ?? "-",
        email_address: input.email,
      },
    }),
    signal: FT.signal,
  });
  const d = (await res.json().catch(() => ({}))) as {
    order_tracking_id?: string;
    redirect_url?: string;
    error?: { message?: string };
  };
  if (!res.ok || !d.order_tracking_id || !d.redirect_url) {
    throw new PesapalError(d.error?.message ?? `Order submission failed (${res.status})`, res.status);
  }
  return { orderTrackingId: d.order_tracking_id, redirectUrl: d.redirect_url };
}

export interface TransactionStatus {
  /** Pesapal value: PENDING_DUPLICATE | INVALID | FAILED | COMPLETED */
  payment_status: string;
  payment_method?: string;
  confirmation_code?: string;
  amount?: number;
}

export async function transactionStatus(t: string, orderTrackingId: string): Promise<TransactionStatus> {
  const res = await fetch(
    `${base()}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`,
    { headers: { Authorization: `Bearer ${t}`, ...FT.headers }, signal: FT.signal }
  );
  const d = (await res.json().catch(() => ({}))) as TransactionStatus & { error?: { message?: string } };
  if (!res.ok || !d.payment_status) {
    throw new PesapalError(d.error?.message ?? `Status check failed (${res.status})`, res.status);
  }
  return d;
}
