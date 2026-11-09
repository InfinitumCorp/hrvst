import { readFileSync, statSync } from "node:fs";

/** v2fly GeoIPList / GeoSiteList loader. Loyalsoldier and sing-box files are not accepted. */
const MAX_DAT_BYTES = 80 * 1024 * 1024;
const DOMAIN_PLAIN = 0;
const DOMAIN_REGEX = 1;
const DOMAIN_ROOT = 2;
const DOMAIN_FULL = 3;

export class GeoDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeoDataError";
  }
}

type ParsedIp = { version: 4; value: number } | { version: 6; value: bigint };

class ProtoReader {
  private readonly buf: Buffer;
  private readonly end: number;
  private pos: number;

  constructor(buf: Buffer, start: number, end: number) {
    this.buf = buf;
    this.end = end;
    this.pos = start;
  }

  eof(): boolean {
    return this.pos >= this.end;
  }

  private byte(): number {
    if (this.pos >= this.end) throw new GeoDataError("truncated geo data");
    return this.buf[this.pos++] ?? 0;
  }

  varint(): number {
    let value = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const current = this.byte();
      value += (current & 0x7f) * 2 ** shift;
      if ((current & 0x80) === 0) return value;
      shift += 7;
    }
    throw new GeoDataError("geo varint is too long");
  }

  take(length: number): ProtoReader {
    if (!Number.isInteger(length) || length < 0 || this.pos + length > this.end) {
      throw new GeoDataError("truncated geo data");
    }
    const child = new ProtoReader(this.buf, this.pos, this.pos + length);
    this.pos += length;
    return child;
  }

  bytes(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0 || this.pos + length > this.end) {
      throw new GeoDataError("truncated geo data");
    }
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  skip(wire: number): void {
    if (wire === 0) {
      this.varint();
      return;
    }
    if (wire === 1) {
      this.bytes(8);
      return;
    }
    if (wire === 2) {
      this.bytes(this.varint());
      return;
    }
    if (wire === 5) {
      this.bytes(4);
      return;
    }
    throw new GeoDataError(`unsupported geo field wire type ${wire}`);
  }

  tag(): { field: number; wire: number } | null {
    if (this.eof()) return null;
    const tag = this.varint();
    return { field: Math.floor(tag / 8), wire: tag & 7 };
  }
}

function readString(reader: ProtoReader): string {
  const bytes = reader.bytes(reader.varint());
  return Buffer.from(bytes).toString("utf8");
}

function v4Network(ip: number, prefix: number): number {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return ip >>> 0;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) >>> 0;
}

function v6Network(ip: bigint, prefix: number): bigint {
  if (prefix <= 0) return 0n;
  if (prefix >= 128) return ip;
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return ip & mask;
}

function ipv4FromBytes(bytes: Uint8Array): number | null {
  if (bytes.length !== 4) return null;
  return ((bytes[0]! * 0x1000000) + (bytes[1]! * 0x10000) + (bytes[2]! * 0x100) + bytes[3]!) >>> 0;
}

function ipv6FromBytes(bytes: Uint8Array): bigint | null {
  if (bytes.length !== 16) return null;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  return value;
}

function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value * 256 + octet) >>> 0;
  }
  return value;
}

function parseIpv6(ip: string): bigint | null {
  const raw = ip.toLowerCase();
  if (raw.includes("%") || raw.includes(".")) return null;
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): string[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    if (groups.some((group) => group.length === 0)) return null;
    return groups;
  };
  const left = parseGroups(halves[0] ?? "");
  if (!left) return null;
  let groups: string[];
  if (halves.length === 1) {
    groups = left;
  } else {
    const right = parseGroups(halves[1] ?? "");
    if (!right) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  }
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) + BigInt(Number.parseInt(group, 16));
  }
  return value;
}

export function parseIp(ip: string): ParsedIp | null {
  let raw = ip.trim();
  if (!raw) return null;
  if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  if (mapped?.[1]) {
    const v4 = parseIpv4(mapped[1]);
    return v4 === null ? null : { version: 4, value: v4 };
  }
  if (raw.includes(":")) {
    const v6 = parseIpv6(raw);
    return v6 === null ? null : { version: 6, value: v6 };
  }
  const v4 = parseIpv4(raw);
  return v4 === null ? null : { version: 4, value: v4 };
}

