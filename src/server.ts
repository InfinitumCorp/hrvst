import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { getBackend, HrvstError, type PlaceClass } from "./domain.ts";
import { firmSuite } from "./firm.ts";
import { conjureRoutesFromEnv, toWebRequest, sendWebResponse } from "./conjure/conjure.mjs";
import { openClawRoutesFromEnv } from "./openclaw/openclaw.mjs";
import { searchRoutesFromEnv } from "./search/search.mjs";
import { createCidVerifier, type CidProfile } from "./cid.ts";
import { createWebApp } from "./web-app.ts";
import { billingEnabled, createRevenueClient, planCard, returnNotice, startBuyerAccess, BUYER_PLAN, type RevenueClient } from "./billing.ts";

const PLACES = new Set<PlaceClass>([
  "street",
  "retail",
  "field",
  "public_building",
  "private_residence",
  "school",
  "hospital",
  "military",
  "home_interior",
]);

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 200_000) throw new HrvstError("body too large", 413);
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HrvstError("body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HrvstError("body must be an object");
  return parsed as Record<string, unknown>;
}

/** Services send HRVST_API_TOKEN; people send their Cumulus ID token and act only as themselves. */
type Caller = { kind: "service" } | { kind: "person"; profile: CidProfile };

async function caller(req: IncomingMessage, token: string | undefined, verifyCid: (t: string) => Promise<CidProfile | null>): Promise<Caller | null> {
  if (!token) return { kind: "service" };
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(header);
  const b = Buffer.from(token);
  if (a.length === b.length && timingSafeEqual(a, b)) return { kind: "service" };
  const profile = header ? await verifyCid(header) : null;
  return profile ? { kind: "person", profile } : null;
}

/** The owner a call acts for: a person is always their own CID; a service names one. */
function ownerFor(who: Caller, asked: unknown): string {
  if (who.kind === "service") return String(asked ?? "");
  if (asked !== undefined && asked !== null && asked !== "" && asked !== who.profile.cid) throw new HrvstError("you can only act as your own Cumulus ID", 403);
  return who.profile.cid;
}

/** Some routes are for HRVST's own services (the Architect bridge, settlement), never for people. */
function serviceOnly(who: Caller) {
  if (who.kind !== "service") throw new HrvstError("this route is for services", 403);
}

/** The CID a person acts as; undefined for a service, which may act for anyone. */
function actorOf(who: Caller): string | undefined {
  return who.kind === "person" ? who.profile.cid : undefined;
}

function place(value: unknown): PlaceClass {
  if (typeof value !== "string" || !PLACES.has(value as PlaceClass)) throw new HrvstError("invalid placeClass");
  return value as PlaceClass;
}

