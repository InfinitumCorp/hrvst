import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const read = (name: string) => readFileSync(new URL(`../src/app/${name}`, import.meta.url), "utf8");
const SOURCE = read("i18n.js");

interface I18n { lang: string; t: (s: string, v?: Record<string, unknown>) => string; RU: Record<string, string> }

/** Run the language script as a browser would, without a document, and return what it exposes. */
function load(languages: string[], saved: string | null = null): I18n {
  const window: Record<string, unknown> = { localStorage: { getItem: () => saved, setItem: () => {} } };
  runInNewContext(SOURCE, { window, navigator: { languages, language: languages[0] } });
  return window.HRVST_I18N as I18n;
}

test("Russian is chosen from the browser's languages, and a saved choice wins", () => {
  assert.equal(load(["ru-RU", "en"]).lang, "ru");
  assert.equal(load(["en-GB", "ru"]).lang, "ru", "Russian anywhere in the list counts");
  assert.equal(load(["en-US"]).lang, "en");
  assert.equal(load(["ru-RU"], "en").lang, "en");
  assert.equal(load(["de"], "ru").lang, "ru");
  assert.equal(load(["rue"]).lang, "en", "Rusyn is not Russian");
});

test("t fills in values and falls back to English for anything untranslated", () => {
  const ru = load(["ru"]);
  assert.equal(ru.t("Buy for {n} credits", { n: 12 }), "Купить за 12 кредитов");
  assert.equal(ru.t("A server error"), "A server error");
  assert.equal(load(["en"]).t("Buy for {n} credits", { n: 12 }), "Buy for 12 credits");
});

test("every string the app shows has a Russian translation", () => {
  const { RU } = load(["ru"]);
  const app = read("app.js");
  const keys = new Set<string>();
  for (const m of app.matchAll(/\bt\(\s*(["'])((?:(?!\1).)+)\1/g)) keys.add(m[2]!);
  for (const m of app.matchAll(/\["\w+", "([^"]+)"\]/g)) keys.add(m[1]!); // place names
  assert.ok(keys.size > 50, `found ${keys.size} strings`);

  const html = read("index.html").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<title>[\s\S]*?<\/title>/, "");
  for (const m of html.matchAll(/>([^<>]+)</g)) {
    const text = m[1]!.trim();
    if (text && /[A-Za-z]/.test(text) && !/^\[HRVST\]$/.test(text)) keys.add(text);
  }
  for (const m of html.matchAll(/\s(?:placeholder|aria-label)="([^"]+)"/g)) keys.add(m[1]!);

  const missing = [...keys].filter((k) => !(k in RU));
  assert.deepEqual(missing, []);
  for (const [en, ru] of Object.entries(RU)) {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(",");
    assert.equal(holes(ru), holes(en), `placeholders match in "${en}"`);
  }
});
