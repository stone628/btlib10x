import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Optional overrides: `--mechs <dir> --maps <dir|none> --out <file>`.
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? resolve(args[i + 1]) : fallback;
};
const mechsDir = opt("mechs", join(root, "data", "mechs"));
const noMaps = args[args.indexOf("--maps") + 1] === "none";
const mapsDir = opt("maps", join(root, "data", "maps"));
const outFile = opt("out", join(root, "data", "btlib10x.jsonl"));
// Optional `--exclude a.json,b.json`: source sheets to leave out of this
// pack (for sheets the engine cannot model).
const excludeIdx = args.indexOf("--exclude");
const excluded = new Set(
  excludeIdx >= 0 && args[excludeIdx + 1] !== undefined
    ? args[excludeIdx + 1].split(",").map((f) => f.trim())
    : [],
);

/**
 * Packs the canonical `data/mechs/*.json` sheets and `data/maps/*.json`
 * sources into a single catalog file.
 *
 * The SW season pack is packed the same way from its own sources (see
 * `npm run pack:sw`): each pack file keeps a separate string table, and
 * the engine tags entries with the pack id at load time (`loadCatalog` /
 * `appendCatalog`), so this script needs no pack option.
 *
 * Line 0: string table (bare JSON array) — chassis names + weapon names in
 * first-seen pack order (mech manifest order, then weapons in p[], then
 * crit slots in LOCATIONS order).
 * Lines 1+ are relaxed JSON (unquoted identifier keys; see src/data/relaxed-json.ts).
 * Line 1: manifest `{v, mechs, maps}` with absolute file line numbers
 * (mech `n` is a numeric index into the string table; `l >= 2`).
 * Lines 2+: compact wire lines (maps carry only `t`; name/size live in the manifest) — weapon names are numeric string-table indices; no `s` field.
 *
 * Weight class is inferred with `weightClassForTonnage`, never stored.
 * Run via `npm run pack`; web/test/dev load it with `loadCatalog`.
 */

// Compact-wire tables: mirror of the TS codecs (plus CRIT_*_NAMES order in
// src/data/mech.schema.ts and TERRAIN_TYPES order in src/core/types.ts, both
// wire-stable and append-only). Covered by the decode-every-line round-trip
// in tests/catalog.test.ts.
const LOC_CODES = {
  head: "h",
  centerTorso: "C",
  rightTorso: "R",
  leftTorso: "L",
  rightArm: "a",
  leftArm: "A",
  rightLeg: "g",
  leftLeg: "G",
  centerTorsoRear: "c",
  rightTorsoRear: "r",
  leftTorsoRear: "l",
};
const LOCATIONS = [
  "head",
  "centerTorso",
  "rightTorso",
  "leftTorso",
  "rightArm",
  "leftArm",
  "rightLeg",
  "leftLeg",
];
const KIND_IDS = { empty: 0, weapon: 1, ammo: 2, structure: 3, soak: 4 };
const STRUCTURE_NAMES = [
  "cockpit",
  "sensors",
  "lifeSupport",
  "engine",
  "gyro",
  "heatSink",
  "doubleHeatSink",
  "jumpJet",
  "shoulder",
  "upperArmActuator",
  "lowerArmActuator",
  "handActuator",
  "upperLegActuator",
  "lowerLegActuator",
  "footActuator",
  "targetingComputer",
  "hip",
];
const SOAK_NAMES = ["endoSteel", "ferroFibrous", "case", "caseII", "tsm", "equipment"];
const MYOMER_IDS = { Standard: 1, "Triple Strength Myomer": 2 };
const TERRAIN_TYPES = [
  "clear",
  "lightWoods",
  "heavyWoods",
  "rough",
  "rubble",
  "pavement",
  "water1",
  "water2",
  "water3",
  "lightBuilding",
  "mediumBuilding",
  "heavyBuilding",
  "hardenedBuilding",
];
const TECHBASE_CODES = {
  "Inner Sphere": 1,
  Clan: 2,
};

