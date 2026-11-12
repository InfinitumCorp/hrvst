// Plans and billing for [HRVST], paid through Stripe via Infinitum's central revenue Worker.
// HRVST never holds a Stripe key. It forwards the signed-in person's Cumulus ID token to the
// revenue Worker, which answers with a Stripe Checkout or customer-portal URL for the product to open.
// REVENUE_URL makes the Worker configurable (for example a mirror that loads in Russia).
// Billing is off when HRVST_BILLING=off; set that on any MIL or defense deployment.

import { HrvstError } from "./domain.ts";

export const DEFAULT_REVENUE_URL = "https://infinitum-revenue.infinitumcorp.workers.dev";
export const PRODUCT = "hrvst";
export const BUYER_PLAN = "hrvst_buyer";

export interface Plan {
  id: string;
  product: string;
  name: string;
  channel: "self_serve" | "sales_assisted" | "contract";
  priceCents: number;
  interval: "month" | "year";
  perSeat?: boolean;
  features?: string[];
  trialDays?: number;
}

export interface Entitlement {
  product: string;
  plan: string;
  status: string;
}

/** What a product shows for one plan: its price and the one button it offers. */
export interface PlanRow {
  id: string;
  name: string;
  price: string;
  features: string[];
  current: boolean;
  /** subscribe = Checkout; business = switch to a business org, then Checkout once Infinitum approves it. */
  action: "current" | "included" | "subscribe" | "business";
  note?: string;
}

export interface PlanCard {
  title: string;
  current: { plan: string; name: string; status: string } | null;
  plans: PlanRow[];
  manageBilling: boolean;
  notice?: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const BUYER_NOTE =
  "Buyer Access is for organisations. HRVST switches your account to a business first. Checkout opens after Infinitum approves the organisation.";

export function formatPrice(p: Pick<Plan, "priceCents" | "interval" | "perSeat">): string {
  if (p.priceCents === 0) return "Free";
  const dollars = (p.priceCents / 100).toLocaleString("en-US", { minimumFractionDigits: p.priceCents % 100 ? 2 : 0 });
  return `$${dollars} / ${p.interval}${p.perSeat ? " per seat" : ""}`;
}

/** The note for a return from Stripe Checkout (`?billing=success|cancelled`). */
export function returnNotice(billing: string | null | undefined): string | undefined {
  if (billing === "success") return "Payment complete. Your plan is active.";
  if (billing === "cancelled") return "Checkout cancelled. No charge was made.";
  return undefined;
}

/** The plan card: HRVST plans from the catalog, with the person's current plan marked. */
export function planCard(catalog: Plan[], current: Entitlement | null, notice?: string): PlanCard {
  const plans = catalog.filter((p) => p.product === PRODUCT && p.channel !== "contract");
  const currentPlan = current ? plans.find((p) => p.id === current.plan) : undefined;
  return {
    title: "Plan and billing",
    current: current ? { plan: current.plan, name: currentPlan?.name ?? current.plan, status: current.status } : null,
    plans: plans.map((p) => {
      const isCurrent = current?.plan === p.id;
      const row: PlanRow = {
        id: p.id,
        name: p.name,
        price: formatPrice(p),
        features: p.features ?? [],
        current: isCurrent,
        action: isCurrent ? "current" : p.priceCents === 0 ? "included" : p.channel === "sales_assisted" ? "business" : "subscribe",
      };
      if (p.channel === "sales_assisted") row.note = BUYER_NOTE;
      return row;
    }),
    manageBilling: !!current && current.status !== "free",
    ...(notice ? { notice } : {}),
  };
}

export class RevenueError extends HrvstError {
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message, status);
    this.code = code;
  }
}

export interface RevenueClient {
  readonly base: string;
  catalog(): Promise<Plan[]>;
  entitlement(token: string): Promise<Entitlement | null>;
  checkout(token: string, planId: string, returnUrl: string, quantity?: number): Promise<{ url: string }>;
  portal(token: string, returnUrl: string): Promise<{ url: string }>;
  becomeBusiness(token: string, name?: string): Promise<unknown>;
}

export function createRevenueClient(base = process.env.REVENUE_URL || DEFAULT_REVENUE_URL, fetchImpl: Fetch = fetch): RevenueClient {
  const root = base.replace(/\/+$/, "");
  async function call<T>(path: string, token: string | null, body?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          accept: "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new RevenueError("billing is unreachable right now", 502);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } | string };
    if (!res.ok) {
      const err = typeof data.error === "object" ? data.error : { message: data.error };
      throw new RevenueError(err?.message || `billing request failed (${res.status})`, res.status >= 500 ? 502 : res.status, err?.code);
    }
    return data as T;
  }
  return {
    base: root,
    async catalog() {
      const c = await call<{ plans?: Plan[] }>("/v1/catalog", null);
      return Array.isArray(c.plans) ? c.plans : [];
    },
    async entitlement(token) {
      const e = await call<{ products?: Entitlement[] }>("/v1/me/entitlements", token);
      return e.products?.find((p) => p.product === PRODUCT) ?? null;
    },
    checkout: (token, planId, returnUrl, quantity) =>
      call<{ url: string }>("/v1/subscriptions/checkout", token, { planId, returnUrl, ...(quantity ? { quantity } : {}) }),
    portal: (token, returnUrl) => call<{ url: string }>("/v1/billing/portal", token, { returnUrl }),
    becomeBusiness: (token, name) => call<unknown>("/v1/me/org", token, { kind: "business", ...(name ? { name } : {}) }),
  };
}

/** True unless this deployment turned billing off (MIL and defense editions). */
export function billingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.HRVST_BILLING ?? "").toLowerCase() !== "off";
}

/** Buyer Access: switch to a business org, then try Checkout. Before approval this is a pending answer, not an error. */
export async function startBuyerAccess(
  client: RevenueClient,
  token: string,
  returnUrl: string,
  orgName?: string,
): Promise<{ status: "checkout"; url: string } | { status: "pending_approval"; message: string }> {
  await client.becomeBusiness(token, orgName);
  try {
    const { url } = await client.checkout(token, BUYER_PLAN, returnUrl);
    return { status: "checkout", url };
  } catch (error) {
    if (error instanceof RevenueError && error.code === "approval_required") {
      return {
        status: "pending_approval",
        message: "Your account is now a business. Buyer Access opens after Infinitum approves the organisation. You will be able to subscribe here then.",
      };
    }
    throw error;
  }
}
