import assert from "node:assert/strict";
import test from "node:test";
import { ANONYMOUS, HrvstBackend } from "../src/domain.ts";

test("a person's board never names the other people they deal with", () => {
  const s = new HrvstBackend();
  s.credit("cid:buyer", 500, "top up");
  const cap = s.capture({ owner: "cid:field", note: "Pothole by the tram stop.", placeLabel: "Tram stop", placeClass: "street" });
  const packet = s.refine(cap.id).packet!;
  s.decide(packet.id, "list", 30);
  s.license(packet.id, "cid:buyer");
  const open = s.postMission({ buyer: "cid:buyer", title: "Ramps", brief: "", rewardCredits: 20, placeClass: "street" });
  const claimed = s.postMission({ buyer: "cid:buyer", title: "Benches", brief: "", rewardCredits: 20, placeClass: "street" });
  s.claimMission(claimed.id, "cid:field");

  const field = s.snapshotFor("cid:field");
  const text = JSON.stringify(field);
  assert.equal(text.includes("cid:buyer"), false, "the contributor does not learn who bought or who posted");
  assert.equal(field.grants[0]!.licensee, ANONYMOUS);
  assert.equal(field.grants[0]!.contributorCredits, 25, "but does see what the sale earned");
  assert.equal(field.missions.find((m) => m.id === claimed.id)!.claimer, "cid:field", "their own name stays");

  const other = s.snapshotFor("cid:other");
  assert.equal(/cid:(buyer|field)/.test(JSON.stringify(other)), false, "a stranger sees open missions with no names");
  assert.equal(other.missions.find((m) => m.id === open.id)!.buyer, ANONYMOUS);

  const buyer = s.snapshotFor("cid:buyer");
  assert.equal(JSON.stringify(buyer).includes("cid:field"), false, "the buyer does not learn who claimed");
  assert.equal(buyer.grants[0]!.licensee, "cid:buyer");

  // The store itself is untouched.
  assert.equal(s.snapshot().grants[0]!.licensee, "cid:buyer");
  assert.equal(claimed.buyer, "cid:buyer");
});
