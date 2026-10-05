/**
 * Shared Flechs Sheets catalog helpers (dev-only): manifest cache, parsing and
 * name lookup. Used by fetch-mtf.mjs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE = "https://helm-kore-fragment.s3.amazonaws.com/";
export const MANIFEST_URL = `${BASE}unitList.xml`;
export const MEK_DIR = `${BASE}mtf/meks/`;
export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const manifestCache = join(root, "tmp", "mtf", "unitList.xml");

/** Minimal manifest parse: collects {d,a,dd,f} from each <u .../> entry. */
export function parseManifest(xml) {
  const entries = [];
  for (const m of xml.matchAll(/<u\s+([^>]*?)\/>/g)) {
    const attrs = {};
    for (const am of m[1].matchAll(/(\w+)="([^"]*)"/g)) {
      attrs[am[1]] = am[2];
    }
    // skip "No Frakenmech Data.nope" placeholders
    if (attrs.f?.endsWith(".mtf")) entries.push(attrs);
  }
  return entries;
}

/** Load the manifest (cached at tmp/mtf/unitList.xml unless `refresh`). */
export async function loadManifest({ refresh = false } = {}) {
  let xml;
  if (!refresh && existsSync(manifestCache)) {
    xml = readFileSync(manifestCache, "utf8");
  } else {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) throw new Error(`failed to fetch manifest ${MANIFEST_URL}: ${res.status}`);
    xml = await res.text();
    mkdirSync(dirname(manifestCache), { recursive: true });
    writeFileSync(manifestCache, xml);
  }
  return parseManifest(xml);
}

function spellingVariants(q) {
  return [
    q,
    q.replace(/Mech/g, "Mek").replace(/mech/g, "mek"),
    q.replace(/Mek/g, "Mech").replace(/mek/g, "mech"),
  ];
}

export function entryNames(e) {
  return [e.d, e.a, e.dd].filter(Boolean);
}

export function findEntry(query, entries) {
  for (const v of spellingVariants(query)) {
    const hit = entries.find((e) => entryNames(e).includes(v));
    if (hit) return hit;
  }
  const lower = new Set(spellingVariants(query).map((v) => v.toLowerCase()));
  return entries.find((e) => entryNames(e).some((n) => lower.has(n.toLowerCase()))) ?? null;
}

/** Entries whose names contain every whitespace-separated token of `query`. */
export function suggestions(query, entries, limit = 10) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .filter((e) => {
      const hay = entryNames(e).join(" | ").toLowerCase();
      return tokens.every((t) => hay.includes(t));
    })
    .slice(0, limit);
}

/**
 * Exact lookup, else a single token-AND candidate. Returns
 * `{ entry }` on a unique best match, `{ candidates }` otherwise.
 */
export function bestMatch(query, entries) {
  const exact = findEntry(query, entries);
  if (exact) return { entry: exact };
  const candidates = suggestions(query, entries, Number.POSITIVE_INFINITY);
  const [only] = candidates;
  if (candidates.length === 1 && only) return { entry: only };
  return { candidates };
}

/** Strip a trailing `(Nick)` / `"Nick"` from a model designation. */
export function normalizeModel(m) {
  return (m ?? "").replace(/\s*[("].*$/, "").trim();
}
