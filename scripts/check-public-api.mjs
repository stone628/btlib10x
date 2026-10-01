#!/usr/bin/env node
// Fail when dist/index.d.ts and docs/API.md disagree on the public surface.
// Run via `npm run lint:api` (requires `npm run build` first so dist/ exists).

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INDEX_DTS = resolve(ROOT, "dist/index.d.ts");
const DOCS = resolve(ROOT, "docs/API.md");

const IDENT = /[A-Za-z_$][\w$]*/g;

// --- parse dist/index.d.ts ---------------------------------------------------

const indexSrc = await readFile(INDEX_DTS, "utf8");
const exports = new Set();
const blockRe = /^\s*export\s+(?:type\s+)?\{([^}]+)\}\s*(?:from\s+"[^"]+")?\s*;?\s*$/gm;
for (const m of indexSrc.matchAll(blockRe)) {
  for (const raw of m[1].split(",")) {
    const tok = raw.trim();
    if (!tok) continue;
    // strip `type ` prefix so `type Foo` collapses to `Foo`, and take the
    // exported name for `orig as alias` re-exports
    const cleaned = tok.replace(/^type\s+/, "").trim();
    const alias = cleaned.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
    const id = (alias?.[2] ?? cleaned).match(IDENT)?.[0];
    if (id) exports.add(id);
  }
}

// --- parse docs/API.md -------------------------------------------------------

const docsSrc = await readFile(DOCS, "utf8");
// backticked names: MUST be exported (a backtick is a strong "this is a symbol")
// but only when the name looks like a real symbol — PascalCase / UPPER_CASE /
// camelCase identifiers. Filters out single-letter direction codes (F, B,
// L, R), lowercase variable placeholders (mode, arc, rng, …), and prose
// words that happen to live in backticks (automatic, prone, damage, …).
const looksLikeSymbol = (n) =>
  /^[A-Z][A-Za-z0-9_$]*$/.test(n) || // PascalCase type/constant
  /^[A-Z][A-Z0-9_$]+$/.test(n) || // UPPER_CASE constant
  /^[a-z][A-Za-z0-9_$]*$/.test(n); // camelCase value/function
const backticked = new Set();
for (const m of docsSrc.matchAll(/`([A-Za-z_$][\w$]*)`/g)) {
  const n = m[1];
  if (looksLikeSymbol(n)) backticked.add(n);
}
// bare mentions anywhere in docs (word-boundary, case-sensitive)
const mentioned = new Set();
for (const m of docsSrc.matchAll(/(?<![A-Za-z_$0-9])([A-Za-z_$][\w$]*)(?![A-Za-z_$0-9])/g)) {
  mentioned.add(m[1]);
}

// --- diff --------------------------------------------------------------------

// ERROR: an export not mentioned anywhere in docs is an undocumented addition.
const exportedButMissing = [...exports].filter((n) => !mentioned.has(n)).sort();
// INFO: a symbol-shape backticked name not exported — usually doc drift
// (the docs describe a non-public symbol). Surfaced for review but not a
// gate, because prose often backticks placeholders like `mode` / `arc`.
const backtickedButMissing = [...backticked].filter((n) => !exports.has(n)).sort();

let bad = false;
if (exportedButMissing.length) {
  bad = true;
  console.error(
    `\nExported in dist/index.d.ts but not mentioned in docs/API.md (${exportedButMissing.length}):`,
  );
  for (const n of exportedButMissing) console.error(`  ${n}`);
}
if (backtickedButMissing.length) {
  console.warn(
    `\nBackticked in docs/API.md but not exported (${backtickedButMissing.length}) — review:`,
  );
  for (const n of backtickedButMissing) console.warn(`  ${n}`);
}

if (bad) {
  console.error(
    `\nPublic API drift. Run \`npm run build\` (so dist/ matches src/) and update docs/API.md.`,
  );
  process.exit(1);
}

console.log(
  `OK public-api check: ${exports.size} exports, ${backticked.size} backticked names; all agree with docs/API.md.`,
);
