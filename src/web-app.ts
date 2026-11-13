import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";

/** The web app's files, read once at start. Only these names are served; nothing else on disk is reachable. */
const DIR = new URL("./app/", import.meta.url);
const ASSETS: Record<string, string> = {
  "app.js": "text/javascript; charset=utf-8",
  "cumulus-id.js": "text/javascript; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
};

/**
 * The page may load only its own scripts and styles and call only this server; the Cumulus ID
 * button leaves the page by navigation, which no fetch rule governs.
 */
export const APP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface WebAppConfig {
  /** Client id registered for HRVST at the Cumulus ID issuer. */
  cidClient: string;
  /** The issuer the button sends people to; can be a mirror that loads in Russia. Must match CID_ISSUER. */
  cidIssuer: string;
}

export function webAppConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WebAppConfig {
  return {
    cidClient: env.HRVST_CID_CLIENT || "hrvst",
    cidIssuer: (env.CID_ISSUER || "https://id.cumuluscloud.app").replace(/\/+$/, ""),
  };
}

export function createWebApp(config: WebAppConfig = webAppConfigFromEnv()) {
  const page = readFileSync(new URL("index.html", DIR), "utf8")
    .replace("{{CID_CLIENT}}", escapeAttr(config.cidClient))
    .replace("{{CID_ISSUER}}", escapeAttr(config.cidIssuer));
  const files = new Map(Object.keys(ASSETS).map((name) => [name, readFileSync(new URL(name, DIR))]));

  const headers = (type: string) => ({
    "content-type": type,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-cache",
  });

  /** Answers GET / and GET /app/<file>; returns false for anything else. */
  return function serve(method: string, pathname: string, res: ServerResponse): boolean {
    if (method !== "GET" && method !== "HEAD") return false;
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { ...headers("text/html; charset=utf-8"), "content-security-policy": APP_CSP });
      res.end(method === "HEAD" ? undefined : page);
      return true;
    }
    if (pathname.startsWith("/app/")) {
      const name = pathname.slice("/app/".length);
      const body = Object.prototype.hasOwnProperty.call(ASSETS, name) ? files.get(name) : undefined;
      if (!body) return false;
      res.writeHead(200, headers(ASSETS[name]!));
      res.end(method === "HEAD" ? undefined : body);
      return true;
    }
    return false;
  };
}
