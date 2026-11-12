import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createHrvstServer } from "../src/server.ts";
import { billingEnabled, createRevenueClient, formatPrice, planCard, type Plan } from "../src/billing.ts";

const PLANS: Plan[] = [
  { id: "hrvst_free", product: "hrvst", name: "[HRVST] Free", channel: "self_serve", priceCents: 0, interval: "month" },
  { id: "hrvst_pro", product: "hrvst", name: "[HRVST] Pro Contributor", channel: "self_serve", priceCents: 999, interval: "month", features: ["priority_missions"] },
  { id: "hrvst_buyer", product: "hrvst", name: "[HRVST] Buyer Access", channel: "sales_assisted", priceCents: 49900, interval: "month" },
  { id: "eidetic_pro", product: "eidetic", name: "Eidetic Pro", channel: "self_serve", priceCents: 2000, interval: "month" },
];

/** A stand-in for the revenue Worker: records each call and answers like PR infinitum-revenue#23. */
function fakeRevenue(opts: { approved?: boolean } = {}) {
  const calls: { method: string; path: string; auth?: string; body?: Record<string, unknown> }[] = [];
  let kind = "individual";
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, auth: headers.authorization, body });
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (path === "/v1/catalog") return ok({ plans: PLANS });
    if (headers.authorization !== "Bearer cid-token-ada") return new Response(JSON.stringify({ error: { code: "unauthorized", message: "bad token" } }), { status: 401 });
    if (path === "/v1/me/entitlements") return ok({ products: [{ product: "hrvst", plan: "hrvst_free", status: "free" }] });
    if (path === "/v1/me/org") return (kind = String(body.kind)), ok({ id: "org_1", kind });
    if (path === "/v1/billing/portal") return ok({ url: "https://billing.stripe.test/p/1" });
    if (path === "/v1/subscriptions/checkout") {
      if (body.planId === "hrvst_buyer" && (kind !== "business" || !opts.approved)) {
        return new Response(JSON.stringify({ error: { code: "approval_required", message: "needs approval" } }), { status: 403 });
      }
      return ok({ url: `https://checkout.stripe.test/${body.planId}` });
    }
    return new Response("{}", { status: 404 });
  };
  return { calls, client: createRevenueClient("https://revenue.example/", fetchImpl) };
}

const verify = async (t: string) => (t === "cid-token-ada" ? { cid: "cid:ada" } : null);

async function withServer(revenue: ReturnType<typeof fakeRevenue>["client"] | null, run: (base: string) => Promise<void>) {
  const server = createHrvstServer("svc", verify, revenue);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const ada = { authorization: "Bearer cid-token-ada", "content-type": "application/json" };
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = ada) =>
  fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

test("the plan card lists HRVST plans only and marks the current one", () => {
  const card = planCard(PLANS, { product: "hrvst", plan: "hrvst_free", status: "free" });
  assert.deepEqual(card.plans.map((p) => [p.id, p.action, p.price]), [
    ["hrvst_free", "current", "Free"],
    ["hrvst_pro", "subscribe", "$9.99 / month"],
    ["hrvst_buyer", "business", "$499 / month"],
  ]);
  assert.equal(card.current?.name, "[HRVST] Free");
  assert.equal(card.manageBilling, false);
  assert.match(card.plans[2].note ?? "", /after Infinitum approves the organisation/);
  assert.equal(planCard(PLANS, { product: "hrvst", plan: "hrvst_pro", status: "active" }).manageBilling, true);
  assert.equal(formatPrice({ priceCents: 1000, interval: "year", perSeat: true }), "$10 / year per seat");
});

test("billing turns off for MIL and defense deployments", () => {
  assert.equal(billingEnabled({}), true);
  assert.equal(billingEnabled({ HRVST_BILLING: "off" }), false);
});

test("a person sees the plan card, with their Cumulus ID token sent to the revenue Worker", async () => {
  const rev = fakeRevenue();
  await withServer(rev.client, async (base) => {
    const card = await (await fetch(`${base}/v1/account/plan?billing=success`, { headers: ada })).json();
    assert.equal(card.current.plan, "hrvst_free");
    assert.equal(card.plans.length, 3);
    assert.equal(card.notice, "Payment complete. Your plan is active.");
    const ent = rev.calls.find((c) => c.path === "/v1/me/entitlements");
    assert.equal(ent?.auth, "Bearer cid-token-ada");
    assert.equal(rev.calls.find((c) => c.path === "/v1/catalog")?.auth, undefined);
    // Services and strangers do not get a plan card.
    assert.equal((await fetch(`${base}/v1/account/plan`, { headers: { authorization: "Bearer svc" } })).status, 403);
    assert.equal((await fetch(`${base}/v1/account/plan`, { headers: { authorization: "Bearer nope" } })).status, 401);
  });
});

test("Subscribe opens Checkout and Manage billing opens the portal", async () => {
  const rev = fakeRevenue();
  await withServer(rev.client, async (base) => {
    const returnUrl = "https://hrvst.example/account";
    const co = await (await post(base, "/v1/account/plan/checkout", { planId: "hrvst_pro", returnUrl })).json();
    assert.deepEqual(co, { status: "checkout", url: "https://checkout.stripe.test/hrvst_pro" });
    assert.deepEqual(rev.calls.at(-1)?.body, { planId: "hrvst_pro", returnUrl });
    const portal = await (await post(base, "/v1/account/plan/portal", { returnUrl })).json();
    assert.equal(portal.url, "https://billing.stripe.test/p/1");
    assert.equal((await post(base, "/v1/account/plan/checkout", { planId: "hrvst_pro" })).status, 400);
  });
});

test("Buyer Access switches to business first and waits for Infinitum's approval", async () => {
  const pending = fakeRevenue();
  await withServer(pending.client, async (base) => {
    const res = await post(base, "/v1/account/plan/checkout", { planId: "hrvst_buyer", returnUrl: "https://hrvst.example/a", orgName: "Ada Ltd" });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.status, "pending_approval");
    assert.match(out.message, /after Infinitum approves the organisation/);
    const paths = pending.calls.map((c) => c.path).filter((p) => p !== "/v1/catalog");
    assert.deepEqual(paths, ["/v1/me/org", "/v1/subscriptions/checkout"]);
    assert.deepEqual(pending.calls[0].body, { kind: "business", name: "Ada Ltd" });
  });
  const approved = fakeRevenue({ approved: true });
  await withServer(approved.client, async (base) => {
    const out = await (await post(base, "/v1/account/plan/checkout", { planId: "hrvst_buyer", returnUrl: "https://hrvst.example/a" })).json();
    assert.deepEqual(out, { status: "checkout", url: "https://checkout.stripe.test/hrvst_buyer" });
  });
});

test("with billing off the account plan routes do not exist", async () => {
  await withServer(null, async (base) => {
    assert.equal((await fetch(`${base}/v1/account/plan`, { headers: ada })).status, 404);
  });
});
