// @conjure in [HRVST]: the /v1/conjure routes behind the API token, against a fake Conjure service.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

let conjure: Server;
let hrvst: Server;
let base = "";
const seen: any[] = [];

before(async () => {
  conjure = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.headers.authorization !== "Bearer cjp_hrvst_test") return void res.writeHead(401).end("{}");
    const p = { id: "pr_1", product: "hrvst", question: "will the pilot convert?", agents: 8, rounds: 2, stats: [], createdAt: "2026-11-08T00:00:00Z", poles: { for: "it converts", against: "no" } };
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") { seen.push(JSON.parse(body)); return void res.writeHead(202).end(JSON.stringify({ ...p, status: "queued", round: 0 })); }
    res.end(JSON.stringify({ ...p, status: "done", round: 2, report: { outcome: "Converts.", probability: 0.7, confidence: "medium", forecast: "", drivers: [], signals: [], assumptions: [] } }));
  });
  await new Promise<void>((r) => conjure.listen(0, "127.0.0.1", r));
  process.env.CONJURE_URL = `http://127.0.0.1:${(conjure.address() as AddressInfo).port}`;
  process.env.CONJURE_PRODUCT_KEY = "cjp_hrvst_test";
  const { createHrvstServer } = await import("../src/server.ts");
  hrvst = createHrvstServer("api-token");
  await new Promise<void>((r) => hrvst.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(hrvst.address() as AddressInfo).port}`;
});
after(() => { hrvst.close(); conjure.close(); });

const H = { authorization: "Bearer api-token", "content-type": "application/json" };

test("@conjure needs the API token and an owner", async () => {
  assert.equal((await fetch(`${base}/v1/conjure?owner=cid_1`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/v1/conjure`, { method: "POST", headers: H, body: JSON.stringify({ text: "@conjure q?" }) })).status, 401);
});

test("a note with @conjure starts a forecast the owner can follow", async () => {
  const none = await (await fetch(`${base}/v1/conjure?owner=cid_1`, { method: "POST", headers: H, body: JSON.stringify({ text: "plain note" }) })).json();
  assert.deepEqual(none, { mention: false });
  const r = await (await fetch(`${base}/v1/conjure?owner=cid_1`, { method: "POST", headers: H, body: JSON.stringify({ text: "Footfall is up. @conjure will the pilot convert?" }) })).json();
  assert.equal(r.mention, true);
  assert.equal(seen[0].question, "will the pilot convert?");
  assert.equal(seen[0].source, "hrvst");
  const live = await (await fetch(`${base}/v1/conjure/${r.ticket}?owner=cid_1`, { headers: H })).json();
  assert.match(live.text, /70% likely that it converts/);
  assert.equal((await fetch(`${base}/v1/conjure/${r.ticket}?owner=cid_2`, { headers: H })).status, 404);
});
