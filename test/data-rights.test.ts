import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { ESCROW, HrvstBackend } from "../src/domain.ts";
import { createHrvstServer } from "../src/server.ts";
import { createCidVerifier } from "../src/cid.ts";

function packetFor(store: HrvstBackend, owner: string, note: string) {
  const cap = store.capture({ owner, note, placeLabel: "Corner of 4th", placeClass: "street" });
  return { cap, packet: store.refine(cap.id).packet! };
}

test("deleting a packet wipes the words but keeps the proof", () => {
  const store = new HrvstBackend();
  const { cap, packet } = packetFor(store, "cid:field", "Cracked kerb by the bakery.");
  const proof = packet.proof;
  store.decide(packet.id, "delete");
  assert.equal(packet.status, "retired");
  assert.equal(packet.observation, "");
  assert.equal(packet.proof, proof);
  assert.equal(cap.note, "");
  assert.equal(cap.placeLabel, "deleted");
  assert.equal(cap.status, "deleted");
});

test("a buyer who already paid keeps their copy after the owner deletes", () => {
  const store = new HrvstBackend();
  store.credit("cid:buyer", 100, "top up");
  const { packet } = packetFor(store, "cid:field", "Cracked kerb by the bakery.");
  store.decide(packet.id, "list", 10);
  const grant = store.license(packet.id, "cid:buyer");
  store.decide(packet.id, "delete");
  assert.equal(store.delivery(grant.id, "cid:buyer").packet.observation, "Cracked kerb by the bakery.");
  assert.equal(store.market().length, 0);
});

test("erasing an account wipes captures and packets, refunds open missions and gives back claims", () => {
  const store = new HrvstBackend();
  store.credit("cid:ada", 100, "top up");
  store.credit("cid:other", 100, "top up");
  packetFor(store, "cid:ada", "First observation.");
  const { packet: listed } = packetFor(store, "cid:ada", "Second observation.");
  store.decide(listed.id, "list", 10);
  const restricted = store.capture({ owner: "cid:ada", note: "Inside my flat.", placeLabel: "Home", placeClass: "home_interior" });
  store.refine(restricted.id);
  const posted = store.postMission({ buyer: "cid:ada", title: "Mine", brief: "", rewardCredits: 40, placeClass: "street" });
  const claimed = store.postMission({ buyer: "cid:other", title: "Theirs", brief: "", rewardCredits: 30, placeClass: "street" });
  store.claimMission(claimed.id, "cid:ada");
  const untouched = packetFor(store, "cid:other", "Someone else's observation.");

  const done = store.eraseAccount("cid:ada");
  assert.deepEqual(done, { captures: 1, packets: 2, missionsCancelled: 1, missionsReleased: 1 });
  const mine = store.snapshotFor("cid:ada");
  assert.ok(mine.captures.every((c) => c.note === "" && c.status === "deleted"));
  assert.ok(mine.packets.every((p) => p.observation === "" && p.status === "retired"));
  assert.equal(posted.status, "cancelled");
  assert.equal(claimed.status, "open");
  assert.equal(store.balance("cid:ada"), 100, "credits stay");
  assert.equal(store.balance(ESCROW), 30);
  assert.equal(untouched.packet.observation, "Someone else's observation.");
  assert.deepEqual(store.eraseAccount("cid:ada"), { captures: 0, packets: 0, missionsCancelled: 0, missionsReleased: 0 }, "erasing twice is a no-op");
});

test("over HTTP a person exports and erases only their own data, and must confirm", async () => {
  const verify = createCidVerifier("https://id.example", async () => new Response(JSON.stringify({ cid: "cid:ada", username: "ada" }), { status: 200 }));
  const server = createHrvstServer("svc", verify);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ada = { authorization: "Bearer t-ada", "content-type": "application/json" };
  try {
    await fetch(`${base}/v1/captures`, { method: "POST", headers: ada, body: JSON.stringify({ note: "Bent railing on the bridge.", placeLabel: "Bridge", placeClass: "street" }) });
    const exp = await fetch(`${base}/v1/me/export`, { headers: ada });
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get("content-disposition") ?? "", /attachment/);
    const data = await exp.json();
    assert.equal(data.owner, "cid:ada");
    assert.equal(data.captures.length, 1);
    assert.ok(data.captures.every((c: { owner: string }) => c.owner === "cid:ada"));
    assert.equal((await fetch(`${base}/v1/me/export?owner=cid:field`, { headers: ada })).status, 403);

    assert.equal((await fetch(`${base}/v1/me/erase`, { method: "POST", headers: ada, body: "{}" })).status, 400);
    assert.equal((await fetch(`${base}/v1/me/erase`, { method: "POST", headers: ada, body: JSON.stringify({ confirm: "erase", owner: "cid:field" }) })).status, 403);
    const erased = await fetch(`${base}/v1/me/erase`, { method: "POST", headers: ada, body: JSON.stringify({ confirm: "erase" }) });
    assert.equal(erased.status, 200);
    assert.equal((await erased.json()).captures, 1);
    const after = await (await fetch(`${base}/v1/me/export`, { headers: ada })).json();
    assert.equal(after.captures[0].note, "");
    // The seeded field packet belongs to someone else and is untouched.
    const board = await (await fetch(`${base}/v1/board`, { headers: { authorization: "Bearer svc" } })).json();
    assert.ok(board.packets.some((p: { owner: string; observation: string }) => p.owner === "cid:field" && p.observation));
  } finally {
    await new Promise((r) => server.close(r));
  }
});
