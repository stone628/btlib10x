/**
 * Merges `critSlots` from the MTF body-part sections into the existing
 * data/mechs/*.json files. This is a one-shot migration for the eight
 * hand-transcribed 'Mechs whose JSONs pre-date the crit-slot table; once
 * backfilled, `npm run pack` + `npm test` will validate the linkage
 * against the weapons array via `validateMechDef`.
 *
 * Behavior:
 *   - Reads each data/mechs/<id>.json.
 *   - Locates the matching MTF in docs/mtf/ by name (line 1 of the MTF must
 *     equal the JSON `name` field). This skips the `model` line, which is
 *     sometimes a non-alpha variant code that the converter rejects (e.g.
 *     the Mad Cat Mk II's "2" variant).
 *   - Calls the shared `parseCritSlots` from scripts/mtf-crit.mjs and adds
 *     `critSlots` to the JSON object. Every other field stays byte-identical.
 *   - Performs a linkage precheck: every crit-slot weapon reference must
 *     resolve to a weapon mount in the same location; ammo bins must match
 *     an ammo-bearing mount anywhere on the 'Mech. When the MTF disagrees
 *     with the hand-transcribed weapons (e.g. a 'Mech whose MTF is from a
 *     different source), the backfill skips and reports so the slots can be
 *     entered by hand.
 *   - Rejects the write if `parseCritSlots` produced any error or the
 *     precheck fails.
 *
 * Use `node scripts/backfill-crits.mjs --dry-run` to preview.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCritSlots, validateCritConstruction } from "./mtf-crit.mjs";
import { LOCATIONS } from "./mtf-tables.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mtfDir = join(root, "docs", "mtf");
const mechsDir = join(root, "data", "mechs");
const dryRun = process.argv.includes("--dry-run");

/** Map JSON name -> MTF file path. */
function locateMtfByName(jsonName) {
  const files = readdirSync(mtfDir).filter((f) => f.endsWith(".mtf"));
  for (const f of files) {
    const text = readFileSync(join(mtfDir, f), "utf8");
    const first = text.split(/\r?\n/)[1]?.trim() ?? "";
    if (first === jsonName) return { file: f, text };
  }
  return null;
}

/** Pull the header fields the crit validator needs out of MTF text. */
function mtfHeaderFields(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }
  return {
    techBase: fields.TechBase,
    engineField: fields.Engine,
    structureField: fields.Structure,
    armorField: fields.Armor,
  };
}

/** Returns null if linkage is clean, or the first failure description. */
function linkageCheck(critSlots, weapons) {
  const localNames = new Map(); // location -> set of weapon names
  const ammoBearing = new Set(); // any-location ammo-bearing weapon names
  for (const w of weapons) {
    const set = localNames.get(w.location) ?? new Set();
    set.add(w.weapon);
    localNames.set(w.location, set);
    if (typeof w.shots === "number") ammoBearing.add(w.weapon);
  }
  for (const loc of LOCATIONS) {
    const slots = critSlots[loc];
    if (!Array.isArray(slots)) continue;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot.kind === "empty") continue;
      if (slot.kind === "weapon") {
        const set = localNames.get(loc);
        if (!set?.has(slot.weapon)) {
          return `${loc}[${i}]: no mount of ${JSON.stringify(slot.weapon)} in ${loc}`;
        }
      } else if (slot.kind === "ammo") {
        if (!ammoBearing.has(slot.weapon)) {
          return `${loc}[${i}]: no ammo-bearing mount of ${JSON.stringify(slot.weapon)}`;
        }
      }
    }
  }
  return null;
}

let touched = 0;
let skipped = 0;
let failed = 0;
for (const jsonFile of readdirSync(mechsDir)
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  const jsonPath = join(mechsDir, jsonFile);
  const data = JSON.parse(readFileSync(jsonPath, "utf8"));
  if (data.critSlots) {
    console.log(`skip ${jsonFile}: critSlots already present`);
    skipped++;
    continue;
  }
  const mtf = locateMtfByName(data.name);
  if (!mtf) {
    console.error(`FAIL ${jsonFile}: no MTF in docs/mtf/ with name ${JSON.stringify(data.name)}`);
    failed++;
    continue;
  }
  const errors = [];
  const critSlots = parseCritSlots(mtf.text.split(/\r?\n/), errors, mtf.file);
  validateCritConstruction(critSlots, mtfHeaderFields(mtf.text), errors);
  if (errors.length > 0) {
    console.error(`FAIL ${jsonFile} (from ${mtf.file}):`);
    for (const e of errors) console.error(`  - ${e}`);
    failed++;
    continue;
  }
  const linkageErr = linkageCheck(critSlots, data.weapons);
  if (linkageErr) {
    console.error(
      `SKIP ${jsonFile} (from ${mtf.file}): MTF crit slots disagree with the hand-transcribed weapons — ${linkageErr}. Transcribe critSlots manually.`,
    );
    skipped++;
    continue;
  }
  const updated = { ...data, critSlots };
  if (dryRun) {
    console.log(`would write ${jsonFile} (${mtf.file})`);
  } else {
    writeFileSync(jsonPath, `${JSON.stringify(updated, null, 2)}\n`);
    console.log(`wrote ${jsonFile} (from ${mtf.file})`);
    touched++;
  }
}
console.log(
  `\n${touched} written, ${skipped} already had critSlots or were skipped, ${failed} failed.${dryRun ? " (dry run)" : ""}`,
);
if (failed > 0) process.exit(1);
