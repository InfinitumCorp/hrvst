import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createHrvstServer } from "../src/server.ts";
import { APP_CSP, webAppConfigFromEnv } from "../src/web-app.ts";

test("the web app is served with a strict CSP and the configured Cumulus ID client", async () => {
  const server = createHrvstServer("svc", async () => null);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-security-policy"), APP_CSP);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    const html = await page.text();
    assert.match(html, /data-client="hrvst"/);
    assert.match(html, /data-issuer="https:\/\/id\.cumuluscloud\.app"/);
    assert.doesNotMatch(html, /\{\{/, "every placeholder is filled");
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/, "no inline scripts");

    for (const [path, type] of [["/app/app.js", "text/javascript"], ["/app/cumulus-id.js", "text/javascript"], ["/app/style.css", "text/css"]]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", new RegExp(type));
    }
    for (const path of ["/app/index.html", "/app/../server.ts", "/app/%2e%2e/server.ts", "/app/", "/app/nope.js"]) {
      assert.notEqual((await fetch(`${base}${path}`)).status, 200, path);
    }
    // The API still needs a sign-in.
    assert.equal((await fetch(`${base}/v1/board`)).status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("client and issuer come from the environment; the issuer can be a mirror", () => {
  assert.deepEqual(webAppConfigFromEnv({ HRVST_CID_CLIENT: "hrvst-ru", CID_ISSUER: "https://ru.id.cumuluscloud.app/" }), {
    cidClient: "hrvst-ru",
    cidIssuer: "https://ru.id.cumuluscloud.app",
  });
});
