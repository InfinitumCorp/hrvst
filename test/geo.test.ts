import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HrvstBackend } from "../src/domain.ts";
import { GeoDataError, geoIndexFromBuffers, loadGeoIndex } from "../src/geo.ts";
import { clientAddress, formatGeoLog, geoRoutingNote, headerHost, openGeoHook, type GeoHook } from "../src/geo-hook.ts";
import { createHrvstServer } from "../src/server.ts";
import { applyGeoRoutingFlag, loadSettings, saveSettings, type HrvstSettings } from "../src/settings.ts";
import {
  fetchLockedDatasets,
  loadGeoLock,
  parseSha256Sum,
  type GeoDatasetLock,
  type GeoFetch,
  type GeoLockfile,
} from "../scripts/fetch-geo.ts";
import { cidr, sampleGeoIp, sampleGeoSite } from "./geo-fixture.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GEOIP_SHA = "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2";
const GEOSITE_SHA = "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "hrvst-geo-"));
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function pinnedDataset(id: "geoip" | "geosite", hash: string): GeoDatasetLock {
  if (id === "geoip") {
    const tag = "202611080027";
    const prefix = `https://github.com/v2fly/geoip/releases/download/${tag}/`;
    return {
      id,
      filename: "geoip.dat",
      project: "v2fly/geoip",
      tag,
      asset: "geoip.dat",
      license: "CC-BY-SA-4.0",
      url: `${prefix}geoip.dat`,
      sha256Url: `${prefix}geoip.dat.sha256sum`,
      sha256: hash,
    };
  }
  const tag = "20261108011013";
  const prefix = `https://github.com/v2fly/domain-list-community/releases/download/${tag}/`;
  return {
    id,
    filename: "geosite.dat",
    project: "v2fly/domain-list-community",
    tag,
    asset: "dlc.dat",
    license: "MIT",
    url: `${prefix}dlc.dat`,
    sha256Url: `${prefix}dlc.dat.sha256sum`,
    sha256: hash,
  };
}

function responseFor(url: string, text: string, body: Buffer | null, finalUrl = url): Awaited<ReturnType<GeoFetch>> {
  return {
    ok: true,
    status: 200,
    url: finalUrl,
    async text() {
      return text;
    },
    body: body ? (Readable.toWeb(Readable.from([body])) as ReadableStream<Uint8Array>) : null,
  };
}

