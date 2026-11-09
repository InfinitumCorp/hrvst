import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_DAT_BYTES = 80 * 1024 * 1024;
const MAX_SUM_BYTES = 4096;

const PINNED: Record<string, { project: string; filename: string; asset: string; license: string }> = {
  geoip: {
    project: "v2fly/geoip",
    filename: "geoip.dat",
    asset: "geoip.dat",
    license: "CC-BY-SA-4.0",
  },
  geosite: {
    project: "v2fly/domain-list-community",
    filename: "geosite.dat",
    asset: "dlc.dat",
    license: "MIT",
  },
};

export class GeoFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeoFetchError";
  }
}

export interface GeoDatasetLock {
  id: string;
  filename: string;
  project: string;
  tag: string;
  asset: string;
  license: string;
  url: string;
  sha256Url: string;
  sha256: string;
}

export interface GeoLockfile {
  version: number;
  note?: string;
  datasets: GeoDatasetLock[];
}

export interface GeoFetchResponse {
  ok: boolean;
  status: number;
  url: string;
  text: () => Promise<string>;
  body: ReadableStream<Uint8Array> | null;
}

export type GeoFetch = (url: string, init?: { redirect?: "follow" }) => Promise<GeoFetchResponse>;

export interface FetchResult {
  filename: string;
  sha256: string;
  path: string;
  reused: boolean;
}

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function defaultLockPath(): string {
  return path.join(repoRoot(), "geo.lock.json");
}

export function defaultDataDir(): string {
  return path.join(repoRoot(), "data");
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left.toLowerCase(), "utf8");
  const b = Buffer.from(right.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GeoFetchError(`refusing download URL ${raw}`);
  }
  if (url.protocol !== "https:") throw new GeoFetchError(`refusing non-https download ${raw}`);
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && !host.endsWith(".githubusercontent.com")) {
    throw new GeoFetchError(`refusing download host ${host}`);
  }
  return url;
}

function assertSafeToken(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new GeoFetchError(`invalid ${label}`);
}

export function parseSha256Sum(text: string, asset: string): string {
  if (text.length > MAX_SUM_BYTES) throw new GeoFetchError("sha256sum asset is unexpectedly large");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (!lines.length) throw new GeoFetchError(`official sha256sum for ${asset} is empty`);
  const wanted = lines.find((line) => {
    const name = line.split(/\s+/).slice(1).join(" ").replace(/^\*/, "");
    return name === asset;
  });
  const line = wanted ?? (lines.length === 1 ? lines[0] : "");
  if (!line) throw new GeoFetchError(`official sha256sum for ${asset} has no matching filename`);
  const hash = line.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new GeoFetchError(`official sha256sum for ${asset} is not a SHA-256 digest`);
  }
  return hash;
}

export function loadGeoLock(file: string): GeoLockfile {
  let raw: unknown;
  try {
    raw = JSON.parse(readLockText(file)) as unknown;
  } catch (error) {
    if (error instanceof GeoFetchError) throw error;
    throw new GeoFetchError(`cannot read geo lockfile ${file}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new GeoFetchError("geo lockfile must be an object");
  const version = (raw as { version?: unknown }).version;
  const datasets = (raw as { datasets?: unknown }).datasets;
  if (version !== 1 || !Array.isArray(datasets)) throw new GeoFetchError("geo lockfile version is not supported");
  const parsed = datasets.map(parseDataset);
  const ids = parsed.map((dataset) => dataset.id);
  if (ids.length !== 2 || new Set(ids).size !== 2 || !ids.includes("geoip") || !ids.includes("geosite")) {
    throw new GeoFetchError("geo lockfile must list geoip and geosite exactly once");
  }
  return { version: 1, note: typeof (raw as { note?: unknown }).note === "string" ? (raw as { note: string }).note : undefined, datasets: parsed };
}

function readLockText(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof GeoFetchError) throw error;
    throw new GeoFetchError(`cannot read geo lockfile ${file}`);
  }
  if (text.length > 64_000) throw new GeoFetchError("geo lockfile is too large");
  return text;
}

function parseDataset(value: unknown): GeoDatasetLock {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GeoFetchError("dataset entry is not an object");
  const row = value as Record<string, unknown>;
  const dataset: GeoDatasetLock = {
    id: String(row.id ?? ""),
    filename: String(row.filename ?? ""),
    project: String(row.project ?? ""),
    tag: String(row.tag ?? ""),
    asset: String(row.asset ?? ""),
    license: String(row.license ?? ""),
    url: String(row.url ?? ""),
    sha256Url: String(row.sha256Url ?? ""),
    sha256: String(row.sha256 ?? "").toLowerCase(),
  };
  const pinned = PINNED[dataset.id];
  if (!pinned) {
    throw new GeoFetchError(`refusing dataset ${dataset.id}; only v2fly/geoip and v2fly/domain-list-community are allowed`);
  }
  if (/loyalsoldier|sing-?box/i.test(`${dataset.project} ${dataset.url} ${dataset.sha256Url} ${dataset.asset}`)) {
    throw new GeoFetchError("refusing Loyalsoldier or sing-box data; those datasets are GPL-3");
  }
  if (dataset.project !== pinned.project || dataset.filename !== pinned.filename || dataset.asset !== pinned.asset) {
    throw new GeoFetchError(`dataset ${dataset.id} does not match the pinned v2fly asset`);
  }
  if (dataset.license !== pinned.license) throw new GeoFetchError(`dataset ${dataset.id} license does not match the pinned license`);
  assertSafeToken(dataset.tag, "release tag");
  if (!/^[0-9a-f]{64}$/.test(dataset.sha256)) throw new GeoFetchError(`dataset ${dataset.id} sha256 is not a digest`);
  const prefix = `https://github.com/${dataset.project}/releases/download/${dataset.tag}/`;
  if (dataset.url !== `${prefix}${dataset.asset}` || dataset.sha256Url !== `${prefix}${dataset.asset}.sha256sum`) {
    throw new GeoFetchError(`dataset ${dataset.filename} URL is outside the pinned v2fly release`);
  }
  assertHttpsUrl(dataset.url);
  assertHttpsUrl(dataset.sha256Url);
  if (path.basename(dataset.filename) !== dataset.filename) {
    throw new GeoFetchError(`refusing dataset filename ${dataset.filename}`);
  }
  return dataset;
}

async function fileSha256(file: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function request(url: string, fetchImpl: GeoFetch): Promise<GeoFetchResponse> {
  assertHttpsUrl(url);
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(url, { redirect: "follow" });
      if (!response.url) throw new GeoFetchError(`download for ${url} did not report a final URL`);
      assertHttpsUrl(response.url);
      if (response.ok) return response;
      last = new GeoFetchError(`download failed (${response.status}) for ${url}`);
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) break;
    } catch (error) {
      if (error instanceof GeoFetchError && /refusing/.test(error.message)) throw error;
      last = error;
    }
  }
  throw last instanceof Error ? last : new GeoFetchError(`download failed for ${url}`);
}

