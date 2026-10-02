/**
 * Dev-only MTF downloader (no import/conversion).
 *
 * Fetches a BattleMech MTF from the Flechs Sheets public catalog
 * (S3 mirror of the in-app catalog) by designation and saves it locally.
 *
 * Usage:
 *   node scripts/fetch-mtf.mjs "Atlas AS7-D"
 *   node scripts/fetch-mtf.mjs "Atlas AS7-D" "Locust LCT-1V" --dir tmp/mtf
 *   node scripts/fetch-mtf.mjs "Atlas AS7-D" --out tmp/mtf/atlas.mtf
 *   node scripts/fetch-mtf.mjs "Atlas" --list
 *
 * Lookup mirrors the app's CatalogRepository: exact match on the manifest's
 * d/a/dd attributes, plus a Mech<->Mek spelling fallback, then a
 * case-insensitive pass. Files land under tmp/ (gitignored) by default.
 *
 * The unit-list manifest is cached at tmp/mtf/unitList.xml and reused on
 * later runs; delete it (or pass --refresh) to re-fetch.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://helm-kore-fragment.s3.amazonaws.com/";
const MANIFEST_URL = `${BASE}unitList.xml`;
const MEK_DIR = `${BASE}mtf/meks/`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return [
    `usage: node scripts/fetch-mtf.mjs "<designation>" [...] [options]`,
    ``,
    `  <designation>  unit name as shown in Flechs Sheets, e.g. "Atlas AS7-D"`,
    `  --dir <path>   output directory (default: tmp/mtf, relative to repo root)`,
    `  --out <path>   output file (single designation only)`,
    `  --list         list manifest matches without downloading`,
    `  --refresh      re-fetch the manifest even when the cache exists`,
  ].join("\n");
}

function parseArgs(argv) {
  const names = [];
  let dir = join(root, "tmp", "mtf");
  let out = null;
  let list = false;
  let refresh = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") {
      dir = resolve(root, argv[++i] ?? "");
    } else if (a === "--out") {
      out = resolve(root, argv[++i] ?? "");
    } else if (a === "--list") {
      list = true;
    } else if (a === "--refresh") {
      refresh = true;
    } else if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (a.startsWith("--")) {
      console.error(`unknown option ${JSON.stringify(a)}\n${usage()}`);
      process.exit(1);
    } else {
      names.push(a);
    }
  }
  return { names, dir, out, list, refresh };
}

/** Minimal manifest parse: collects {d,a,dd,f} from each <u .../> entry. */
function parseManifest(xml) {
  const entries = [];
  for (const m of xml.matchAll(/<u\s+([^>]*?)\/>/g)) {
    const attrs = {};
    for (const am of m[1].matchAll(/(\w+)="([^"]*)"/g)) {
      attrs[am[1]] = am[2];
    }
    if (attrs.f) entries.push(attrs);
  }
  return entries;
}

function spellingVariants(q) {
  return [
    q,
    q.replace(/Mech/g, "Mek").replace(/mech/g, "mek"),
    q.replace(/Mek/g, "Mech").replace(/mek/g, "mech"),
  ];
}

function entryNames(e) {
  return [e.d, e.a, e.dd].filter(Boolean);
}

function findEntry(query, entries) {
  for (const v of spellingVariants(query)) {
    const hit = entries.find((e) => entryNames(e).includes(v));
    if (hit) return hit;
  }
  const lower = new Map();
  for (const v of spellingVariants(query)) lower.set(v.toLowerCase(), true);
  return entries.find((e) => entryNames(e).some((n) => lower.has(n.toLowerCase()))) ?? null;
}

function suggestions(query, entries, limit = 10) {
  const q = query.toLowerCase();
  return entries
    .filter((e) => entryNames(e).some((n) => n.toLowerCase().includes(q)))
    .slice(0, limit);
}

const { names, dir, out, list, refresh } = parseArgs(process.argv.slice(2));
if (names.length === 0) {
  console.error(usage());
  process.exit(1);
}
if (out && names.length > 1) {
  console.error("--out accepts a single designation only");
  process.exit(1);
}

const manifestCache = join(root, "tmp", "mtf", "unitList.xml");
let manifestXml;
if (!refresh && existsSync(manifestCache)) {
  manifestXml = readFileSync(manifestCache, "utf8");
} else {
  const manifestRes = await fetch(MANIFEST_URL);
  if (!manifestRes.ok) {
    console.error(`failed to fetch manifest ${MANIFEST_URL}: ${manifestRes.status}`);
    process.exit(1);
  }
  manifestXml = await manifestRes.text();
  mkdirSync(dirname(manifestCache), { recursive: true });
  writeFileSync(manifestCache, manifestXml);
}
const entries = parseManifest(manifestXml);

let failed = 0;
for (const name of names) {
  const entry = findEntry(name, entries);
  if (!entry) {
    console.error(`no catalog entry for ${JSON.stringify(name)}`);
    for (const s of suggestions(name, entries)) {
      console.error(`  did you mean: "${s.d}"`);
    }
    failed++;
    continue;
  }
  const display = entry.d ?? name;
  if (list) {
    console.log(`${display} -> ${entry.f}`);
    continue;
  }
  const url = MEK_DIR + entry.f.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`failed to fetch ${display} (${url}): ${res.status}`);
    failed++;
    continue;
  }
  const text = await res.text();
  if (!text.startsWith("Version:")) {
    console.error(`unexpected content for ${display} (first line: ${text.split("\n")[0]})`);
    failed++;
    continue;
  }
  const outPath = out ?? join(dir, entry.f);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);
  console.log(`wrote ${outPath.replace(`${root}/`, "")} (${display})`);
}
if (failed > 0) process.exit(1);
