import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ammoBinsFromCrits,
  parseCritSlots,
  validateCritConstruction,
  validateHeatSinks,
} from "./mtf-crit.mjs";
import { CODE, LOCATION, MODEL_CODE, SHOTS_PER_TON } from "./mtf-tables.mjs";

/**
 * Batch converts BattleTech .mtf (MechTech File) definitions into the library's
 * MechDef JSON. Drop a .mtf into docs/mtf/ and run `npm run mtf`; the new 'Mech
 * is emitted to src/data/mechs/ and auto-registered by the catalog generator.
 *
 * Conventions (must match src/data/mechs/*.json):
 *   - Flat armor per location; torso values SUM the MTF front + rear boxes. The
 *     rear torso values are also stored inside `armor` as `centerTorsoRear` /
 *     `leftTorsoRear` / `rightTorsoRear` (metadata only; the flat damage model
 *     reads the eight front locations).
 *   - Clan weapons use the catalog's "CL " prefix (e.g. CL Gauss Rifle).
 *   - Ammo is per-mount in the schema: a shared bin of N shots is written onto
 *     the single mount that carries an explicit `, Ammo:N`, else the first
 *     mount of that weapon; sibling launchers omit `shots`.
 *   - running = ceil(walking * 1.5) (quick-start convention).
 *   - Critical slot table per location is included (head/legs = 6 slots,
 *     torso/arms = 12; see scripts/mtf-crit.mjs).
 *
 * Existing target files are left untouched unless `--force` is passed, so
 * already-transcribed 'Mechs (the quick-start six) are never clobbered.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mtfDir = join(root, "docs", "mtf");
const outDir = process.env.MTF_OUT_DIR
  ? process.env.MTF_OUT_DIR
  : join(root, "src", "data", "mechs");
const force = process.argv.includes("--force");

function weightClass(tonnage) {
  if (tonnage <= 35) return "Light";
  if (tonnage <= 55) return "Medium";
  if (tonnage <= 75) return "Heavy";
  return "Assault";
}

function numberRegex(text, label) {
  const m = text.match(new RegExp(`^${label}:(\\d+)`, "m"));
  return m ? Number(m[1]) : null;
}

/** Normalize an MTF weapon line into {code, location, explicitAmmo}. */
function splitWeaponLine(line) {
  const parts = line.split(",").map((s) => s.trim());
  const codeRaw = (parts[0] ?? "")
    .replace(/^\d+\s+/, "")
    .replace(/\((R|F)\)\s*$/, "")
    .trim();
  const location = (parts[1] ?? "").trim();
  let explicitAmmo = null;
  if (parts[2]) {
    const m = parts[2].match(/^Ammo:(\d+)/);
    if (m) explicitAmmo = Number(m[1]);
  }
  return { codeRaw, location, explicitAmmo };
}

function mapWeapon(codeRaw) {
  return CODE[codeRaw] ?? null;
}

