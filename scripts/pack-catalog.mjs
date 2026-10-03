import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mechsDir = join(root, "data", "mechs");
const mapsDir = join(root, "data", "maps");
const outFile = join(root, "data", "btlib10x.jsonl");

/**
 * Packs the canonical `data/mechs/*.json` sheets and `data/maps/*.json`
 * sources into a single catalog file. Line 0 is the manifest
 * `{v, mechs, maps}` with absolute file line numbers; the remaining lines
 * are compact wire lines (see `src/data/mech.codec.ts` and
 * `src/data/map.codec.ts` — the tables below must match them exactly).
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
const SOAK_NAMES = ["endoSteel", "ferroFibrous", "case", "caseII", "tsm"];
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

function encodeMechDef(def) {
  const armor = {};
  for (const [key, value] of Object.entries(def.armor)) {
    armor[LOC_CODES[key]] = value;
  }
  const weapons = def.weapons.map((m) => ({
    w: m.weapon,
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
            w: slot.weapon,
            ...(slot.rearFacing === true && { r: 1 }),
          };
        case "ammo":
          return { k: KIND_IDS.ammo, w: slot.weapon };
        case "structure":
          return { k: KIND_IDS.structure, n: STRUCTURE_NAMES.indexOf(slot.name) };
        case "soak":
          return { k: KIND_IDS.soak, n: SOAK_NAMES.indexOf(slot.name) };
        default:
          throw new Error(`pack-catalog: unknown slot kind ${JSON.stringify(slot.kind)}`);
      }
    });
  }
  return JSON.stringify({
    v: 1,
    w: def.walking,
    r: def.running,
    j: def.jumping,
    a: armor,
    p: weapons,
    c: critSlots,
    h: { t: def.heatsink.type === "double" ? 1 : 0, c: def.heatsink.count },
    y: MYOMER_IDS[def.myomer] ?? 1,
    s: def.source,
  });
}

function encodeMapDef(src) {
  return JSON.stringify({
    v: 1,
    n: src.name,
    w: src.width,
    h: src.height,
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
  .sort();
const mapFiles = readdirSync(mapsDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

const lines = [];
const mechEntries = [];
const mapEntries = [];
const seenModels = new Set();
const seenMaps = new Set();

for (const file of mechFiles) {
  const def = JSON.parse(readFileSync(join(mechsDir, file), "utf8"));
  for (const key of ["model", "name", "techBase", "tonnage"]) {
    if (def[key] === undefined) {
      throw new Error(`pack-catalog: ${file} is missing ${JSON.stringify(key)}`);
    }
  }
  const id = String(def.model).toLowerCase();
  if (seenModels.has(id))
    throw new Error(`pack-catalog: duplicate model ${JSON.stringify(def.model)}`);
  seenModels.add(id);
  mechEntries.push({
    m: def.model,
    n: def.name,
    b: TECHBASE_CODES[def.techBase] ?? 0,
    t: def.tonnage,
    ...(def.clanName !== undefined && { c: def.clanName }),
    l: lines.length + 1, // +1 for the manifest on line 0
  });
  lines.push(encodeMechDef(def));
}

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
  mapEntries.push({ n: src.name, w: src.width, h: src.height, l: lines.length + 1 });
  lines.push(encodeMapDef(src));
}

const manifest = JSON.stringify({ v: 1, mechs: mechEntries, maps: mapEntries });
writeFileSync(outFile, `${[manifest, ...lines].join("\n")}\n`);
console.log(`Packed ${outFile} (${mechEntries.length} 'Mechs, ${mapEntries.length} maps).`);
