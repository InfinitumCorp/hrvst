import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HrvstBackend, openBackend } from "../src/domain.ts";

function market() {
  const s = new HrvstBackend();
  s.credit("cid:buyer", 500, "top up");
  const packets = ["Cracked kerb at the bus stop.", "Flickering street lamp on Elm.", "Blocked drain by the bakery."].map((note) => {
    const cap = s.capture({ owner: "cid:field", note, placeLabel: "Elm Street", placeClass: "street" });
    const packet = s.refine(cap.id).packet!;
    s.decide(packet.id, "list", 10);
    return packet;
  });
  return { s, packets };
}

test("an untouched chain verifies, with every live packet recomputed", () => {
  const { s } = market();
  const report = s.verifyChain();
  assert.equal(report.ok, true);
  assert.equal(report.packets, 3);
  assert.equal(report.sealed, 3);
  assert.equal(new HrvstBackend().verifyChain().ok, true, "an empty chain holds");
});

test("a buyer's delivery says whether the proof was checked", () => {
  const { s, packets } = market();
  const grant = s.license(packets[1]!.id, "cid:buyer");
  assert.equal(s.delivery(grant.id, "cid:buyer").check, "verified");

  // The contributor deletes it after the sale: the buyer keeps the text, only the link can be checked.
  s.decide(packets[1]!.id, "delete", undefined, "cid:field");
  assert.equal(s.delivery(grant.id, "cid:buyer").check, "linked");
  assert.equal(s.verifyChain().ok, true, "erasing does not break the chain");
  assert.equal(s.verifyChain().sealed, 2);
});

test("edited text, a rewired link or a wrong tip is caught", () => {
  {
    const { s, packets } = market();
    packets[0]!.observation = "Nothing wrong here.";
    assert.deepEqual([s.verifyChain().ok, s.verifyChain().brokenAt], [false, packets[0]!.id]);
  }
  {
    const { s, packets } = market();
    packets[2]!.previousProof = packets[0]!.proof;
    assert.equal(s.verifyChain().reason, "does not link to the packet before it");
    const grant = s.license(packets[0]!.id, "cid:buyer");
    assert.equal(s.delivery(grant.id, "cid:buyer").check, "broken");
  }
  {
    const { s, packets } = market();
    const capture = s.toJSON().captures.find((c) => c.id === packets[1]!.captureId)!;
    const state = s.toJSON();
    state.captures.find((c) => c.id === capture.id)!.note = "Rewritten.";
    state.packets.find((p) => p.id === packets[1]!.id)!.observation = "Rewritten.";
    assert.equal(HrvstBackend.fromJSON(state).verifyChain().reason, "proof does not match its capture");
  }
  {
    const { s } = market();
    const state = s.toJSON();
    state.chainTip = "0".repeat(64);
    assert.equal(HrvstBackend.fromJSON(state).verifyChain().reason, "the stored tip is not the last proof");
  }
});

test("a saved store still verifies after a restart, and a tampered file is reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "hrvst-proof-"));
  const file = join(dir, "hrvst.json");
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => warnings.push(m);
  try {
    const { s } = market();
    s.save(file);
    assert.equal(openBackend(file).verifyChain().ok, true);
    assert.deepEqual(warnings, []);

    const state = JSON.parse(readFileSync(file, "utf8"));
    state.packets[0].observation = "Tampered.";
    writeFileSync(file, JSON.stringify(state));
    assert.equal(openBackend(file).verifyChain().ok, false);
    assert.match(warnings.join("\n"), /proof chain does not hold/);
  } finally {
    console.warn = warn;
    rmSync(dir, { recursive: true, force: true });
  }
});