// Relaxed JSON: mirror of src/data/relaxed-json.ts `encodeRelaxed` (identifier
// keys unquoted). Mech/map wire lines and the manifest use it; line 0 (a bare
// string array) is plain JSON.
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function encodeRelaxed(value) {
  if (Array.isArray(value)) return `[${value.map(encodeRelaxed).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const parts = [];
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      parts.push(`${IDENT_RE.test(k) ? k : JSON.stringify(k)}:${encodeRelaxed(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

// String interning (first-seen order)
const strings = [];
const stringIndex = new Map();

function intern(value) {
  let idx = stringIndex.get(value);
  if (idx === undefined) {
    idx = strings.length;
    strings.push(value);
    stringIndex.set(value, idx);
  }
  return idx;
}

function nameIndex(table, name) {
  const idx = table.indexOf(name);
  if (idx < 0) throw new Error(`pack-catalog: unknown slot name ${JSON.stringify(name)}`);
  return idx;
}

function encodeMechDef(def) {
  const armor = {};
  for (const [key, value] of Object.entries(def.armor)) {
    armor[LOC_CODES[key]] = value;
  }
  const weapons = def.weapons.map((m) => ({
    w: intern(m.weapon),
    l: LOC_CODES[m.location],
    ...(m.shots !== undefined && { s: m.shots }),
    ...(m.rearFacing === true && { r: 1 }),
  }));
  const critSlots = {};
  for (const loc of LOCATIONS) {
    critSlots[LOC_CODES[loc]] = def.critSlots[loc].map((slot) => {
      switch (slot.kind) {
        case "empty":
          return { k: KIND_IDS.empty };
        case "weapon":
          return {
            k: KIND_IDS.weapon,
            w: intern(slot.weapon),
            ...(slot.rearFacing === true && { r: 1 }),
          };
        case "ammo":
          return { k: KIND_IDS.ammo, w: intern(slot.weapon) };
        case "structure":
          return { k: KIND_IDS.structure, n: nameIndex(STRUCTURE_NAMES, slot.name) };
        case "soak":
          return { k: KIND_IDS.soak, n: nameIndex(SOAK_NAMES, slot.name) };
        default:
          throw new Error(`pack-catalog: unknown slot kind ${JSON.stringify(slot.kind)}`);
      }
    });
  }
  return encodeRelaxed({
    v: 1,
    w: def.walking,
    r: def.running,
    j: def.jumping,
    a: armor,
    p: weapons,
    c: critSlots,
    h: { t: def.heatsink.type === "double" ? 1 : 0, c: def.heatsink.count },
    y: MYOMER_IDS[def.myomer] ?? 1,
  });
}

function encodeMapDef(src) {
  return encodeRelaxed({
    v: 1,
    t: src.terrain.map((hex) => ({
      c: hex.col,
      r: hex.row,
      t: TERRAIN_TYPES.indexOf(hex.type),
      ...(hex.level !== undefined && { l: hex.level }),
    })),
  });
}

const mechFiles = readdirSync(mechsDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .filter((f) => {
    if (!excluded.has(f)) return true;
    console.log(`skip excluded ${f}`);
    return false;
  });
const mapFiles = (noMaps ? [] : readdirSync(mapsDir)).filter((f) => f.endsWith(".json")).sort();

const wireLines = [];
const mechEntries = [];
const mapEntries = [];
const seenModels = new Set();
const seenMaps = new Set();

// First pass: collect mech entries and intern strings (chassis names + weapons)
// Line numbers: 0 = string table, 1 = manifest, 2+ = wire lines
for (const file of mechFiles) {
  const def = JSON.parse(readFileSync(join(mechsDir, file), "utf8"));
  for (const key of ["model", "name", "techBase", "tonnage", "intro"]) {
    if (def[key] === undefined) {
      throw new Error(`pack-catalog: ${file} is missing ${JSON.stringify(key)}`);
    }
  }
  const id = String(def.model).toLowerCase();
  if (seenModels.has(id))
    throw new Error(`pack-catalog: duplicate model ${JSON.stringify(def.model)}`);
  seenModels.add(id);

  // Intern chassis name
  const nameRef = intern(def.name);

  // Intern weapon names from weapons array
  for (const w of def.weapons) {
    intern(w.weapon);
  }
  // Intern weapon names from crit slots (LOCATIONS order)
  for (const loc of LOCATIONS) {
    for (const slot of def.critSlots[loc]) {
      if (slot.kind === "weapon" || slot.kind === "ammo") {
        intern(slot.weapon);
      }
    }
  }

  mechEntries.push({
    m: def.model,
    n: nameRef,
    b: TECHBASE_CODES[def.techBase] ?? 0,
    t: def.tonnage,
    i: def.intro,
    ...(def.clanName !== undefined && { c: def.clanName }),
    ...(def.callsign !== undefined && { k: def.callsign }),
    l: wireLines.length + 2, // +2 for string table (line 0) + manifest (line 1)
  });
  wireLines.push(encodeMechDef(def));
}

// Second pass: maps (no new strings needed)
for (const file of mapFiles) {
  const src = JSON.parse(readFileSync(join(mapsDir, file), "utf8"));
  for (const key of ["name", "width", "height", "terrain"]) {
    if (src[key] === undefined) {
      throw new Error(`pack-catalog: ${file} is missing ${JSON.stringify(key)}`);
    }
  }
  if (seenMaps.has(src.name))
    throw new Error(`pack-catalog: duplicate map ${JSON.stringify(src.name)}`);
  seenMaps.add(src.name);
  mapEntries.push({ n: src.name, w: src.width, h: src.height, l: wireLines.length + 2 });
  wireLines.push(encodeMapDef(src));
}

// Build output: string table (line 0), manifest (line 1), wire lines (2+)
const stringTableLine = JSON.stringify(strings);
const manifestLine = encodeRelaxed({ v: 1, mechs: mechEntries, maps: mapEntries });
const output = `${stringTableLine}\n${manifestLine}\n${wireLines.join("\n")}\n`;

writeFileSync(outFile, output);
console.log(
  `Packed ${outFile} (${mechEntries.length} 'Mechs, ${mapEntries.length} maps, ${strings.length} strings).`,
);
