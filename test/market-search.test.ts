import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { HrvstBackend } from "../src/domain.ts";
import { createHrvstServer } from "../src/server.ts";

function listed(store: HrvstBackend, note: string, placeLabel: string, price: number) {
  const cap = store.capture({ owner: "cid:field", note, placeLabel, placeClass: "street" });
  const packet = store.refine(cap.id).packet!;
  store.decide(packet.id, "list", price);
  return packet;
}

test("the market filters by place, quality, price and use, and sorts", () => {
  const store = new HrvstBackend();
  const library = listed(store, "Ramp blocked by a sign board at the library doors today.", "City Library", 50);
  const aisle = listed(store, "Empty shelf.", "Aisle 6", 10);
  const station = listed(store, "Broken ticket machine on platform two, screen dark, card slot taped over.", "North Station", 30);
  assert.ok(library.quality > aisle.quality);

  assert.deepEqual(store.market({ q: "LIBRARY" }).map((l) => l.id), [library.id]);
  assert.deepEqual(store.market({ maxPrice: 30 }).map((l) => l.id).sort(), [aisle.id, station.id].sort());
  assert.ok(store.market({ minQuality: 0.6 }).every((l) => l.quality >= 0.6));
  assert.equal(store.market({ use: "research" }).length, 3);
  assert.equal(store.market({ use: "advertising" }).length, 0);
  assert.deepEqual(store.market({ sort: "cheapest" }).map((l) => l.priceCredits), [10, 30, 50]);
  const best = store.market({ sort: "quality" }).map((l) => l.quality);
  assert.deepEqual(best, [...best].sort((a, b) => b - a));
});

test("over HTTP, blank filters are ignored and bad ones are a 400", async () => {
  const server = createHrvstServer("svc", async () => null);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (q: string) => fetch(`${base}/v1/market${q}`, { headers: { authorization: "Bearer svc" } });
  try {
    assert.equal((await get("?q=&maxPrice=&minQuality=&sort=")).status, 200);
    assert.equal((await get("?sort=cheapest&maxPrice=100")).status, 200);
    for (const bad of ["?minQuality=2", "?maxPrice=0", "?maxPrice=abc", "?sort=random", `?q=${"x".repeat(121)}`]) {
      assert.equal((await get(bad)).status, 400, bad);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
