import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { HrvstBackend, LIMITS } from "../src/domain.ts";
import { createHrvstServer } from "../src/server.ts";

const long = (n: number) => "x".repeat(n + 1);

test("over-long fields and out-of-range credits are refused", () => {
  const store = new HrvstBackend();
  store.credit("cid:buyer", 100, "top up");
  assert.throws(() => store.capture({ owner: "cid:a", note: "ok", placeLabel: long(LIMITS.label), placeClass: "street" }), /placeLabel is too long/);
  assert.throws(() => store.capture({ owner: long(LIMITS.id), note: "ok", placeLabel: "x", placeClass: "street" }), /owner is too long/);
  const mission = (over: Partial<{ title: string; brief: string; rewardCredits: number }>) =>
    store.postMission({ buyer: "cid:buyer", title: "t", brief: "", rewardCredits: 10, placeClass: "street", ...over });
  assert.throws(() => mission({ title: long(LIMITS.title) }), /title is too long/);
  assert.throws(() => mission({ brief: long(LIMITS.brief) }), /brief is too long/);
  assert.throws(() => mission({ rewardCredits: LIMITS.credits + 1 }), /cannot exceed/);
  assert.throws(() => mission({ rewardCredits: Number.NaN }), /at least 1/);
  assert.equal(store.balance("cid:buyer"), 100, "a refused mission holds nothing");

  const cap = store.capture({ owner: "cid:a", note: "Loose drain cover by the kerb.", placeLabel: "Kerb", placeClass: "street" });
  const packet = store.refine(cap.id).packet!;
  assert.throws(() => store.decide(packet.id, "list", LIMITS.credits + 1), /cannot exceed/);
  store.decide(packet.id, "list", 10);
  assert.throws(() => store.license(packet.id, ""), /licensee is required/);
  assert.throws(() => store.topUp("cid:buyer", LIMITS.credits + 1, "x"), /cannot exceed/);
});

test("a malformed JSON body is a 400, not a server error", async () => {
  const server = createHrvstServer("svc", async () => null);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/v1/captures`, {
      method: "POST",
      headers: { authorization: "Bearer svc", "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not valid JSON/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
