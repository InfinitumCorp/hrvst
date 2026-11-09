import path from "node:path";
import type { IncomingMessage } from "node:http";
import { loadGeoIndex } from "./geo.ts";
import { geoFeatureEnabled, loadSettings, settingsPath } from "./settings.ts";

export interface GeoAnnotation {
  country: string | null;
  categories: string[];
}

export interface GeoHook {
  annotate(ip: string | null, host: string | null): GeoAnnotation;
}

function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._:!+-]/g, "").slice(0, 64);
}

/** Routing note for logs and an Architect fault. Null when the lookup found nothing. */
export function geoRoutingNote(annotation: GeoAnnotation): string | null {
  const country = annotation.country ? safeToken(annotation.country) : "";
  const categories = [...new Set(annotation.categories.map(safeToken).filter(Boolean))].sort();
  const parts: string[] = [];
  if (country) parts.push(`country ${country}`);
  if (categories.length) parts.push(`categories ${categories.join(",")}`);
  const note = parts.join("; ");
  if (!note || note.length > 240) return null;
  return note;
}

export function formatGeoLog(method: string, pathname: string, annotation: GeoAnnotation): string {
  const verb = method.replace(/[^A-Za-z]/g, "").slice(0, 16) || "GET";
  const pathName = pathname.replace(/[\r\n]/g, "").slice(0, 200);
  const country = annotation.country ? safeToken(annotation.country) || "-" : "-";
  const categories = annotation.categories.map(safeToken).filter(Boolean).join(",") || "-";
  return `geo ${verb} ${pathName} country=${country} categories=${categories}`;
}

export function clientAddress(req: IncomingMessage): string | null {
  const raw = req.socket?.remoteAddress;
  if (!raw) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  return mapped?.[1] ?? raw;
}

export function headerHost(req: IncomingMessage): string | null {
  const value = req.headers.host;
  if (typeof value !== "string" || !value) return null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 1 ? value.slice(1, end) : null;
  }
  return value.replace(/:\d+$/, "");
}

/**
 * Opens the geo hook only when INFINITUM_GEO_ENABLED is on and the saved
 * geo-routing preference is on. Either switch alone leaves the hook closed.
 */
export function openGeoHook(env: NodeJS.ProcessEnv = process.env): GeoHook | null {
  if (!geoFeatureEnabled(env)) return null;
  if (!loadSettings(settingsPath(env)).geoRouting) return null;
  const dir = path.resolve(env.INFINITUM_GEO_DIR?.trim() || path.join(process.cwd(), "data"));
  const index = loadGeoIndex(path.join(dir, "geoip.dat"), path.join(dir, "geosite.dat"));
  return {
    annotate(ip, host) {
      return {
        country: ip ? index.countryOf(ip) : null,
        categories: host ? index.categoriesOf(host) : [],
      };
    },
  };
}
