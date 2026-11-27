import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { HrvstBackend, getBackend } from "../src/domain.ts";
import { createHrvstServer } from "../src/server.ts";
import { createCidVerifier } from "../src/cid.ts";

function submitted(s: HrvstBackend) {
  s.credit("cid:buyer", 500, "top up");
  const m = s.postMission({ buyer: "cid:buyer", title: "Ramps", brief: "", rewardCredits: 40, placeClass: "street" });
  s.claimMission(m.id, "cid:field");
  const cap = s.capture({ owner: "cid:field", note: "Kerb ramp missing at the north crossing.", placeLabel: "North crossing", placeClass: "street" });
  const packet = s.refine(cap.id).packet!;
  s.decide(packet.id, "keep");
  s.submitMission(m.id, packet.id, "cid:field");
  return { m, packet };
}

test("the buyer previews a submission without seeing the observation", () => {
  const s = new HrvstBackend();
  const { m, packet } = submitted(s);
  const preview = s.submissionPreview(m.id, "cid:buyer");
  assert.deepEqual(preview, {
    missionId: m.id,
    placeLabel: "North crossing",
    quality: packet.quality,
    permittedUses: ["inspection", "research"],
    createdAt: packet.createdAt,
    rejectedBefore: 0,
  });
  assert.equal(JSON.stringify(preview).includes("Kerb ramp"), false);
  assert.throws(() => s.submissionPreview(m.id, "cid:field"), /buyer/);
  assert.throws(() => s.submissionPreview(m.id, "cid:stranger"), /buyer/);

  s.rejectMission(m.id, "cid:buyer");
  assert.throws(() => s.submissionPreview(m.id, "cid:buyer"), /no submission/);
});

test("GET /v1/missions/:id/submission answers only the buyer", async () => {
  const people: Record<string, string> = { "t-buyer": "cid:buyer", "t-field": "cid:field" };
  const verify = createCidVerifier("https://id.example", async (_url, init) => {
    const token = String(new Headers(init?.headers).get("authorization")).replace(/^Bearer /, "");
    const cid = people[token];
    return new Response(JSON.stringify(cid ? { cid, username: cid } : {}), { status: cid ? 200 : 401 });
  });
  const { m } = submitted(getBackend());
  const server = createHrvstServer("svc", verify);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const get = (token: string) => fetch(`${base}/v1/missions/${m.id}/submission`, { headers: { authorization: `Bearer ${token}` } });
    const ok = await get("t-buyer");
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).placeLabel, "North crossing");
    assert.equal((await get("t-field")).status, 403);

    // Replies to mission actions name nobody else either.
    const other = getBackend().postMission({ buyer: "cid:buyer", title: "Benches", brief: "", rewardCredits: 10, placeClass: "street" });
    const claim = await fetch(`${base}/v1/missions/${other.id}/claim`, { method: "POST", headers: { authorization: "Bearer t-field", "content-type": "application/json" }, body: "{}" });
    assert.equal(claim.status, 200);
    const claimed = await claim.json();
    assert.deepEqual([claimed.buyer, claimed.claimer], ["anonymous", "cid:field"]);
    const svc = await fetch(`${base}/v1/missions/${other.id}/release`, { method: "POST", headers: { authorization: "Bearer svc", "content-type": "application/json" }, body: "{}" });
    assert.equal((await svc.json()).buyer, "cid:buyer", "a service still sees everything");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
