// @search in [HRVST]: the /v1/search route behind the API token; off until a search engine is configured.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

let hrvst: Server;
let base = "";

before(async () => {
  for (const k of ["SEARXNG_URL", "YANDEX_SEARCH_API_KEY", "YANDEX_FOLDER_ID", "BRAVE_SEARCH_API_KEY"]) delete process.env[k];
  const { createHrvstServer } = await import("../src/server.ts");
  hrvst = createHrvstServer("api-token");
  await new Promise<void>((r) => hrvst.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(hrvst.address() as AddressInfo).port}`;
});
after(() => hrvst.close());

const H = { authorization: "Bearer api-token", "content-type": "application/json" };

test("@search needs the API token and an owner", async () => {
  assert.equal((await fetch(`${base}/v1/search?owner=cid_1`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(`${base}/v1/search`, { method: "POST", headers: H, body: JSON.stringify({ query: "q" }) })).status, 401);
});

test("@search is off until a search engine is configured", async () => {
  const get = await (await fetch(`${base}/v1/search?owner=cid_1`, { headers: H })).json();
  assert.deepEqual(get, { connected: false, engines: [], answers: false });
  assert.equal((await fetch(`${base}/v1/search?owner=cid_1`, { method: "POST", headers: H, body: JSON.stringify({ query: "q" }) })).status, 503);
});
