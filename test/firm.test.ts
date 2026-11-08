import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { firmSuite } from "../src/firm.ts";
import { createHrvstServer } from "../src/server.ts";

test("firmSuite describes FIRM, FIRM Wallet, Firmament Network and $HRVST", () => {
  const info = firmSuite();
  assert.deepEqual(info.suite, { token: "FIRM", wallet: "FIRM Wallet", network: "Firmament Network" });
  assert.equal(info.product.token, "HRVST");
  assert.equal(info.links.wallet, "https://firmwallet.app/?ref=hrvst");
  assert.equal(info.links.network, "https://firmnetwork.app/?ref=hrvst");
  assert.equal(info.account, undefined);
});

test("firmSuite reports an owner's credits as pending settlement", () => {
  assert.deepEqual(firmSuite("cid:field", 42).account, { owner: "cid:field", credits: 42, settlement: "pending" });
});

test("GET /v1/firm serves the suite and the caller's Harvest Credits", async () => {
  const server = createHrvstServer("t0k3n");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/v1/firm`)).status, 401);
    const auth = { authorization: "Bearer t0k3n" };
    const plain = await (await fetch(`${base}/v1/firm`, { headers: auth })).json();
    assert.equal(plain.settlesThrough, "FIRM");
    assert.equal(plain.account, undefined);
    const mine = await (await fetch(`${base}/v1/firm?owner=cid:nobody`, { headers: auth })).json();
    assert.deepEqual(mine.account, { owner: "cid:nobody", credits: 0, settlement: "pending" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
