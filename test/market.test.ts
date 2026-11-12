import assert from "node:assert/strict";
import test from "node:test";
import { ESCROW, HrvstBackend } from "../src/domain.ts";

function listedPacket(store: HrvstBackend, owner = "cid:field") {
  const cap = store.capture({ owner, note: "Broken bench slat at the bus shelter.", placeLabel: "Shelter 9", placeClass: "street" });
  const { packet } = store.refine(cap.id);
  store.decide(packet!.id, "list", 20);
  return packet!;
}

test("posting a mission holds the reward until acceptance", () => {
  const store = new HrvstBackend();
  store.credit("cid:buyer", 100, "top up");
  const first = store.postMission({ buyer: "cid:buyer", title: "Ramps", brief: "", rewardCredits: 70, placeClass: "street" });
  assert.equal(store.balance("cid:buyer"), 30);
  assert.equal(store.balance(ESCROW), 70);
  // The same credits cannot back a second mission.
  assert.throws(() => store.postMission({ buyer: "cid:buyer", title: "More", brief: "", rewardCredits: 70, placeClass: "street" }), /cannot cover/);

  const packet = listedPacket(store);
  store.claimMission(first.id, "cid:field");
  store.submitMission(first.id, packet.id);
  store.acceptMission(first.id);
  assert.equal(store.balance(ESCROW), 0);
  assert.equal(store.balance("cid:field"), 59);
  assert.equal(store.balance("platform"), 11);
});

test("the buyer can cancel an open mission and gets the reward back", () => {
  const store = new HrvstBackend();
  store.credit("cid:buyer", 50, "top up");
  const mission = store.postMission({ buyer: "cid:buyer", title: "Shelf", brief: "", rewardCredits: 50, placeClass: "retail" });
  assert.throws(() => store.cancelMission(mission.id, "cid:other"), /only the buyer/);
  store.cancelMission(mission.id, "cid:buyer");
  assert.equal(mission.status, "cancelled");
  assert.equal(store.balance("cid:buyer"), 50);
  assert.equal(store.balance(ESCROW), 0);
  assert.throws(() => store.claimMission(mission.id, "cid:field"), /not open/);
  assert.throws(() => store.cancelMission(mission.id, "cid:buyer"), /only an open mission/);
});

test("a claimed mission cannot be cancelled out from under the claimer", () => {
  const store = new HrvstBackend();
  store.credit("cid:buyer", 50, "top up");
  const mission = store.postMission({ buyer: "cid:buyer", title: "Shelf", brief: "", rewardCredits: 50, placeClass: "retail" });
  store.claimMission(mission.id, "cid:field");
  assert.throws(() => store.cancelMission(mission.id, "cid:buyer"), /only an open mission/);
});

test("missions cannot ask for restricted places", () => {
  const store = new HrvstBackend();
  store.credit("cid:buyer", 500, "top up");
  for (const placeClass of ["private_residence", "school", "hospital", "military", "home_interior"] as const) {
    assert.throws(() => store.postMission({ buyer: "cid:buyer", title: "x", brief: "", rewardCredits: 10, placeClass }), /cannot ask for/);
  }
  assert.equal(store.balance("cid:buyer"), 500);
});

test("the market shows listings without owner or observation", () => {
  const store = new HrvstBackend();
  const packet = listedPacket(store);
  const kept = store.capture({ owner: "cid:field", note: "Kept for myself.", placeLabel: "Home street", placeClass: "street" });
  store.decide(store.refine(kept.id).packet!.id, "keep");
  const market = store.market();
  assert.equal(market.length, 1);
  assert.equal(market[0].id, packet.id);
  assert.equal(market[0].priceCredits, 20);
  assert.equal("owner" in market[0], false);
  assert.equal("observation" in market[0], false);
});

test("only the licensee collects the packet, and the contributor stays anonymous", () => {
  const store = new HrvstBackend();
  store.credit("cid:buyer", 100, "top up");
  const packet = listedPacket(store);
  const grant = store.license(packet.id, "cid:buyer");
  const got = store.delivery(grant.id, "cid:buyer");
  assert.equal(got.packet.observation, packet.observation);
  assert.equal(got.packet.proof, packet.proof);
  assert.equal("owner" in got.packet, false);
  assert.equal("captureId" in got.packet, false);
  assert.throws(() => store.delivery(grant.id, "cid:field"), /only the licensee/);
  assert.throws(() => store.delivery("grn_missing", "cid:buyer"), /not found/);
  assert.equal(store.delivery(grant.id).grant.id, grant.id, "a service can fetch any delivery");
});
