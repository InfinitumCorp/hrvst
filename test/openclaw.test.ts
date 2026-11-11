// @scalvs / @scalus in [HRVST]: the /v1/openclaw route behind the API token, against a fake OpenClaw gateway.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

let gateway: Server;
let hrvst: Server;
let base = "";
const seen: any[] = [];

before(async () => {
  gateway = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.headers.authorization !== "Bearer claw_hrvst_test") return void res.writeHead(401).end("{}");
    seen.push(JSON.parse(body));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Two missions match your silo." } }] }));
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
  process.env.OPENCLAW_GATEWAY_URL = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  process.env.OPENCLAW_GATEWAY_TOKEN = "claw_hrvst_test";
  process.env.OPENCLAW_AGENT = "openclaw/hrvst";
  const { createHrvstServer } = await import("../src/server.ts");
  hrvst = createHrvstServer("api-token");
  await new Promise<void>((r) => hrvst.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(hrvst.address() as AddressInfo).port}`;
});
after(() => { hrvst.close(); gateway.close(); });

const H = { authorization: "Bearer api-token", "content-type": "application/json" };
const ask = (text: string, owner = "cid_1") => fetch(`${base}/v1/openclaw?owner=${owner}`, { method: "POST", headers: H, body: JSON.stringify({ text }) });

test("@scalvs needs the API token and an owner", async () => {
  assert.equal((await fetch(`${base}/v1/openclaw?owner=cid_1`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/v1/openclaw`, { method: "POST", headers: H, body: JSON.stringify({ text: "@scalvs q" }) })).status, 401);
});

test("@scalvs and @scalus reach the SCALVS agent as the owner", async () => {
  const r = await (await ask("@scalvs which missions fit my silo?")).json();
  assert.deepEqual(r, { mention: true, text: "Two missions match your silo.", agent: "openclaw/hrvst" });
  assert.equal(seen.at(-1).model, "openclaw/hrvst");
  assert.equal(seen.at(-1).user, "hrvst:cid_1");
  assert.equal(seen.at(-1).messages.at(-1).content, "which missions fit my silo?");
  assert.equal((await (await ask("@scalus and now?")).json()).mention, true);
});

test("@openclaw and plain notes don't trigger", async () => {
  assert.deepEqual(await (await ask("@openclaw which missions?")).json(), { mention: false });
  assert.deepEqual(await (await ask("plain note")).json(), { mention: false });
});

test("status shows no gateway URL or token", async () => {
  const body = await (await fetch(`${base}/v1/openclaw?owner=cid_1`, { headers: H })).text();
  assert.deepEqual(JSON.parse(body), { connected: true, agent: "openclaw/hrvst" });
  assert.ok(!body.includes("claw_hrvst_test"));
  assert.ok(!body.includes("127.0.0.1"));
});