function parseMtf(text, file) {
  const errors = [];
  const lines = text.split(/\r?\n/);
  const name = lines[1]?.trim() ?? "";
  let model = lines[2]?.trim() ?? "";
  if (!name) errors.push(`missing name in ${file}`);
  if (!model) errors.push(`missing model in ${file}`);
  // The MTF `model` line is sometimes a short variant tag rather than a full
  // model code: e.g. Mad Cat Mk II writes "2" or Timber Wolf Prime writes
  // "Prime". When the name has a MODEL_CODE entry, synthesise a full model
  // code from the prefix plus the variant suffix ("MC-MKII-2", "TWB-Prime").
  // Skip only when the variant has no letters AND no MODEL_CODE entry — such
  // identifiers can't be turned into a reasonable key on their own.
  if (model && !/[A-Za-z]/.test(model) && !MODEL_CODE[name]) {
    return {
      def: null,
      errors: [`variant ${JSON.stringify(model)} is not a model code; import this one manually`],
    };
  }
  if (model && MODEL_CODE[name] && !model.includes("-")) {
    model = `${MODEL_CODE[name]}-${model}`;
  }
  // MTF model codes are emitted all-caps in the catalog so the registry key
  // and the on-disk filename (`<model>.json`) are case-stable.
  // model = model.toUpperCase();

  const fields = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }

  const tonnage = numberRegex(text, "Mass");
  const walking = numberRegex(text, "Walk MP");
  const jumping = numberRegex(text, "Jump MP") ?? 0;

  // Heat Sinks:N <Single|Double> header -> canon heat sink config (total
  // count including engine-mounted sinks). Classic construction rule: an
  // engine mounts floor(walking * tonnage / 25) sinks internally; the rest
  // occupy crit slots.
  const heatsinkMatch = /^Heat Sinks:\s*(\d+)\s+(Single|Double)\s*$/m.exec(text);
  let heatsink = null;
  if (heatsinkMatch) {
    heatsink = {
      type: heatsinkMatch[2].toLowerCase() === "double" ? "double" : "single",
      count: Number(heatsinkMatch[1]),
    };
  } else {
    errors.push("Heat Sinks header missing or malformed (expected 'N Single' or 'N Double')");
  }

  // Flat armor; torso = front + rear summed. Rear torso values are also stored
  // alongside, keyed as `centerTorsoRear`/`leftTorsoRear`/`rightTorsoRear`
  // metadata (not used by the flat damage model).
  const armorTags = {
    "HD Armor": "head",
    "CT Armor": "centerTorso",
    "RT Armor": "rightTorso",
    "LT Armor": "leftTorso",
    "RA Armor": "rightArm",
    "LA Armor": "leftArm",
    "LL Armor": "rightLeg",
    "RL Armor": "leftLeg",
    "RTC Armor": "centerTorso",
    "RTR Armor": "rightTorso",
    "RTL Armor": "leftTorso",
  };
  const rearKeys = {
    "RTC Armor": "centerTorsoRear",
    "RTR Armor": "rightTorsoRear",
    "RTL Armor": "leftTorsoRear",
  };
  const armor = {
    head: 0,
    centerTorso: 0,
    rightTorso: 0,
    leftTorso: 0,
    rightArm: 0,
    leftArm: 0,
    rightLeg: 0,
    leftLeg: 0,
  };
  for (const [tag, key] of Object.entries(armorTags)) {
    const raw = fields[tag];
    if (raw !== undefined) armor[key] += Number(raw);
  }
  for (const [tag, key] of Object.entries(rearKeys)) {
    const raw = fields[tag];
    if (raw !== undefined) armor[key] = Number(raw);
  }

  // Weapons block: text after "Weapons:N", up to the first body-part header.
  const weaponsStart = lines.findIndex((l) => /^Weapons:\s*\d+/i.test(l));
  if (weaponsStart < 0) errors.push("Weapons block missing");
  const block = [];
  if (weaponsStart >= 0) {
    for (let i = weaponsStart + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === "") break;
      if (/ Arm:$| Leg:$| Torso:$| Head:$/.test(t)) break;
      block.push(t);
    }
  }

  const bins = ammoBinsFromCrits(lines);
  const parsed = block
    .map(splitWeaponLine)
    .map(({ codeRaw, location, explicitAmmo }) => {
      const weapon = mapWeapon(codeRaw);
      if (!weapon) {
        errors.push(`Unmapped weapon code ${JSON.stringify(codeRaw)}`);
        return null;
      }
      const loc = LOCATION[location];
      if (!loc) {
        errors.push(`Unmapped location ${JSON.stringify(location)} (${codeRaw})`);
        return null;
      }
      // Ammo per mount: explicit `, Ammo:N` wins; else crit bins x shots/ton.
      let ammo = explicitAmmo;
      if (ammo === null && SHOTS_PER_TON[weapon] && (bins.get(weapon) ?? 0) > 0) {
        ammo = bins.get(weapon) * SHOTS_PER_TON[weapon];
      }
      return { weapon, location: loc, ammo, explicit: explicitAmmo !== null };
    })
    .filter((m) => m !== null);

  // Shared bins: keep one `shots` per weapon (the explicit mount, else the
  // first), null the rest. Omit ammo entirely when a weapon has no ammo data.
  const perWeapon = new Map();
  for (const m of parsed) {
    if (m.ammo === null) continue;
    const cur = perWeapon.get(m.weapon);
    if (!cur || cur.explicit === false) perWeapon.set(m.weapon, m);
  }
  for (const m of parsed) {
    if (m.ammo === null) continue;
    const owner = perWeapon.get(m.weapon);
    if (owner !== m) m.ammo = null;
  }

  const weapons = parsed.map(({ weapon, location, ammo }) =>
    ammo !== null ? { weapon, location, shots: ammo } : { weapon, location },
  );

  const critSlots = parseCritSlots(lines, errors, file);
  const critMeta = {
    techBase: fields.TechBase,
    engineField: fields.Engine,
    structureField: fields.Structure,
    armorField: fields.Armor,
    walking,
    tonnage,
    heatsink,
  };
  validateCritConstruction(critSlots, critMeta, errors);
  validateHeatSinks(critSlots, critMeta, errors);

  const source = `docs/mtf/${file}${fields.Source ? ` (${fields.Source})` : ""}. Armor stores front values; rear torso armor kept as 'centerTorsoRear' etc.; shared ammo written on one mount; crit slot table per location included.`;

  const def = {
    model,
    name,
    tonnage,
    weightClass: tonnage ? weightClass(tonnage) : "Assault",
    techBase: fields.TechBase ?? "Inner Sphere",
    walking,
    running: walking ? Math.ceil(walking * 1.5) : null,
    jumping,
    armor,
    weapons,
    critSlots,
    heatsink,
    source,
  };

  return { def, errors };
}

const files = readdirSync(mtfDir)
  .filter((f) => f.endsWith(".mtf"))
  .sort();
let generated = 0;
let skipped = 0;
for (const file of files) {
  const { def, errors } = parseMtf(readFileSync(join(mtfDir, file), "utf8"), file);
  if (def === null || errors.length > 0) {
    console.error(`SKIP ${file}:`);
    for (const e of errors) console.error(`  - ${e}`);
    continue;
  }
  const outFile = join(outDir, `${def.model.toLowerCase()}.json`);
  if (existsSync(outFile) && !force) {
    console.log(`skip existing ${outFile.replace(`${root}/`, "")} (use --force to overwrite)`);
    skipped++;
    continue;
  }
  writeFileSync(outFile, `${JSON.stringify(def, null, 2)}\n`);
  console.log(`wrote ${outFile.replace(`${root}/`, "")}`);
  generated++;
}
console.log(
  `\n${generated} generated, ${skipped} skipped. Run 'npm run gen:mechs && npm test' to validate.`,
);
