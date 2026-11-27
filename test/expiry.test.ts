import assert from "node:assert/strict";
import test from "node:test";
import { ESCROW, HrvstBackend } from "../src/domain.ts";

const DAY = 24 * 60 * 60 * 1000;

function store() {
  const s = new HrvstBackend();
  s.credit("cid:buyer", 500, "top up");
  return s;
}

test("missions accept an optional deadline of 1 to 90 days", () => {
  const s = store();
  const m = s.postMission({ buyer: "cid:buyer", title: "Ramps", brief: "", rewardCredits: 10, placeClass: "street", deadlineDays: 3 });
  const due = new Date(m.deadline!).getTime();
  assert.ok(Math.abs(due - (Date.now() + 3 * DAY)) < 5_000);
  assert.equal(s.postMission({ buyer: "cid:buyer", title: "No deadline", brief: "", rewardCredits: 10, placeClass: "street" }).deadline, undefined);
  for (const bad of [0, 91, 1.5, -1]) {
    assert.throws(() => s.postMission({ buyer: "cid:buyer", title: "x", brief: "", rewardCredits: 10, placeClass: "street", deadlineDays: bad }), /1 to 90/);
  }
});

test("the sweep lapses open and claimed missions past their deadline and refunds the buyer", () => {
  const s = store();
  const open = s.postMission({ buyer: "cid:buyer", title: "Open", brief: "", rewardCredits: 100, placeClass: "street", deadlineDays: 1 });
  const claimed = s.postMission({ buyer: "cid:buyer", title: "Claimed", brief: "", rewardCredits: 50, placeClass: "street", deadlineDays: 1 });
  const submitted = s.postMission({ buyer: "cid:buyer", title: "Submitted", brief: "", rewardCredits: 30, placeClass: "street", deadlineDays: 1 });
  const later = s.postMission({ buyer: "cid:buyer", title: "Later", brief: "", rewardCredits: 20, placeClass: "street", deadlineDays: 30 });
  s.claimMission(claimed.id, "cid:field");
  s.claimMission(submitted.id, "cid:field");
  const cap = s.capture({ owner: "cid:field", note: "Broken bollard.", placeLabel: "Lane", placeClass: "street" });
  const packet = s.refine(cap.id).packet!;
  s.decide(packet.id, "keep");
  s.submitMission(submitted.id, packet.id);
  assert.equal(s.balance("cid:buyer"), 300);

  assert.deepEqual(s.sweep(Date.now() + 2 * DAY), { packetsRetired: 0, missionsLapsed: 2 });
  assert.equal(open.status, "cancelled");
  assert.equal(claimed.status, "cancelled");
  assert.equal(submitted.status, "submitted", "a submission waits for the buyer");
  assert.equal(later.status, "open");
  assert.equal(s.balance("cid:buyer"), 450);
  assert.equal(s.balance(ESCROW), 50);
  assert.deepEqual(s.sweep(Date.now() + 2 * DAY), { packetsRetired: 0, missionsLapsed: 0 }, "a second sweep changes nothing");
});

test("nobody can claim or submit once the deadline has passed, even before the sweep runs", () => {
  const s = store();
  const m = s.postMission({ buyer: "cid:buyer", title: "Soon", brief: "", rewardCredits: 10, placeClass: "street", deadlineDays: 1 });
  m.deadline = new Date(Date.now() - 1000).toISOString();
  assert.throws(() => s.claimMission(m.id, "cid:field"), /deadline has passed/);
});

test("the sweep retires expired packets but keeps the owner's text", () => {
  const s = store();
  const cap = s.capture({ owner: "cid:field", note: "Faded crossing paint.", placeLabel: "Crossing", placeClass: "street" });
  const packet = s.refine(cap.id).packet!;
  s.decide(packet.id, "list", 10);
  assert.deepEqual(s.sweep(Date.now() + 181 * DAY), { packetsRetired: 1, missionsLapsed: 0 });
  assert.equal(packet.status, "retired");
  assert.equal(packet.observation, "Faded crossing paint.");
  assert.equal(s.market().length, 0);
  assert.throws(() => s.license(packet.id, "cid:buyer"), /not listed/);
});
