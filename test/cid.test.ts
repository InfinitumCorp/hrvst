import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createHrvstServer } from "../src/server.ts";
import { createCidVerifier } from "../src/cid.ts";

const people: Record<string, { cid: string; username: string }> = { "cid-token-ada": { cid: "cid:ada", username: "ada" } };
const fakeIssuer = async (url: string, init?: RequestInit) => {
  assert.equal(url, "https://id.example/api/id/userinfo");
  const token = String((init?.headers as Record<string, string>).authorization).replace("Bearer ", "");
  const p = people[token];
  return p ? new Response(JSON.stringify(p), { status: 200 }) : new Response("{}", { status: 401 });
};

test("the verifier accepts a Cumulus ID token the issuer knows, and caches it", async () => {
  let calls = 0;
  const verify = createCidVerifier("https://id.example/", async (u, i) => (calls++, fakeIssuer(u, i)));
  assert.deepEqual(await verify("cid-token-ada"), { cid: "cid:ada", username: "ada", email: undefined });
  await verify("cid-token-ada");
  assert.equal(calls, 1);
  assert.equal(await verify("nope"), null);
  assert.equal(await verify(""), null);
});

test("people sign in with Cumulus ID and act only as themselves; services keep the token", async () => {
  const server = createHrvstServer("svc", createCidVerifier("https://id.example", fakeIssuer));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ada = { authorization: "Bearer cid-token-ada" };
  try {
    assert.equal((await fetch(`${base}/v1/firm`, { headers: { authorization: "Bearer stranger" } })).status, 401);
    const mine = await (await fetch(`${base}/v1/firm`, { headers: ada })).json();
    assert.deepEqual(mine.account, { owner: "cid:ada", credits: 0, settlement: "pending" });
    assert.equal((await fetch(`${base}/v1/firm?owner=cid:someone-else`, { headers: ada })).status, 403);
    const cap = await fetch(`${base}/v1/captures`, {
      method: "POST",
      headers: { ...ada, "content-type": "application/json" },
      body: JSON.stringify({ note: "corner shop", placeLabel: "Main St", placeClass: "retail" }),
    });
    assert.equal(cap.status, 201);
    assert.equal((await cap.json()).owner, "cid:ada");
    const svc = await (await fetch(`${base}/v1/firm?owner=cid:field`, { headers: { authorization: "Bearer svc" } })).json();
    assert.equal(svc.account.owner, "cid:field");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