export function createHrvstServer(
  token = process.env.HRVST_API_TOKEN,
  verifyCid: (t: string) => Promise<CidProfile | null> = createCidVerifier(),
  revenue: RevenueClient | null = billingEnabled() ? createRevenueClient() : null,
): ReturnType<typeof createServer> {
  const store = getBackend();
  // @conjure: POST /v1/conjure { text, context?, source? } and GET /v1/conjure/<ticket>, as ?owner=<CID>.
  const conjure = conjureRoutesFromEnv(process.env, { prefix: "/v1/conjure", source: "hrvst" });
  // @scalvs / @scalus: POST /v1/openclaw { text, context? } asks the SCALVS agent (OpenClaw), as ?owner=<CID>.
  // Off until OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN are set.
  const openclaw = openClawRoutesFromEnv(process.env, { prefix: "/v1/openclaw", product: "hrvst" });
  // @search: POST /v1/search { query } or { text: "@search ..." } — Infinitum Search, a web answer with
  // numbered sources, as ?owner=<CID>. Only the typed question goes out. Off until a search engine is set.
  const search = searchRoutesFromEnv(process.env, { prefix: "/v1/search" });
  // The web app: GET / and /app/*, signed in with Cumulus ID in the browser.
  const web = createWebApp();
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (url.pathname === "/healthz") return json(res, 200, { ok: true, product: "hrvst" });
      if (web(req.method ?? "GET", url.pathname, res)) return;
      if (parts[0] !== "v1") throw new HrvstError("not found", 404);
      const who = await caller(req, token, verifyCid);
      if (!who) throw new HrvstError("sign in with Cumulus ID, or send the service token", 401);
      const [, resource, id, action] = parts;
      const actor = actorOf(who);
      // Every successful change is written to HRVST_DATA_FILE (when set) before the reply goes out.
      const saved = (status: number, data: unknown) => {
        store.save();
        json(res, status, data);
      };

      if (resource === "conjure") {
        const owner = ownerFor(who, url.searchParams.get("owner") ?? "");
        const handled = await conjure(await toWebRequest(req), { user: owner || null });
        if (handled) return void (await sendWebResponse(res, handled));
      }

      if (resource === "openclaw" && !id) {
        const owner = ownerFor(who, url.searchParams.get("owner") ?? "");
        const handled = await openclaw(await toWebRequest(req), { user: owner || null });
        if (handled) return void (await sendWebResponse(res, handled));
      }

      if (resource === "search" && !id) {
        const owner = ownerFor(who, url.searchParams.get("owner") ?? "");
        const handled = await search(await toWebRequest(req), { user: owner || null });
        if (handled) return void (await sendWebResponse(res, handled));
      }

      // Plans and billing for the signed-in person, through the Infinitum revenue Worker (Stripe).
      // HRVST forwards the person's Cumulus ID token; it never holds a Stripe key.
      if (resource === "account" && id === "plan") {
        if (!revenue) throw new HrvstError("not found", 404);
        if (who.kind !== "person") throw new HrvstError("sign in with Cumulus ID to see plans and billing", 403);
        const cidToken = req.headers.authorization!.replace(/^Bearer\s+/i, "");
        if (!action && req.method === "GET") {
          const [catalog, current] = await Promise.all([revenue.catalog(), revenue.entitlement(cidToken)]);
          return json(res, 200, planCard(catalog, current, returnNotice(url.searchParams.get("billing"))));
        }
        if (req.method === "POST" && action) {
          const body = await readBody(req);
          const returnUrl = String(body.returnUrl ?? process.env.HRVST_RETURN_URL ?? "");
          if (!/^https?:\/\//.test(returnUrl)) throw new HrvstError("returnUrl is required");
          if (action === "checkout") {
            const planId = String(body.planId ?? "");
            if (planId === BUYER_PLAN) return json(res, 200, await startBuyerAccess(revenue, cidToken, returnUrl, body.orgName as string | undefined));
            return json(res, 200, { status: "checkout", ...(await revenue.checkout(cidToken, planId, returnUrl)) });
          }
          if (action === "portal") return json(res, 200, await revenue.portal(cidToken, returnUrl));
        }
        throw new HrvstError("not found", 404);
      }

      // A service sees the whole board; a person sees their own silo, credits and grants, and open missions.
      if (resource === "board" && req.method === "GET") return json(res, 200, actor ? store.snapshotFor(actor) : store.snapshot());

      // The market: listed packets without owner or observation. Licensees collect at /v1/grants/:id.
      if (resource === "market" && req.method === "GET" && !id) return json(res, 200, store.market());
      if (resource === "grants" && id && !action && req.method === "GET") return json(res, 200, store.delivery(id, actor));

      // FIRM Suite: FIRM, FIRM Wallet, Firmament Network and $HRVST; with ?owner=, that CID's credits.
      if (resource === "firm" && req.method === "GET" && !id) {
        const owner = ownerFor(who, url.searchParams.get("owner") ?? undefined) || undefined;
        return json(res, 200, firmSuite(owner, owner ? store.balance(owner) : undefined));
      }

      if (resource === "captures" && req.method === "POST" && !id) {
        const body = await readBody(req);
        const capture = store.capture({
          owner: ownerFor(who, body.owner),
          note: String(body.note ?? ""),
          placeLabel: String(body.placeLabel ?? ""),
          placeClass: place(body.placeClass),
          mediaKind: body.mediaKind === "note" ? "note" : "glasses",
        });
        return saved(201, capture);
      }

      if (resource === "captures" && id && action === "refine" && req.method === "POST") {
        const body = await readBody(req);
        return saved(200, store.refine(id, body.optedIn === true, actor));
      }

      if (resource === "packets" && id && action === "decide" && req.method === "POST") {
        const body = await readBody(req);
        const decision = body.action;
        if (decision !== "keep" && decision !== "list" && decision !== "delete") {
          throw new HrvstError("action must be keep, list, or delete");
        }
        const price = body.priceCredits === undefined ? undefined : Number(body.priceCredits);
        return saved(200, store.decide(id, decision, price, actor));
      }

      if (resource === "packets" && id && action === "license" && req.method === "POST") {
        const body = await readBody(req);
        return saved(201, store.license(id, ownerFor(who, body.licensee)));
      }

      if (resource === "packets" && id && action === "signal" && req.method === "POST") {
        return saved(202, store.signalArchitect(id, actor));
      }

      if (resource === "missions" && req.method === "POST" && !id) {
        const body = await readBody(req);
        return saved(201, store.postMission({
          buyer: ownerFor(who, body.buyer),
          title: String(body.title ?? ""),
          brief: String(body.brief ?? ""),
          rewardCredits: Number(body.rewardCredits),
          placeClass: place(body.placeClass),
        }));
      }

      if (resource === "missions" && id && req.method === "POST") {
        const body = await readBody(req);
        if (action === "claim") return saved(200, store.claimMission(id, ownerFor(who, body.owner)));
        if (action === "submit") return saved(200, store.submitMission(id, String(body.packetId ?? ""), actor));
        if (action === "accept") return saved(200, store.acceptMission(id, actor));
        if (action === "cancel") return saved(200, store.cancelMission(id, actor));
        if (action === "release") return saved(200, store.releaseMission(id, actor));
        if (action === "reject") return saved(200, store.rejectMission(id, actor));
      }

      // The Architect bridge marks a fault as handed over, with Architect's run or score id.
      if (resource === "signals" && id && action === "delivered" && req.method === "POST") {
        serviceOnly(who);
        const body = await readBody(req);
        const scoreId = body.architectScoreId === undefined ? undefined : String(body.architectScoreId);
        return saved(200, store.markDelivered(id, scoreId));
      }

      // Settlement issues Harvest Credits once a buyer has paid outside HRVST.
      if (resource === "credits" && !id && req.method === "POST") {
        serviceOnly(who);
        const body = await readBody(req);
        const balance = store.topUp(String(body.account ?? ""), Number(body.credits), String(body.reason ?? ""));
        return saved(200, { account: String(body.account).trim(), balance });
      }

      throw new HrvstError("not found", 404);
    } catch (error) {
      const status = error instanceof HrvstError ? error.status : 500;
      json(res, status, { error: error instanceof Error ? error.message : "failed" });
    }
  });
}

const self = process.argv[1] ?? "";
if (self.endsWith("server.ts") || self.endsWith("server.js")) {
  const port = Number(process.env.PORT ?? 7340);
  createHrvstServer().listen(port, "0.0.0.0", () => {
    console.log(`HRVST listening on ${port}`);
  });
}