function normalizeDomain(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (!host) return null;
  if (host.includes("://") || host.includes("/")) return null;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.length > 253) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  if (!/^[a-z0-9._-]+$/.test(host)) return null;
  return host;
}

function pushCategory(map: Map<string, string[]>, key: string, category: string): void {
  const list = map.get(key);
  if (!list) {
    map.set(key, [category]);
    return;
  }
  if (!list.includes(category)) list.push(category);
}

export class GeoIndex {
  private readonly v4: Array<Map<number, string>> = Array.from({ length: 33 }, () => new Map());
  private readonly v4Used: boolean[] = Array<boolean>(33).fill(false);
  private readonly v6 = new Map<string, string>();
  private readonly v6Prefixes = new Set<number>();
  private v6PrefixDesc: number[] | null = null;
  private readonly full = new Map<string, string[]>();
  private readonly root = new Map<string, string[]>();
  private readonly plain: Array<{ value: string; category: string }> = [];
  private readonly regex: Array<{ category: string; re: RegExp }> = [];

  addCidr(ip: Uint8Array, prefix: number, country: string): void {
    if (!country || !Number.isInteger(prefix) || prefix < 0) return;
    if (ip.length === 4) {
      if (prefix > 32) return;
      const value = ipv4FromBytes(ip);
      if (value === null) return;
      const key = v4Network(value, prefix);
      const bucket = this.v4[prefix];
      if (!bucket) return;
      if (!bucket.has(key)) bucket.set(key, country);
      this.v4Used[prefix] = true;
      return;
    }
    if (ip.length === 16) {
      if (prefix > 128) return;
      const value = ipv6FromBytes(ip);
      if (value === null) return;
      const key = `${prefix}:${v6Network(value, prefix).toString(16)}`;
      if (!this.v6.has(key)) this.v6.set(key, country);
      if (!this.v6Prefixes.has(prefix)) {
        this.v6Prefixes.add(prefix);
        this.v6PrefixDesc = null;
      }
    }
  }

  addDomain(type: number, raw: string, category: string): void {
    const value = raw.trim();
    if (!value || !category || value.length > 512) return;
    if (type === DOMAIN_PLAIN || type === DOMAIN_ROOT || type === DOMAIN_FULL) {
      const domain = normalizeDomain(value) ?? value.toLowerCase().replace(/\.$/, "");
      if (!domain) return;
      if (type === DOMAIN_PLAIN) {
        this.plain.push({ value: domain, category });
        return;
      }
      pushCategory(type === DOMAIN_FULL ? this.full : this.root, domain, category);
      return;
    }
    if (type === DOMAIN_REGEX) {
      if (value.length > 128) return;
      try {
        this.regex.push({ category, re: new RegExp(value, "u") });
      } catch {
        // A dataset rule that is not valid JavaScript is ignored.
      }
    }
  }

  countryOf(ip: string): string | null {
    const parsed = parseIp(ip);
    if (!parsed) return null;
    if (parsed.version === 4) return this.countryV4(parsed.value);
    return this.countryV6(parsed.value);
  }

  categoriesOf(domain: string): string[] {
    const host = normalizeDomain(domain);
    if (!host) return [];
    const found = new Set<string>();
    for (const category of this.full.get(host) ?? []) found.add(category);
    let rest = host;
    while (rest) {
      for (const category of this.root.get(rest) ?? []) found.add(category);
      const dot = rest.indexOf(".");
      if (dot < 0) break;
      rest = rest.slice(dot + 1);
    }
    for (const rule of this.plain) {
      if (host.includes(rule.value)) found.add(rule.category);
    }
    for (const rule of this.regex) {
      rule.re.lastIndex = 0;
      if (rule.re.test(host)) found.add(rule.category);
    }
    return [...found].sort();
  }

  private countryV4(ip: number): string | null {
    for (let prefix = 32; prefix >= 0; prefix--) {
      if (!this.v4Used[prefix]) continue;
      const hit = this.v4[prefix]?.get(v4Network(ip, prefix));
      if (hit) return hit;
    }
    return null;
  }

