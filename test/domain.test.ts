import assert from "node:assert/strict";
import test from "node:test";
import { CONTRIBUTOR_SHARE_BPS, HrvstBackend, PLATFORM_FEE_BPS, privacyFilter } from "../src/domain.ts";

test("privacy filter redacts contact data and keeps the observation", () => {
  const out = privacyFilter("Call Dana at 415-555-0134 or dana@field.example about the crack.");
  assert.equal(out.text.includes("415"), false);
  assert.equal(out.text.includes("@"), false);
  assert.ok(out.redactions.includes("email"));
  assert.ok(out.redactions.includes("phone"));
});

test("restricted places never become packets", () => {
  const store = new HrvstBackend();
  const capture = store.capture({
    owner: "cid:field",
    note: "Kitchen window latch is loose and the room is visible.",
    placeLabel: "Home",
    placeClass: "home_interior",
  });
  const refined = store.refine(capture.id);
  assert.equal(refined.capture.status, "excluded");
  assert.equal(refined.packet, undefined);
  assert.equal(store.packets.size, 0);
});

test("restricted places become packets when the owner opts in", () => {
  const store = new HrvstBackend();
  const capture = store.capture({
    owner: "cid:field",
    note: "Kitchen window latch is loose and the room is visible.",
    placeLabel: "Home",
    placeClass: "home_interior",
  });
  const refined = store.refine(capture.id, true);
  assert.equal(refined.capture.status, "refined");
  assert.equal(refined.packet?.permittedUses[0], "restricted:home_interior");
});

test("license pays the contributor 85 percent and records proof", () => {
  const store = new HrvstBackend();
  store.credit("cid:buyer", 200, "seed");
  const capture = store.capture({
    owner: "cid:field",
    note: "Missing facing on the oat milk shelf, aisle six, no people present.",
    placeLabel: "Aisle 6",
    placeClass: "retail",
  });
  const { packet } = store.refine(capture.id);
  assert.ok(packet);
  store.decide(packet.id, "list", 100);
  const grant = store.license(packet.id, "cid:buyer");
  assert.equal(grant.contributorCredits, 85);
  assert.equal(grant.platformCredits, 15);
  assert.equal(store.balance("cid:field"), 85);
  assert.equal(store.balance("cid:buyer"), 100);
  assert.equal(PLATFORM_FEE_BPS + CONTRIBUTOR_SHARE_BPS, 10_000);
  assert.equal(packet.proof.length, 64);
  assert.equal(packet.previousProof, null);
});

test("mission acceptance cannot be spent twice", () => {
  const store = new HrvstBackend();
  store.credit("cid:buyer", 50, "seed");
  const capture = store.capture({
    owner: "cid:field",
    note: "Curb ramp at the library doors is blocked by a temporary sign board.",
    placeLabel: "Library",
    placeClass: "public_building",
  });
  const { packet } = store.refine(capture.id);
  assert.ok(packet);
  store.decide(packet.id, "keep");
  const mission = store.postMission({
    buyer: "cid:buyer",
    title: "Library ramp",
    brief: "Confirm the ramp is clear.",
    rewardCredits: 40,
    placeClass: "public_building",
  });
  store.claimMission(mission.id, "cid:field");
  store.submitMission(mission.id, packet.id);
  store.acceptMission(mission.id);
  assert.throws(() => store.acceptMission(mission.id));
  assert.equal(store.balance("cid:field"), 34);
});

test("architect signal requires an owner decision first", () => {
  const store = new HrvstBackend();
  const capture = store.capture({
    owner: "cid:field",
    note: "Raised sidewalk slab outside the library doors.",
    placeLabel: "Library approach",
    placeClass: "street",
  });
  const { packet } = store.refine(capture.id);
  assert.ok(packet);
  assert.throws(() => store.signalArchitect(packet.id));
  store.decide(packet.id, "keep");
  const signal = store.signalArchitect(packet.id);
  assert.equal(signal.type, "fault");
  assert.match(signal.goal, /approval/);
});
