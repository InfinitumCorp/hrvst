import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { getBackend, HrvstError, type PlaceClass } from "./domain.ts";
import { firmSuite } from "./firm.ts";
import { conjureRoutesFromEnv, toWebRequest, sendWebResponse } from "./conjure/conjure.mjs";
import { openClawRoutesFromEnv } from "./openclaw/openclaw.mjs";
import { searchRoutesFromEnv } from "./search/search.mjs";
import { createCidVerifier, type CidProfile } from "./cid.ts";

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
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
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

function place(value: unknown): PlaceClass {
  if (typeof value !== "string" || !PLACES.has(value as PlaceClass)) throw new HrvstError("invalid placeClass");
  return value as PlaceClass;
}

export function createHrvstServer(
  token = process.env.HRVST_API_TOKEN,
  verifyCid: (t: string) => Promise<CidProfile | null> = createCidVerifier(),
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
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (url.pathname === "/healthz") return json(res, 200, { ok: true, product: "hrvst" });
      if (parts[0] !== "v1") throw new HrvstError("not found", 404);
      const who = await caller(req, token, verifyCid);
      if (!who) throw new HrvstError("sign in with Cumulus ID, or send the service token", 401);
      const [, resource, id, action] = parts;

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

      if (resource === "board" && req.method === "GET") return json(res, 200, store.snapshot());

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
        return json(res, 201, capture);
      }

      if (resource === "captures" && id && action === "refine" && req.method === "POST") {
        const body = await readBody(req);
        return json(res, 200, store.refine(id, body.optedIn === true));
      }

      if (resource === "packets" && id && action === "decide" && req.method === "POST") {
        const body = await readBody(req);
        const decision = body.action;
        if (decision !== "keep" && decision !== "list" && decision !== "delete") {
          throw new HrvstError("action must be keep, list, or delete");
        }
        const price = body.priceCredits === undefined ? undefined : Number(body.priceCredits);
        return json(res, 200, store.decide(id, decision, price));
      }

      if (resource === "packets" && id && action === "license" && req.method === "POST") {
        const body = await readBody(req);
        return json(res, 201, store.license(id, String(body.licensee ?? "")));
      }

      if (resource === "packets" && id && action === "signal" && req.method === "POST") {
        return json(res, 202, store.signalArchitect(id));
      }

      if (resource === "missions" && req.method === "POST" && !id) {
        const body = await readBody(req);
        return json(res, 201, store.postMission({
          buyer: ownerFor(who, body.buyer),
          title: String(body.title ?? ""),
          brief: String(body.brief ?? ""),
          rewardCredits: Number(body.rewardCredits),
          placeClass: place(body.placeClass),
        }));
      }

      if (resource === "missions" && id && req.method === "POST") {
        const body = await readBody(req);
        if (action === "claim") return json(res, 200, store.claimMission(id, ownerFor(who, body.owner)));
        if (action === "submit") return json(res, 200, store.submitMission(id, String(body.packetId ?? "")));
        if (action === "accept") return json(res, 200, store.acceptMission(id));
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