test("lockfile pins the v2fly releases and their SHA-256 digests", () => {
  const lock = loadGeoLock(path.join(root, "geo.lock.json"));
  const geoip = lock.datasets.find((dataset) => dataset.id === "geoip");
  const geosite = lock.datasets.find((dataset) => dataset.id === "geosite");
  assert.equal(geoip?.sha256, GEOIP_SHA);
  assert.equal(geoip?.tag, "202611080027");
  assert.equal(geoip?.asset, "geoip.dat");
  assert.equal(geoip?.filename, "geoip.dat");
  assert.equal(geoip?.license, "CC-BY-SA-4.0");
  assert.equal(geosite?.sha256, GEOSITE_SHA);
  assert.equal(geosite?.tag, "20261108011013");
  assert.equal(geosite?.asset, "dlc.dat");
  assert.equal(geosite?.filename, "geosite.dat");
  assert.equal(geosite?.license, "MIT");
  assert.match(lock.note ?? "", /GPL-3/);
  for (const dataset of lock.datasets) {
    assert.match(dataset.url, /^https:\/\/github\.com\/v2fly\//);
    assert.doesNotMatch(`${dataset.url} ${dataset.sha256Url}`, /loyalsoldier|sing-?box/i);
  }
  const ignored = spawnSync("git", ["check-ignore", "data/geoip.dat", "data/geosite.dat", "data/geoip.dat.partial"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(ignored.status, 0);
  assert.match(ignored.stdout, /data\/geoip\.dat/);
  assert.match(ignored.stdout, /data\/geosite\.dat/);
  assert.match(ignored.stdout, /data\/geoip\.dat\.partial/);
});

test("official sha256sum text is matched by asset name", () => {
  const other = "a".repeat(64);
  const text = `${other}  other.dat\n${GEOIP_SHA.toUpperCase()}  geoip.dat\n`;
  assert.equal(parseSha256Sum(text, "geoip.dat"), GEOIP_SHA);
  assert.throws(() => parseSha256Sum(`${other}  other.dat\n${GEOSITE_SHA}  extra.dat\n`, "geoip.dat"), /no matching filename/);
});

test("fetch stops when the official sha256sum does not match the lockfile", async () => {
  const dir = tempDir();
  const geoip = Buffer.from("geoip-bytes");
  const geosite = Buffer.from("geosite-bytes");
  const lock: GeoLockfile = {
    version: 1,
    datasets: [pinnedDataset("geoip", sha256(geoip)), pinnedDataset("geosite", sha256(geosite))],
  };
  const calls: string[] = [];
  const fetchImpl: GeoFetch = async (url) => {
    calls.push(url);
    const dataset = lock.datasets.find((item) => item.sha256Url === url || item.url === url);
    assert.ok(dataset);
    if (url === dataset.sha256Url) {
      return responseFor(url, `${"b".repeat(64)}  ${dataset.asset}\n`, null);
    }
    return responseFor(url, "", Buffer.from("should-not-download"));
  };
  await assert.rejects(
    () => fetchLockedDatasets({ lock, outDir: dir, fetchImpl }),
    /checksum mismatch for geoip\.dat: official sha256sum/,
  );
  assert.equal(calls.some((url) => url.endsWith("/geoip.dat")), false);
  assert.equal(existsSync(path.join(dir, "geoip.dat")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("fetch stops when the download does not match the official sha256sum", async () => {
  const dir = tempDir();
  const geoip = Buffer.from("geoip-bytes");
  const geosite = Buffer.from("geosite-bytes");
  const lock: GeoLockfile = {
    version: 1,
    datasets: [pinnedDataset("geoip", sha256(geoip)), pinnedDataset("geosite", sha256(geosite))],
  };
  const fetchImpl: GeoFetch = async (url) => {
    const dataset = lock.datasets.find((item) => item.sha256Url === url || item.url === url);
    assert.ok(dataset);
    if (url === dataset.sha256Url) return responseFor(url, `${dataset.sha256}  ${dataset.asset}\n`, null);
    return responseFor(url, "", Buffer.from(dataset.id === "geoip" ? "tampered" : geosite));
  };
  await assert.rejects(
    () => fetchLockedDatasets({ lock, outDir: dir, fetchImpl }),
    /checksum mismatch for geoip\.dat: downloaded sha256/,
  );
  assert.equal(existsSync(path.join(dir, "geoip.dat")), false);
  assert.equal(existsSync(path.join(dir, "geoip.dat.partial")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("fetch refuses a redirected host and a non-v2fly dataset", async () => {
  const dir = tempDir();
  const body = Buffer.from("x");
  const lock: GeoLockfile = {
    version: 1,
    datasets: [pinnedDataset("geoip", sha256(body)), pinnedDataset("geosite", sha256(body))],
  };
  const fetchImpl: GeoFetch = async (url) => responseFor(url, `${sha256(body)}  geoip.dat\n`, null, "https://evil.example/sum");
  await assert.rejects(() => fetchLockedDatasets({ lock, outDir: dir, fetchImpl }), /refusing download host evil\.example/);

  const bad = tempDir();
  const badLock = {
    version: 1,
    datasets: [
      pinnedDataset("geoip", GEOIP_SHA),
      { ...pinnedDataset("geosite", GEOSITE_SHA), project: "Loyalsoldier/geoip" },
    ],
  };
  const badPath = path.join(bad, "geo.lock.json");
  writeFileSync(badPath, JSON.stringify(badLock));
  assert.throws(() => loadGeoLock(badPath), /Loyalsoldier or sing-box|GPL-3/);
  rmSync(dir, { recursive: true, force: true });
  rmSync(bad, { recursive: true, force: true });
});

test("fetch writes verified datasets and reuses a matching file", async () => {
  const dir = tempDir();
  const geoip = Buffer.from("geoip-bytes");
  const geosite = Buffer.from("geosite-bytes");
  const bodies = new Map<string, Buffer>([
    ["geoip", geoip],
    ["geosite", geosite],
  ]);
  const lock: GeoLockfile = {
    version: 1,
    datasets: [pinnedDataset("geoip", sha256(geoip)), pinnedDataset("geosite", sha256(geosite))],
  };
  const fetchImpl: GeoFetch = async (url) => {
    const dataset = lock.datasets.find((item) => item.sha256Url === url || item.url === url);
    assert.ok(dataset);
    if (url === dataset.sha256Url) return responseFor(url, `${dataset.sha256}  ${dataset.asset}\n`, null);
    return responseFor(url, "", bodies.get(dataset.id) ?? Buffer.alloc(0));
  };
  const written = await fetchLockedDatasets({ lock, outDir: dir, fetchImpl });
  assert.equal(written.length, 2);
  assert.equal(written.every((item) => item.reused === false), true);
  assert.equal(readFileSync(path.join(dir, "geosite.dat")).equals(geosite), true);
  let binaries = 0;
  const reuseFetch: GeoFetch = async (url) => {
    if (!url.endsWith(".sha256sum")) binaries += 1;
    return fetchImpl(url);
  };
  const again = await fetchLockedDatasets({ lock, outDir: dir, fetchImpl: reuseFetch });
  assert.equal(binaries, 0);
  assert.equal(again.every((item) => item.reused), true);
  rmSync(dir, { recursive: true, force: true });
});

test("synthetic dat fixtures resolve country and site category", () => {
  assert.deepEqual(cidr(Buffer.from([127, 0, 0, 0]), 8), Buffer.from([0x12, 0x08, 0x0a, 0x04, 0x7f, 0x00, 0x00, 0x00, 0x10, 0x08]));
  const index = geoIndexFromBuffers(sampleGeoIp(), sampleGeoSite());
  assert.equal(index.countryOf("8.8.8.8"), "US");
  assert.equal(index.countryOf("::ffff:8.8.8.8"), "US");
  assert.equal(index.countryOf("8.8.8.9"), "WIDE");
  assert.equal(index.countryOf("1.0.1.255"), "CN");
  assert.equal(index.countryOf("1.0.2.1"), null);
  assert.equal(index.countryOf("9.9.9.9"), null);
  assert.equal(index.countryOf("127.0.0.1"), "LO");
  assert.equal(index.countryOf("2001:db8::1"), "AU");
  assert.equal(index.countryOf("2001:db9::1"), null);
  assert.equal(index.countryOf("not-an-ip"), null);
  assert.deepEqual(index.categoriesOf("www.google.com"), ["google"]);
  assert.deepEqual(index.categoriesOf("Google.com."), ["google"]);
  assert.deepEqual(index.categoriesOf("notgoogle.com"), []);
  assert.deepEqual(index.categoriesOf("ads.doubleclick.net"), ["ads"]);
  assert.deepEqual(index.categoriesOf("Ads.DoubleClick.net"), ["ads"]);
  assert.deepEqual(index.categoriesOf("exact.test"), ["exact"]);
  assert.deepEqual(index.categoriesOf("www.exact.test"), []);
  assert.deepEqual(index.categoriesOf("example.com"), ["exactish", "suffix"]);
  assert.deepEqual(index.categoriesOf("fnord.example"), ["re"]);
  assert.throws(() => geoIndexFromBuffers(Buffer.from([0x0a, 0x05]), Buffer.alloc(0)), GeoDataError);

  const dir = tempDir();
  writeFileSync(path.join(dir, "geoip.dat"), sampleGeoIp());
  writeFileSync(path.join(dir, "geosite.dat"), sampleGeoSite());
  assert.equal(loadGeoIndex(path.join(dir, "geoip.dat"), path.join(dir, "geosite.dat")).countryOf("8.8.8.8"), "US");
  assert.throws(() => loadGeoIndex(path.join(dir, "missing.dat"), path.join(dir, "geosite.dat")), /geo data missing/);
  rmSync(dir, { recursive: true, force: true });
});

test("geo hook stays closed unless both switches are on", () => {
  const dir = tempDir();
  const settings = path.join(dir, "settings.json");
  const data = path.join(dir, "data");
  writeFileSync(settings, JSON.stringify({ geoRouting: true }));
  assert.equal(openGeoHook({ INFINITUM_GEO_ENABLED: "0", HRVST_SETTINGS_PATH: settings, INFINITUM_GEO_DIR: data }), null);
  assert.equal(
    openGeoHook({ INFINITUM_GEO_ENABLED: "1", HRVST_SETTINGS_PATH: path.join(dir, "absent.json"), INFINITUM_GEO_DIR: data }),
    null,
  );
  assert.throws(
    () => openGeoHook({ INFINITUM_GEO_ENABLED: "yes", HRVST_SETTINGS_PATH: settings, INFINITUM_GEO_DIR: data }),
    /geo data missing/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("saved geo-routing preference defaults off and the CLI flag persists it", () => {
  const dir = tempDir();
  const file = path.join(dir, "settings.json");
  assert.equal(loadSettings(file).geoRouting, false);
  assert.equal(existsSync(file), false);
  const settings: HrvstSettings = { geoRouting: false };
  assert.equal(applyGeoRoutingFlag(["--geo-routing", "on", "--no-geo-routing"], settings), true);
  assert.equal(settings.geoRouting, false);
  assert.equal(applyGeoRoutingFlag(["--geo-routing=on"], settings), true);
  assert.equal(settings.geoRouting, true);
  assert.throws(() => applyGeoRoutingFlag(["--geo-routing", "maybe"], settings), /on or off/);
  saveSettings(settings, file);
  assert.equal(loadSettings(file).geoRouting, true);
  writeFileSync(file, JSON.stringify({ geoRouting: "true", extra: 1 }));
  assert.equal(loadSettings(file).geoRouting, false);
  writeFileSync(file, "{");
  assert.throws(() => loadSettings(file), /not valid JSON/);

  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", path.join(root, "src/settings.ts"), ...args], {
      cwd: root,
      env: { ...process.env, HRVST_SETTINGS_PATH: file },
      encoding: "utf8",
    });
  writeFileSync(file, "{}\n");
  const shown = run([]);
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /geo-routing: off/);
  assert.match(shown.stdout, /INFINITUM_GEO_ENABLED: off/);
  const enabled = run(["--geo-routing", "on"]);
  assert.equal(enabled.status, 0);
  assert.match(enabled.stdout, /geo-routing: on \(saved\)/);
  assert.equal(loadSettings(file).geoRouting, true);
  const disabled = run(["--no-geo-routing"]);
  assert.equal(disabled.status, 0);
  assert.match(disabled.stdout, /geo-routing: off \(saved\)/);
  assert.equal(loadSettings(file).geoRouting, false);
  const bad = run(["--geo-routing=maybe"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /on or off/);
  rmSync(dir, { recursive: true, force: true });
});

test("a routing note is appended only as a geo annotation", () => {
  const store = new HrvstBackend();
  const capture = store.capture({
    owner: "cid:field",
    note: "Raised sidewalk slab outside the library doors.",
    placeLabel: "Library approach",
    placeClass: "street",
  });
  const { packet } = store.refine(capture.id);
  assert.ok(packet);
  store.decide(packet.id, "keep");
  const plain = store.signalArchitect(packet.id);
  const noted = store.signalArchitect(packet.id, "country US; categories google");
  const injected = store.signalArchitect(packet.id, "country US\ninjected");
  assert.equal(noted.goal, `${plain.goal} Geo routing: country US; categories google.`);
  assert.equal(injected.goal, plain.goal);
  assert.match(plain.goal, /approval/);
  assert.equal(plain.goal.includes("Geo routing"), false);
  assert.equal(geoRoutingNote({ country: "US", categories: ["google", "ads"] }), "country US; categories ads,google");
  assert.equal(geoRoutingNote({ country: null, categories: [] }), null);
  assert.match(formatGeoLog("POST", "/v1/packets/x/signal", { country: "US", categories: ["google"] }), /country=US categories=google/);
});

test("request addresses normalize mapped IPv4 and bracketed hosts", () => {
  const req = {
    socket: { remoteAddress: "::ffff:8.8.8.8" },
    headers: { host: "www.google.com:443" },
  } as IncomingMessage;
  assert.equal(clientAddress(req), "8.8.8.8");
  assert.equal(headerHost(req), "www.google.com");
  const v6 = { socket: { remoteAddress: "2001:db8::1" }, headers: { host: "[2001:db8::1]:443" } } as IncomingMessage;
  assert.equal(clientAddress(v6), "2001:db8::1");
  assert.equal(headerHost(v6), "2001:db8::1");
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

test("geo routing is invisible while off and annotates only while on", async () => {
  const lines: string[] = [];
  const off = createHrvstServer("token", { env: {}, geoLog: (line) => lines.push(line) });
  const offBase = await listen(off);
  try {
    const health = await fetch(`${offBase}/healthz`);
    assert.equal(health.headers.get("x-hrvst-geo"), null);
    assert.deepEqual(await health.json(), { ok: true, product: "hrvst" });
    assert.deepEqual(lines, []);
    const capture = await fetch(`${offBase}/v1/captures`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        owner: "cid:field",
        note: "Raised sidewalk slab outside the library doors.",
        placeLabel: "Library approach",
        placeClass: "street",
      }),
    });
    const created = (await capture.json()) as { id: string };
    const refined = (await (
      await fetch(`${offBase}/v1/captures/${created.id}/refine`, {
        method: "POST",
        headers: { authorization: "Bearer token" },
      })
    ).json()) as { packet: { id: string } };
    await fetch(`${offBase}/v1/packets/${refined.packet.id}/decide`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ action: "keep" }),
    });
    const signal = await fetch(`${offBase}/v1/packets/${refined.packet.id}/signal`, {
      method: "POST",
      headers: { authorization: "Bearer token" },
    });
    const fault = (await signal.json()) as { goal: string };
    assert.equal(fault.goal.includes("Geo routing"), false);
  } finally {
    await close(off);
  }

  const hook: GeoHook = { annotate: () => ({ country: "US", categories: ["google"] }) };
  const logged: string[] = [];
  const on = createHrvstServer("token", { geo: hook, geoLog: (line) => logged.push(line) });
  const onBase = await listen(on);
  try {
    const health = await fetch(`${onBase}/healthz`);
    assert.equal(health.headers.get("x-hrvst-geo"), "country US; categories google");
    assert.deepEqual(await health.json(), { ok: true, product: "hrvst" });
    assert.ok(logged.some((line) => line.startsWith("geo GET /healthz ") && line.includes("country=US")));
    const capture = await fetch(`${onBase}/v1/captures`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({
        owner: "cid:field",
        note: "Curb ramp at the library doors is blocked by a temporary sign board.",
        placeLabel: "Library",
        placeClass: "public_building",
      }),
    });
    const created = (await capture.json()) as { id: string; geo?: unknown };
    assert.equal(capture.headers.get("x-hrvst-geo"), "country US; categories google");
    assert.equal("geo" in created, false);
    const refined = (await (
      await fetch(`${onBase}/v1/captures/${created.id}/refine`, {
        method: "POST",
        headers: { authorization: "Bearer token" },
      })
    ).json()) as { packet: { id: string } };
    await fetch(`${onBase}/v1/packets/${refined.packet.id}/decide`, {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ action: "keep" }),
    });
    const signal = await fetch(`${onBase}/v1/packets/${refined.packet.id}/signal`, {
      method: "POST",
      headers: { authorization: "Bearer token" },
    });
    const fault = (await signal.json()) as { goal: string };
    assert.match(fault.goal, /Geo routing: country US; categories google\./);
    assert.match(fault.goal, /approval/);
  } finally {
    await close(on);
  }

  const empty: GeoHook = { annotate: () => ({ country: null, categories: [] }) };
  const emptyLines: string[] = [];
  const quiet = createHrvstServer("token", { geo: empty, geoLog: (line) => emptyLines.push(line) });
  const quietBase = await listen(quiet);
  try {
    const health = await fetch(`${quietBase}/healthz`);
    assert.equal(health.headers.get("x-hrvst-geo"), null);
    assert.deepEqual(await health.json(), { ok: true, product: "hrvst" });
    assert.ok(emptyLines.some((line) => line.includes("country=- categories=-")));
  } finally {
    await close(quiet);
  }

  const broken: GeoHook = {
    annotate() {
      throw new Error("boom");
    },
  };
  const failing = createHrvstServer("token", { geo: broken, geoLog: () => undefined });
  const failingBase = await listen(failing);
  try {
    const health = await fetch(`${failingBase}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-hrvst-geo"), null);
    assert.deepEqual(await health.json(), { ok: true, product: "hrvst" });
  } finally {
    await close(failing);
  }

  const dir = tempDir();
  const data = path.join(dir, "data");
  const settings = path.join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ geoRouting: true }));
  mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, "geoip.dat"), sampleGeoIp());
  writeFileSync(path.join(data, "geosite.dat"), sampleGeoSite());
  const wiredLines: string[] = [];
  const wired = createHrvstServer("token", {
    env: { INFINITUM_GEO_ENABLED: "1", INFINITUM_GEO_DIR: data, HRVST_SETTINGS_PATH: settings },
    geoLog: (line) => wiredLines.push(line),
  });
  const wiredBase = await listen(wired);
  try {
    const health = await fetch(`${wiredBase}/healthz`);
    assert.equal(health.headers.get("x-hrvst-geo"), "country LO");
    assert.deepEqual(await health.json(), { ok: true, product: "hrvst" });
    assert.ok(wiredLines.some((line) => line.includes("country=LO")));
  } finally {
    await close(wired);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server CLI saves geo-routing and still boots while the process switch is off", async () => {
  const dir = tempDir();
  const file = path.join(dir, "settings.json");
  const started = spawnSync(
    process.execPath,
    ["--experimental-strip-types", path.join(root, "src/server.ts"), "--geo-routing", "on"],
    {
      cwd: root,
      env: { ...process.env, HRVST_SETTINGS_PATH: file, PORT: "0", INFINITUM_GEO_ENABLED: "" },
      encoding: "utf8",
      timeout: 4000,
      killSignal: "SIGKILL",
    },
  );
  assert.match(started.stdout, /geo-routing: on \(saved\)/);
  assert.match(started.stdout, /INFINITUM_GEO_ENABLED: off/);
  assert.match(started.stdout, /HRVST listening/);
  assert.equal(loadSettings(file).geoRouting, true);
  rmSync(dir, { recursive: true, force: true });
});
