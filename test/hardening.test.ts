import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { getBackend } from "../src/domain.ts";
import { createHrvstServer, createRateLimiter } from "../src/server.ts";
import { createCidVerifier } from "../src/cid.ts";

test("the rate limiter counts reads and writes separately and resets each minute", () => {
  let t = 0;
  const allow = createRateLimiter(3, 2, () => t);
  assert.equal(allow("cid:a", true), true);
  assert.equal(allow("cid:a", true), true);
  assert.equal(allow("cid:a", true), false, "third write in the minute is refused");
  assert.equal(allow("cid:a", false), true, "reads have their own budget");
  assert.equal(allow("cid:b", true), true, "budgets are per person");
  t = 60_000;
  assert.equal(allow("cid:a", true), true, "a new minute starts fresh");
  const unlimited = createRateLimiter(0, 0, () => t);
  for (let i = 0; i < 1000; i++) assert.equal(unlimited("cid:a", true), true);
});

async function withServer(fn: (base: string) => Promise<void>) {
  const verify = createCidVerifier("https://id.example", async () => new Response(JSON.stringify({ cid: "cid:ada", username: "ada" }), { status: 200 }));
  const server = createHrvstServer("svc", verify);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("API replies are never cached, a person is rate limited, and a service is not", async () => {
  process.env.HRVST_RATE_WRITES = "3";
  try {
    await withServer(async (base) => {
      const board = await fetch(`${base}/v1/board`, { headers: { authorization: "Bearer t-ada" } });
      assert.equal(board.headers.get("cache-control"), "no-store");
      assert.equal(board.headers.get("x-content-type-options"), "nosniff");
      const health = await (await fetch(`${base}/healthz`)).json();
      assert.equal(health.storage, "memory");

      const post = (token: string) =>
        fetch(`${base}/v1/captures`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ note: "Loose paving stone.", placeLabel: "Square", placeClass: "street", owner: "cid:ada" }),
        });
      for (let i = 0; i < 3; i++) assert.equal((await post("t-ada")).status, 201);
      const limited = await post("t-ada");
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "60");
      for (let i = 0; i < 5; i++) assert.equal((await post("svc")).status, 201, "services are not limited");
    });
  } finally {
    delete process.env.HRVST_RATE_WRITES;
  }
});

test("an unexpected failure is a plain 500 that does not reveal internals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hrvst-"));
  const store = getBackend();
  const before = store.file;
  store.file = dir; // renaming a file over a folder fails
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/v1/captures`, {
        method: "POST",
        headers: { authorization: "Bearer svc", "content-type": "application/json" },
        body: JSON.stringify({ owner: "cid:x", note: "Leaning lamp post.", placeLabel: "Corner", placeClass: "street" }),
      });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.deepEqual(body, { error: "internal error" });
      assert.equal(JSON.stringify(body).includes(dir), false);
    });
  } finally {
    store.file = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