  private countryV6(ip: bigint): string | null {
    if (!this.v6PrefixDesc) this.v6PrefixDesc = [...this.v6Prefixes].sort((a, b) => b - a);
    for (const prefix of this.v6PrefixDesc) {
      const hit = this.v6.get(`${prefix}:${v6Network(ip, prefix).toString(16)}`);
      if (hit) return hit;
    }
    return null;
  }
}

function readCidr(reader: ProtoReader): { ip: Uint8Array; prefix: number } {
  let ip = new Uint8Array();
  let prefix = 0;
  for (;;) {
    const tag = reader.tag();
    if (!tag) break;
    if (tag.field === 1 && tag.wire === 2) ip = Uint8Array.from(reader.bytes(reader.varint()));
    else if (tag.field === 2 && tag.wire === 0) prefix = reader.varint();
    else reader.skip(tag.wire);
  }
  return { ip, prefix };
}

function readGeoIp(reader: ProtoReader, index: GeoIndex): void {
  let country = "";
  let reverse = false;
  const cidrs: Array<{ ip: Uint8Array; prefix: number }> = [];
  for (;;) {
    const tag = reader.tag();
    if (!tag) break;
    if (tag.field === 1 && tag.wire === 2) country = readString(reader);
    else if (tag.field === 2 && tag.wire === 2) cidrs.push(readCidr(reader.take(reader.varint())));
    else if (tag.field === 3 && tag.wire === 0) reverse = reader.varint() !== 0;
    else reader.skip(tag.wire);
  }
  // reverse_match is a routing exclusion, not a country assignment.
  if (reverse || !country) return;
  for (const cidr of cidrs) index.addCidr(cidr.ip, cidr.prefix, country);
}

function readDomain(reader: ProtoReader): { type: number; value: string } {
  let type = 0;
  let value = "";
  for (;;) {
    const tag = reader.tag();
    if (!tag) break;
    if (tag.field === 1 && tag.wire === 0) type = reader.varint();
    else if (tag.field === 2 && tag.wire === 2) value = readString(reader);
    else reader.skip(tag.wire);
  }
  return { type, value };
}

function readGeoSite(reader: ProtoReader, index: GeoIndex): void {
  let category = "";
  const domains: Array<{ type: number; value: string }> = [];
  for (;;) {
    const tag = reader.tag();
    if (!tag) break;
    if (tag.field === 1 && tag.wire === 2) category = readString(reader);
    else if (tag.field === 2 && tag.wire === 2) domains.push(readDomain(reader.take(reader.varint())));
    else reader.skip(tag.wire);
  }
  if (!category) return;
  for (const domain of domains) index.addDomain(domain.type, domain.value, category);
}

function readList(buf: Buffer, kind: "geoip" | "geosite", index: GeoIndex): void {
  const reader = new ProtoReader(buf, 0, buf.length);
  for (;;) {
    const tag = reader.tag();
    if (!tag) break;
    if (tag.field === 1 && tag.wire === 2) {
      const message = reader.take(reader.varint());
      if (kind === "geoip") readGeoIp(message, index);
      else readGeoSite(message, index);
    } else reader.skip(tag.wire);
  }
}

export function geoIndexFromBuffers(geoip: Buffer, geosite: Buffer): GeoIndex {
  const index = new GeoIndex();
  readList(geoip, "geoip", index);
  readList(geosite, "geosite", index);
  return index;
}

function readDat(file: string): Buffer {
  let buf: Buffer;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new GeoDataError(`geo data is not a file: ${file}`);
    if (stat.size > MAX_DAT_BYTES) throw new GeoDataError(`geo data is too large: ${file}`);
    buf = readFileSync(file);
  } catch (error) {
    if (error instanceof GeoDataError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GeoDataError(`geo data missing: ${file}. Run npm run geo:fetch`);
    }
    throw error;
  }
  if (buf.length > MAX_DAT_BYTES) throw new GeoDataError(`geo data is too large: ${file}`);
  return buf;
}

export function loadGeoIndex(geoipPath: string, geositePath: string): GeoIndex {
  return geoIndexFromBuffers(readDat(geoipPath), readDat(geositePath));
}
