/** Tiny GeoIPList / GeoSiteList protobuf fixtures. Not the v2fly releases. */

function varint(value: number): Buffer {
  const out: number[] = [];
  let rest = value >>> 0;
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return Buffer.from(out);
}

function fieldBytes(field: number, data: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(data.length), data]);
}

function fieldString(field: number, value: string): Buffer {
  return fieldBytes(field, Buffer.from(value, "utf8"));
}

function fieldVarint(field: number, value: number): Buffer {
  return Buffer.concat([varint((field << 3) | 0), varint(value)]);
}

export function cidr(ip: Buffer, prefix: number): Buffer {
  return fieldBytes(2, Buffer.concat([fieldBytes(1, ip), fieldVarint(2, prefix)]));
}

function geoIpEntry(country: string, cidrs: Buffer[], reverse = false, extra?: Buffer): Buffer {
  const parts = [fieldString(1, country)];
  if (extra) parts.push(extra);
  parts.push(...cidrs);
  if (reverse) parts.push(fieldVarint(3, 1));
  return fieldBytes(1, Buffer.concat(parts));
}

function domain(type: number, value: string): Buffer {
  return fieldBytes(2, Buffer.concat([fieldVarint(1, type), fieldString(2, value)]));
}

function geoSiteEntry(category: string, domains: Buffer[]): Buffer {
  return fieldBytes(1, Buffer.concat([fieldString(1, category), ...domains]));
}

export function sampleGeoIp(): Buffer {
  const v6 = Buffer.alloc(16);
  v6[0] = 0x20;
  v6[1] = 0x01;
  v6[2] = 0x0d;
  v6[3] = 0xb8;
  return Buffer.concat([
    geoIpEntry("LO", [cidr(Buffer.from([127, 0, 0, 0]), 8)]),
    geoIpEntry("WIDE", [cidr(Buffer.from([8, 8, 8, 0]), 24)]),
    geoIpEntry("US", [cidr(Buffer.from([8, 8, 8, 8]), 32)], false, fieldBytes(15, Buffer.from("skip-me"))),
    geoIpEntry("CN", [cidr(Buffer.from([1, 0, 1, 0]), 24)]),
    geoIpEntry("NOPE", [cidr(Buffer.from([9, 9, 9, 0]), 24)], true),
    geoIpEntry("AU", [cidr(v6, 32)]),
  ]);
}

export function sampleGeoSite(): Buffer {
  return Buffer.concat([
    geoSiteEntry("google", [domain(2, "google.com")]),
    geoSiteEntry("ads", [domain(0, "doubleclick")]),
    geoSiteEntry("exact", [domain(3, "exact.test")]),
    geoSiteEntry("suffix", [domain(2, "example.com")]),
    geoSiteEntry("exactish", [domain(3, "example.com")]),
    geoSiteEntry("re", [domain(1, String.raw`^fnord\.example$`)]),
  ]);
}
