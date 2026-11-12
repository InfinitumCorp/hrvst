import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { HrvstBackend, openBackend } from "../src/domain.ts";
import { createHrvstServer } from "../src/server.ts";
import { createCidVerifier } from "../src/cid.ts";

test("a data file keeps captures, credits and the proof chain across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "hrvst-"));
  const file = join(dir, "data", "hrvst.json");
  try {
    const first = openBackend(file);
    assert.equal(first.captures.size, 0, "a new data file starts empty, without demo data");
    first.credit("cid:buyer", 100, "top up");
    const cap = first.capture({ owner: "cid:field", note: "Cracked kerb at the bus stop.", placeLabel: "Stop 4", placeClass: "street" });
    const { packet } = first.refine(cap.id);
    first.decide(packet!.id, "list", 30);
    first.license(packet!.id, "cid:buyer");
    first.save();

    const second = openBackend(file);
    assert.deepEqual(second.snapshot(), first.snapshot());
    assert.equal(second.balance("cid:field"), 25);
    assert.equal(second.balance("cid:buyer"), 70);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

    // The chain continues from the saved tip, not from genesis.
    const next = second.capture({ owner: "cid:field", note: "Second kerb crack nearby.", placeLabel: "Stop 5", placeClass: "street" });
    assert.equal(second.refine(next.id).packet?.previousProof, packet!.proof);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown data version is refused instead of silently reset", () => {
  assert.throws(() => HrvstBackend.fromJSON({ version: 2 } as never), /unknown HRVST data version/);
});

test("people act only on what they own and see only their own silo", async () => {
  const verify = createCidVerifier("https://id.example", async (_u, init) => {
    const token = String((init?.headers as Record<string, string>).authorization).replace("Bearer ", "");
    const who = token === "t-ada" ? { cid: "cid:ada", username: "ada" } : token === "t-field" ? { cid: "cid:field", username: "field" } : null;
    return who ? new Response(JSON.stringify(who), { status: 200 }) : new Response("{}", { status: 401 });
  });
  const server = createHrvstServer("svc", verify);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  const post = (path: string, token: string, body: unknown = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: as(token), body: JSON.stringify(body) });
  try {
    const full = await (await fetch(`${base}/v1/board`, { headers: as("svc") })).json();
    const fieldPacket = full.packets.find((p: { owner: string }) => p.owner === "cid:field");
    const mission = full.missions.find((m: { buyer: string }) => m.buyer === "cid:retail");
    assert.ok(fieldPacket && mission);

    const adaBoard = await (await fetch(`${base}/v1/board`, { headers: as("t-ada") })).json();
    assert.equal(adaBoard.packets.length, 0);
    assert.equal(adaBoard.captures.some((c: { owner: string }) => c.owner !== "cid:ada"), false);
    assert.deepEqual(Object.keys(adaBoard.balances), ["cid:ada"]);
    assert.ok(adaBoard.missions.length > 0, "open missions stay visible");

    assert.equal((await post(`/v1/packets/${fieldPacket.id}/decide`, "t-ada", { action: "delete" })).status, 403);
    assert.equal((await post(`/v1/packets/${fieldPacket.id}/signal`, "t-ada")).status, 403);
    assert.equal((await post(`/v1/packets/${fieldPacket.id}/license`, "t-ada", { licensee: "cid:auditor" })).status, 403);
    const capture = full.captures.find((c: { owner: string }) => c.owner === "cid:field");
    assert.equal((await post(`/v1/captures/${capture.id}/refine`, "t-ada")).status, 403);

    // Ada claims the mission; only she may submit, and only the buyer may accept.
    assert.equal((await post(`/v1/missions/${mission.id}/claim`, "t-ada")).status, 200);
    assert.equal((await post(`/v1/missions/${mission.id}/submit`, "t-field", { packetId: fieldPacket.id })).status, 403);
    const cap = await (await post("/v1/captures", "t-ada", { note: "Oat milk facings empty in aisle six.", placeLabel: "Aisle 6", placeClass: "retail" })).json();
    const refined = await (await post(`/v1/captures/${cap.id}/refine`, "t-ada")).json();
    assert.equal((await post(`/v1/packets/${refined.packet.id}/decide`, "t-ada", { action: "keep" })).status, 200);
    assert.equal((await post(`/v1/missions/${mission.id}/submit`, "t-ada", { packetId: refined.packet.id })).status, 200);
    assert.equal((await post(`/v1/missions/${mission.id}/accept`, "t-ada")).status, 403);
    assert.equal((await post(`/v1/missions/${mission.id}/accept`, "svc")).status, 200);

    const after = await (await fetch(`${base}/v1/board`, { headers: as("t-ada") })).json();
    assert.equal(after.balances["cid:ada"], 51);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the server writes each change to HRVST_DATA_FILE", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hrvst-"));
  const file = join(dir, "hrvst.json");
  const store = openBackend(file);
  try {
    store.credit("cid:field", 0, "open");
    const cap = store.capture({ owner: "cid:field", note: "Leaning signpost.", placeLabel: "Corner", placeClass: "street" });
    store.save();
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.captures[0].id, cap.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
