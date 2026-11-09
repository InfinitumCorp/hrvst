import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface HrvstSettings {
  geoRouting: boolean;
}

export const DEFAULT_SETTINGS: HrvstSettings = { geoRouting: false };

/** Process switch for the geo hook. Unset, empty, and any other value stay off. */
export function geoFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.INFINITUM_GEO_ENABLED;
  if (typeof raw !== "string") return false;
  return /^(1|true|on|yes)$/i.test(raw.trim());
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HRVST_SETTINGS_PATH;
  if (typeof override === "string" && override.trim()) return override;
  return path.join(process.cwd(), ".hrvst", "settings.json");
}

export function loadSettings(file = settingsPath()): HrvstSettings {
  let text: string;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error(`settings path is not a file: ${file}`);
    if (stat.size > 64_000) throw new Error(`settings file is too large: ${file}`);
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS };
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`settings file is not valid JSON: ${file}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`settings file must be an object: ${file}`);
  }
  return { geoRouting: (raw as { geoRouting?: unknown }).geoRouting === true };
}

export function saveSettings(settings: HrvstSettings, file = settingsPath()): void {
  const dest = path.resolve(file);
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.partial`;
  const body = JSON.stringify({ geoRouting: settings.geoRouting === true }, null, 2) + "\n";
  writeFileSync(tmp, body, { mode: 0o644 });
  renameSync(tmp, dest);
}

/**
 * Applies `--geo-routing`, `--geo-routing on|off`, `--geo-routing=on|off`, or `--no-geo-routing`.
 * Returns true when a flag was present. The last flag wins.
 */
export function applyGeoRoutingFlag(argv: readonly string[], settings: HrvstSettings): boolean {
  let seen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-geo-routing") {
      settings.geoRouting = false;
      seen = true;
      continue;
    }
    if (arg === "--geo-routing") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        settings.geoRouting = true;
      } else if (/^(on|off|true|false)$/i.test(next)) {
        settings.geoRouting = /^(on|true)$/i.test(next);
        i++;
      } else {
        throw new Error("geo-routing expects on or off");
      }
      seen = true;
      continue;
    }
    if (arg.startsWith("--geo-routing=")) {
      const value = arg.slice("--geo-routing=".length);
      if (!/^(on|off|true|false)$/i.test(value)) throw new Error("geo-routing expects on or off");
      settings.geoRouting = /^(on|true)$/i.test(value);
      seen = true;
    }
  }
  return seen;
}

export function formatGeoSwitch(settings: HrvstSettings, env: NodeJS.ProcessEnv = process.env, saved = false): string {
  const preference = settings.geoRouting ? "on" : "off";
  const enabled = geoFeatureEnabled(env) ? "on" : "off";
  return `geo-routing: ${preference}${saved ? " (saved)" : ""}\nINFINITUM_GEO_ENABLED: ${enabled}`;
}

const self = process.argv[1] ?? "";
if (self.endsWith("settings.ts") || self.endsWith("settings.js")) {
  const file = settingsPath();
  const settings = loadSettings(file);
  try {
    const saved = applyGeoRoutingFlag(process.argv.slice(2), settings);
    if (saved) saveSettings(settings, file);
    console.log(formatGeoSwitch(settings, process.env, saved));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid geo-routing flag");
    process.exit(1);
  }
}