async function downloadHashed(url: string, dest: string, fetchImpl: GeoFetch): Promise<string> {
  const response = await request(url, fetchImpl);
  if (!response.body) throw new GeoFetchError(`empty download for ${url}`);
  const hash = createHash("sha256");
  const file = createWriteStream(dest, { mode: 0o644 });
  let seen = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      seen += value.byteLength;
      if (seen > MAX_DAT_BYTES) throw new GeoFetchError(`download exceeded ${MAX_DAT_BYTES} bytes for ${url}`);
      const chunk = Buffer.from(value);
      hash.update(chunk);
      if (!file.write(chunk)) await new Promise<void>((resolve) => file.once("drain", () => resolve()));
    }
    await new Promise<void>((resolve, reject) => {
      file.once("error", reject);
      file.end(() => resolve());
    });
  } catch (error) {
    file.destroy();
    await unlink(dest).catch(() => undefined);
    throw error;
  }
  return hash.digest("hex");
}

export async function fetchLockedDatasets(options: {
  lock: GeoLockfile;
  outDir: string;
  fetchImpl?: GeoFetch;
}): Promise<FetchResult[]> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as GeoFetch);
  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const results: FetchResult[] = [];
  for (const dataset of options.lock.datasets) {
    parseDataset(dataset);
    const sumResponse = await request(dataset.sha256Url, fetchImpl);
    const official = parseSha256Sum(await sumResponse.text(), dataset.asset);
    if (!sameHash(dataset.sha256, official)) {
      throw new GeoFetchError(
        `checksum mismatch for ${dataset.filename}: official sha256sum ${official} does not match lockfile ${dataset.sha256}`,
      );
    }
    const dest = path.join(outDir, dataset.filename);
    if (path.dirname(dest) !== outDir) throw new GeoFetchError(`refusing to write outside ${outDir}`);
    const current = await fileSha256(dest);
    if (current && sameHash(current, official)) {
      results.push({ filename: dataset.filename, sha256: official, path: dest, reused: true });
      continue;
    }
    const partial = `${dest}.partial`;
    const downloaded = await downloadHashed(dataset.url, partial, fetchImpl);
    if (!sameHash(downloaded, official)) {
      await unlink(partial).catch(() => undefined);
      throw new GeoFetchError(
        `checksum mismatch for ${dataset.filename}: downloaded sha256 ${downloaded} does not match official sha256sum ${official}`,
      );
    }
    await rename(partial, dest);
    results.push({ filename: dataset.filename, sha256: official, path: dest, reused: false });
  }
  return results;
}

async function main(): Promise<void> {
  const lock = loadGeoLock(defaultLockPath());
  const results = await fetchLockedDatasets({ lock, outDir: defaultDataDir() });
  for (const result of results) {
    console.log(`${result.filename} ${result.sha256} verified${result.reused ? " (already present)" : ""}`);
  }
}

const self = process.argv[1] ?? "";
if (self.endsWith("fetch-geo.ts") || self.endsWith("fetch-geo.js")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "geo fetch failed");
    process.exit(1);
  });
}
