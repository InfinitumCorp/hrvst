import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { CLAIM_TIMEOUT_MS, ESCROW, HrvstBackend } from "../src/domain.ts";
import { createHrvstServer } from "../src/server.ts";
import { createCidVerifier } from "../src/cid.ts";
import { deliverPending } from "../examples/architect-signal.ts";

function keptPacket(store: HrvstBackend, owner: string, note = "Pothole at the crossing, about a hand wide.") {
  const cap = store.capture({ owner, note, placeLabel: "Crossing", placeClass: "street" });
  const { packet } = store.refine(cap.id);
  store.decide(packet!.id, "keep");
  return packet!;
}

function postedMission(store: HrvstBackend) {
  store.credit("cid:buyer", 100, "top up");
  return store.postMission({ buyer: "cid:buyer", title: "Potholes", brief: "", rewardCredits: 100, placeClass: "street" });
}

test("the buyer can reject a submission; the mission reopens and the reward stays held", () => {
  const store = new HrvstBackend();
  const mission = postedMission(store);
  const packet = keptPacket(store, "cid:field");
  store.claimMission(mission.id, "cid:field");
  store.submitMission(mission.id, packet.id);
  assert.throws(() => store.rejectMission(mission.id, "cid:field"), /only the buyer/);
  store.rejectMission(mission.id, "cid:buyer");
  assert.equal(mission.status, "open");
  assert.equal(mission.claimer, undefined);
  assert.equal(store.balance(ESCROW), 100);
  // The same packet cannot be sent back in; a new one can.
  store.claimMission(mission.id, "cid:field");
  assert.throws(() => store.submitMission(mission.id, packet.id), /turned this packet down/);
  store.submitMission(mission.id, keptPacket(store, "cid:field", "Second pothole, wider, by the bus lane.").id);
  store.acceptMission(mission.id, "cid:buyer");
  assert.equal(store.balance("cid:field"), 85);
});

test("the claimer can release a mission they cannot finish", () => {
  const store = new HrvstBackend();
  const mission = postedMission(store);
  store.claimMission(mission.id, "cid:field");
  assert.throws(() => store.releaseMission(mission.id, "cid:other"), /only the claimer/);
  store.releaseMission(mission.id, "cid:field");
  assert.equal(mission.status, "open");
  store.claimMission(mission.id, "cid:other");
  assert.equal(mission.claimer, "cid:other");
});

test("the buyer may cancel a claim left without a submission for 7 days", () => {
  const store = new HrvstBackend();
  const mission = postedMission(store);
  store.claimMission(mission.id, "cid:field");
  assert.throws(() => store.cancelMission(mission.id, "cid:buyer"), /7 days/);
  mission.claimedAt = new Date(Date.now() - CLAIM_TIMEOUT_MS - 1000).toISOString();
  store.cancelMission(mission.id, "cid:buyer");
  assert.equal(mission.status, "cancelled");
  assert.equal(store.balance("cid:buyer"), 100);
});

test("a buyer cannot pay twice for the same packet", () => {
  const store = new HrvstBackend();
  store.credit("cid:buyer", 100, "top up");
  const packet = keptPacket(store, "cid:field");
  store.decide(packet.id, "list", 20);
  store.license(packet.id, "cid:buyer");
  assert.throws(() => store.license(packet.id, "cid:buyer"), /already holds/);
  assert.equal(store.balance("cid:buyer"), 80);
});

test("top-ups need a real account, a whole positive amount, and a reason", () => {
  const store = new HrvstBackend();
  assert.equal(store.topUp("cid:buyer", 250, "invoice 17"), 250);
  assert.throws(() => store.topUp("cid:buyer", -5, "x"), /at least 1/);
  assert.throws(() => store.topUp("cid:buyer", 2.5, "x"), /whole number/);
  assert.throws(() => store.topUp("escrow", 5, "x"), /account is required/);
  assert.throws(() => store.topUp("cid:buyer", 5, " "), /reason/);
});

test("over HTTP, top-ups and signal delivery are for services only, and the bridge marks faults delivered", async () => {
  const verify = createCidVerifier("https://id.example", async () => new Response(JSON.stringify({ cid: "cid:ada", username: "ada" }), { status: 200 }));
  const hrvst = createHrvstServer("svc", verify);
  const runs: unknown[] = [];
  const architect = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      runs.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ runId: `run_${runs.length}` }));
    });
  });
  await new Promise<void>((r) => hrvst.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => architect.listen(0, "127.0.0.1", r));
  const hrvstUrl = `http://127.0.0.1:${(hrvst.address() as AddressInfo).port}`;
  const architectUrl = `http://127.0.0.1:${(architect.address() as AddressInfo).port}`;
  const post = (path: string, token: string, body: unknown = {}) =>
    fetch(`${hrvstUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post("/v1/credits", "t-ada", { account: "cid:ada", credits: 1000, reason: "free money" })).status, 403);
    const topped = await post("/v1/credits", "svc", { account: "cid:ada", credits: 40, reason: "invoice 1" });
    assert.deepEqual(await topped.json(), { account: "cid:ada", balance: 40 });

    const board = await (await fetch(`${hrvstUrl}/v1/board`, { headers: { authorization: "Bearer svc" } })).json();
    const packet = board.packets.find((p: { status: string }) => p.status === "private");
    const signal = await (await post(`/v1/packets/${packet.id}/signal`, "svc")).json();
    assert.equal((await post(`/v1/signals/${signal.id}/delivered`, "t-ada")).status, 403);

    const delivered = await deliverPending({ hrvstUrl, architectUrl, hrvstToken: "svc" });
    assert.deepEqual(delivered, [signal.id]);
    assert.equal(runs.length, 1);
    const after = await (await fetch(`${hrvstUrl}/v1/board`, { headers: { authorization: "Bearer svc" } })).json();
    const marked = after.signals.find((s: { id: string }) => s.id === signal.id);
    assert.equal(marked.delivered, true);
    assert.equal(marked.architectScoreId, "run_1");
    assert.deepEqual(await deliverPending({ hrvstUrl, architectUrl, hrvstToken: "svc" }), [], "nothing is sent twice");
  } finally {
    await new Promise((r) => hrvst.close(r));
    await new Promise((r) => architect.close(r));
  }
});
