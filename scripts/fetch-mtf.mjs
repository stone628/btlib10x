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
 *   node scripts/fetch-mtf.mjs "AS7-D" --list
 *   node scripts/fetch-mtf.mjs --roster [docs/mtf/sw/roster.json]
 *
 * Lookup: exact match on the manifest's d/a/dd attributes (Mech<->Mek
 * fallback, case-insensitive), else a single token-AND match. When the query
 * is ambiguous or unknown nothing is downloaded and the available names are
 * printed. Files land under tmp/mtf (gitignored) by default.
 *
 * Politeness: actual MTF downloads are at least 5 s apart, also across
 * separate invocations (last download time kept in tmp/mtf/.last-download).
 *
 * The unit-list manifest is cached at tmp/mtf/unitList.xml and reused on
 * later runs; delete it (or pass --refresh) to re-fetch.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { bestMatch, loadManifest, MEK_DIR, root } from "./mtf-catalog.mjs";

const MIN_GAP_MS = 5000;
const stampFile = join(root, "tmp", "mtf", ".last-download");
const defaultRoster = join(root, "docs", "mtf", "sw", "roster.json");
const rosterDir = join(root, "docs", "mtf", "sw", "mtf");

function usage() {
  return [
    `usage: node scripts/fetch-mtf.mjs "<designation>" [...] [options]`,
    `       node scripts/fetch-mtf.mjs --roster [roster.json] [options]`,
    ``,
    `  <designation>     unit name as shown in Flechs Sheets, e.g. "Atlas AS7-D"`,
    `  --dir <path>      output directory (default: tmp/mtf; roster: beside it)`,
    `  --out <path>      output file (single designation only)`,
    `  --list            list manifest matches without downloading`,
    `  --roster [file]   download every roster entry whose mtf is not "N/A"`,
    `                    (default: docs/mtf/sw/roster.json); files go beside the roster`,
    `                    (sw: docs/mtf/sw/mtf); existing files skipped`,
    `  --refresh         re-fetch the manifest even when the cache exists`,
    ``,
    `downloads are throttled to one per ${MIN_GAP_MS / 1000}s`,
  ].join("\n");
}

function parseArgs(argv) {
  const names = [];
  let dir = null;
  let out = null;
  let list = false;
  let refresh = false;
  let roster = null;
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
    } else if (a === "--roster") {
      const next = argv[i + 1];
      roster = next && !next.startsWith("--") ? resolve(root, argv[++i] ?? "") : defaultRoster;
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
  return { names, dir, out, list, refresh, roster };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until >= MIN_GAP_MS since the previous download, then stamp now. */
async function throttle() {
  let last = 0;
  try {
    last = Number(readFileSync(stampFile, "utf8")) || 0;
  } catch {}
  const wait = last + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  mkdirSync(dirname(stampFile), { recursive: true });
  writeFileSync(stampFile, String(Date.now()));
}

/** Download manifest file `f` to `outPath`; returns an error string or null. */
async function download(f, display, outPath) {
  const url = MEK_DIR + f.split("/").map(encodeURIComponent).join("/");
  await throttle();
  const res = await fetch(url);
  if (!res.ok) return `failed to fetch ${display} (${url}): ${res.status}`;
  const text = await res.text();
  if (!/^(Version|generator|chassis):/.test(text)) {
    return `unexpected content for ${display} (first line: ${text.split("\n")[0]})`;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);
  console.log(`wrote ${outPath.replace(`${root}/`, "")} (${display})`);
  return null;
}

const { names, dir, out, list, refresh, roster } = parseArgs(process.argv.slice(2));
if (names.length === 0 && !roster) {
  console.error(usage());
  process.exit(1);
}
if (out && names.length > 1) {
  console.error("--out accepts a single designation only");
  process.exit(1);
}

let failed = 0;

if (roster) {
  const items = JSON.parse(readFileSync(roster, "utf8")).filter((r) => r.mtf !== "N/A");
  const outDir = dir ?? (roster === defaultRoster ? rosterDir : dirname(roster));
  const files = [...new Set(items.map((r) => r.mtf))];
  let n = 0;
  for (const f of files) {
    n++;
    const outPath = join(outDir, f);
    if (existsSync(outPath)) continue;
    process.stdout.write(`[${n}/${files.length}] `);
    const err = await download(f, f, outPath);
    if (err) {
      console.error(err);
      failed++;
    }
  }
  console.log(`roster done: ${files.length} files, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const entries = await loadManifest({ refresh });
for (const name of names) {
  const m = bestMatch(name, entries);
  if (!m.entry) {
    console.error(`no unique catalog entry for ${JSON.stringify(name)}`);
    const c = m.candidates;
    if (c.length === 0) console.error("  (no candidates)");
    for (const s of c.slice(0, 10)) console.error(`  available: "${s.d}"`);
    if (c.length > 10) console.error(`  ... and ${c.length - 10} more`);
    failed++;
    continue;
  }
  const display = m.entry.d ?? name;
  if (list) {
    console.log(`${display} -> ${m.entry.f}`);
    continue;
  }
  const err = await download(
    m.entry.f,
    display,
    out ?? join(dir ?? join(root, "tmp", "mtf"), m.entry.f),
  );
  if (err) {
    console.error(err);
    failed++;
  }
}
if (failed > 0) process.exit(1);
