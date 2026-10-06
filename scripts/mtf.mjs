import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ammoBinsFromCrits,
  parseCritSlots,
  validateCritConstruction,
  validateHeatSinks,
} from "./mtf-crit.mjs";
import {
  CODE,
  catalogWeapon,
  EQUIPMENT_WEAPONS,
  INERT_EQUIPMENT,
  LOCATION,
  MODEL_PREFIX_NAME,
  SHOTS_PER_TON,
} from "./mtf-tables.mjs";

/**
 * Batch converts BattleTech .mtf (MechTech File) definitions into the library's
 * MechDef JSON. Drop a .mtf into docs/mtf/ and run `npm run mtf`; the new 'Mech
 * is emitted to data/mechs/ and auto-registered by the catalog generator.
 *
 * Conventions (must match data/mechs/*.json):
 *   - Flat armor per location; torso values store the FRONT hit points only
 *     (MTF `CT/RT/LT Armor`). The rear torso values (`RTC/RTR/RTL Armor`)
 *     are stored separately inside `armor` as `centerTorsoRear` /
 *     `leftTorsoRear` / `rightTorsoRear` (metadata for the rear damage pool;
 *     the engine's `armor` front pool never includes them).
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
const mtfDir = process.env.MTF_IN_DIR ? process.env.MTF_IN_DIR : join(root, "docs", "mtf");
const outDir = process.env.MTF_OUT_DIR ? process.env.MTF_OUT_DIR : join(root, "data", "mechs");
const force = process.argv.includes("--force");

function weightClass(tonnage) {
  if (tonnage <= 35) return "Light";
  if (tonnage <= 55) return "Medium";
  if (tonnage <= 75) return "Heavy";
  return "Assault";
}

function numberRegex(text, label) {
  const m = text.match(new RegExp(`^${label}:\\s*(\\d+)`, "im"));
  return m ? Number(m[1]) : null;
}

/** Normalize an MTF weapon line into {code, location, explicitAmmo, rearFacing}. */
function splitWeaponLine(line) {
  const parts = line.split(",").map((s) => s.trim());
  let codeRaw = (parts[0] ?? "").replace(/^\d+\s+/, "").trim();
  let rearFacing = false;
  const facingMatch = codeRaw.match(/\((R|F)\)\s*$/);
  if (facingMatch) {
    rearFacing = facingMatch[1] === "R";
    codeRaw = codeRaw.replace(/\((R|F)\)\s*$/, "").trim();
  }
  const location = (parts[1] ?? "").trim();
  // Some sheets put the facing on the location instead ("Center Torso (R)",
  // e.g. CN9-YLW2); accept it there too.
  const locFacing = location.match(/\((R|F)\)\s*$/);
  if (locFacing) {
    rearFacing = locFacing[1] === "R";
  }
  const cleanLocation = location.replace(/\s*\((R|F)\)\s*$/, "").trim();
  let explicitAmmo = null;
  if (parts[2]) {
    const m = parts[2].match(/^Ammo:(\d+)/);
    if (m) explicitAmmo = Number(m[1]);
  }
  return { codeRaw, location: cleanLocation, explicitAmmo, rearFacing };
}

function mapWeapon(codeRaw, clan) {
  // Clan sheets prefer the catalog lookup so unprefixed names ("ER PPC",
  // "Ultra AC/10") resolve to the Clan weapon; IS sheets keep the legacy table first.
  return clan
    ? (catalogWeapon(codeRaw, true) ?? CODE[codeRaw] ?? null)
    : (CODE[codeRaw] ?? catalogWeapon(codeRaw, false));
}

function parseMtf(text, file) {
  const errors = [];
  const lines = text.split(/\r?\n/);
  // Two sheet layouts exist: the classic positional one (name on line 2,
  // model on line 3) and the newer keyed one ("chassis:" / "model:" with
  // lowercase headers throughout).
  const keyed = /^chassis:/im.test(text);
  const keyedField = (key) =>
    lines
      .find((l) => l.toLowerCase().startsWith(`${key}:`))
      ?.slice(key.length + 1)
      .trim() ?? "";
  const rawName = keyed ? keyedField("chassis") : (lines[1]?.trim() ?? "");
  const variant = keyed ? keyedField("model") : (lines[2]?.trim() ?? "");
  if (!rawName) errors.push(`missing name in ${file}`);
  // A missing model is tolerated only for Clan sheets (see the policy below).
  const clanSheet = /^TechBase:\s*Clan/im.test(text);
  if (!variant && !clanSheet) errors.push(`missing model in ${file}`);
  // Line 2 is `<NAME>` or `<NAME> (<CLANNAME>)` for Clan sheets
  // ("Mad Cat (Timber Wolf)"). The parenthesised Clan name becomes the
  // optional `clanName`; when the parens are absent `clanName` stays
  // undefined even for Clan-techBase sheets.
  let name = rawName;
  let clanName;
  const clanMatch = rawName.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (clanMatch) {
    name = clanMatch[1].trim();
    clanName = clanMatch[2].trim() || undefined;
  }

  // Header keys are matched case-insensitively; known keys are canonicalised
  // so the lookups below can use the classic spelling.
  const CANON = Object.fromEntries(
    [
      "TechBase",
      "Myomer",
      "Engine",
      "Structure",
      "Armor",
      "HD Armor",
      "CT Armor",
      "RT Armor",
      "LT Armor",
      "RA Armor",
      "LA Armor",
      "LL Armor",
      "RL Armor",
      "RTC Armor",
      "RTR Armor",
      "RTL Armor",
    ].map((k) => [k.toLowerCase(), k]),
  );
  const fields = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    fields[CANON[key.toLowerCase()] ?? key] = line.slice(idx + 1).trim();
  }
  const techBase = fields.TechBase ?? "Inner Sphere";

  // Model codes: Inner Sphere sheets carry the full code on MTF line 3
  // ("HBK-4G") and it is used verbatim. Clan sheets carry a bare variant
  // ("Prime", "2"), so the catalog key is synthesised from
  // MODEL_PREFIX_NAME (`<prefix>-<variant>`, e.g. "TBR-Prime"); a missing
  // table entry is a hard error, never a silent verbatim fallback.
  let model = variant;
  if (techBase === "Clan") {
    const entry = MODEL_PREFIX_NAME[rawName] ?? MODEL_PREFIX_NAME[name];
    if (!entry) {
      return {
        def: null,
        errors: [
          `missing MODEL_PREFIX_NAME entry for ${JSON.stringify(rawName)}; add it to scripts/mtf-tables.mjs`,
        ],
      };
    }
    // Variants may be parenthesised ("(Standard)") or spaced ("C 2"); fold
    // them into a single token for the catalog key. Policy when the sheet has
    // no variant id (empty or "(Standard)"): Clan OmniMechs become "<prefix>-Prime"; Clan BattleMechs
    // (standard or IIC) keep the bare "<prefix>".
    const isOmni = /^Biped Omni/i.test(fields.Config ?? "");
    // "(Standard)" is the sheets' placeholder for "no variant id".
    const bareVariant = variant.replace(/[()]/g, "").trim();
    const variantKey =
      bareVariant && !/^standard$/i.test(bareVariant)
        ? bareVariant.replace(/\s+/g, "-")
        : isOmni
          ? "Prime"
          : "";
    model = variantKey ? `${entry.prefix}-${variantKey}` : entry.prefix;
    name = entry.name;
  } else {
    // Inner Sphere sheets must carry a distinct model code on line 3 (it is the
    // catalog key). A bare variant ("C", "Prime") is reported, never guessed.
    if (model && !/[0-9-]/.test(model.replace(/\s+['"].*$/, ""))) {
      return {
        def: null,
        errors: [
          `Inner Sphere sheet has no distinct model string (variant ${JSON.stringify(model)}); needs manual import`,
        ],
      };
    }
    if (model && !/[A-Za-z]/.test(model)) {
      return {
        def: null,
        errors: [`variant ${JSON.stringify(model)} is not a model code; import this one manually`],
      };
    }
    // Variants may carry a quoted nickname suffix (e.g. CN9-YLW2's
    // "CN9-YLW2 'Yen Lo Wang'"); the catalog key is the bare model code.
    model = model.replace(/\s+['"].*$/, "").trim();
  }
  // MTF model codes are emitted all-caps in the catalog so the registry key
  // and the on-disk filename (`<model>.json`) are case-stable.
  // model = model.toUpperCase();

  const tonnage = numberRegex(text, "Mass");
  const walking = numberRegex(text, "Walk MP");
  const jumping = numberRegex(text, "Jump MP") ?? 0;

  // Heat Sinks:N <Single|Double> header -> canon heat sink config (total
  // count including engine-mounted sinks). Classic construction rule: an
  // engine mounts floor(walking * tonnage / 25) sinks internally; the rest
  // occupy crit slots.
  const heatsinkMatch = /^Heat Sinks:\s*(\d+)\s+(?:IS\s+|Clan\s+)?(Single|Double)\s*$/im.exec(text);
  let heatsink = null;
  if (heatsinkMatch) {
    heatsink = {
      type: heatsinkMatch[2].toLowerCase() === "double" ? "double" : "single",
      count: Number(heatsinkMatch[1]),
    };
  } else {
    errors.push("Heat Sinks header missing or malformed (expected 'N Single' or 'N Double')");
  }

  // Myomer: "Standard" everywhere so far except Triple-Strength sheets
  // (e.g. CN9-YLW2, "Myomer:Triple-Strength"). Canonical spelling matches
  // the crit-slot token ("Triple Strength Myomer").
  const myomer = /triple/i.test(fields.Myomer ?? "") ? "Triple Strength Myomer" : "Standard";

  // Flat armor; torso = FRONT only (MTF `CT/RT/LT Armor`). Rear torso values
  // (`RTC/RTR/RTL Armor`) are stored separately as `centerTorsoRear` /
  // `leftTorsoRear` / `rightTorsoRear` for the rear damage pool — never summed
  // into the front pool (TW pp.122-123: front and rear are separate pools).
  const armorTags = {
    "HD Armor": "head",
    "CT Armor": "centerTorso",
    "RT Armor": "rightTorso",
    "LT Armor": "leftTorso",
    "RA Armor": "rightArm",
    "LA Armor": "leftArm",
    "LL Armor": "rightLeg",
    "RL Armor": "leftLeg",
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

  const bins = ammoBinsFromCrits(lines, techBase);
  const parsed = block
    .map(splitWeaponLine)
    .filter(({ codeRaw }) => !INERT_EQUIPMENT.has(codeRaw))
    .map(({ codeRaw, location, explicitAmmo, rearFacing }) => {
      const weapon = mapWeapon(codeRaw, techBase === "Clan");
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
      return { weapon, location: loc, ammo, explicit: explicitAmmo !== null, rearFacing };
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

  const critSlots = parseCritSlots(lines, errors, file, techBase);

  // Mounts that sheets omit from the weapons block but name in crit slots:
  // physical weapons (Hatchet, TW p.146; e.g. CN9-YLW2 lists only guns there)
  // and EQUIPMENT-category gear (Active Probe, ECM, AMS, TAG, pods). One mount
  // is synthesised per crit-bearing location so the slot linkage in
  // `resolveMechDef` resolves (precedent: the hand-transcribed HCT-5S).
  for (const [loc, slots] of Object.entries(critSlots)) {
    for (const slot of slots) {
      if (slot.kind !== "weapon") continue;
      if (slot.weapon !== "Hatchet" && !EQUIPMENT_WEAPONS.has(slot.weapon)) continue;
      const hasMount = parsed.some((m) => m.weapon === slot.weapon && m.location === loc);
      if (!hasMount) {
        parsed.push({ weapon: slot.weapon, location: loc, ammo: null, explicit: false });
      }
    }
  }

  const weapons = parsed.map(({ weapon, location, ammo, rearFacing }) =>
    ammo !== null
      ? { weapon, location, shots: ammo, ...(rearFacing && { rearFacing: true }) }
      : { weapon, location, ...(rearFacing && { rearFacing: true }) },
  );

  // Build rear-facing map from crit slots: (location, weapon) -> true if any slot is rear-facing
  const rearFacingFromCrits = new Map();
  for (const [loc, slots] of Object.entries(critSlots)) {
    for (const slot of slots) {
      if (slot.kind === "weapon" && slot.rearFacing) {
        rearFacingFromCrits.set(`${loc}:${slot.weapon}`, true);
      }
    }
  }

  // Apply rear-facing from crit slots to weapon mounts (by location + weapon, in order)
  const mountCursors = new Map();
  for (const mount of weapons) {
    const key = `${mount.location}:${mount.weapon}`;
    const cursor = mountCursors.get(key) ?? 0;
    if (rearFacingFromCrits.get(key) === true) {
      mount.rearFacing = true;
    }
    mountCursors.set(key, cursor + 1);
  }

  // Mirrors the engine rule (validateMechDef): rear-facing mounts are only
  // supported on torso and head locations.
  for (const mount of weapons) {
    if (
      mount.rearFacing === true &&
      !["head", "centerTorso", "leftTorso", "rightTorso"].includes(mount.location)
    ) {
      errors.push(
        `rear-facing ${mount.weapon} in ${mount.location}: rear-facing is only supported on torso and head mounts`,
      );
    }
  }

  const critMeta = {
    techBase: fields.TechBase,
    engineField: fields.Engine,
    structureField: fields.Structure,
    armorField: fields.Armor,
    myomer,
    walking,
    tonnage,
    heatsink,
  };
  validateCritConstruction(critSlots, critMeta, errors);
  validateHeatSinks(critSlots, critMeta, errors);

  const def = {
    model,
    name,
    ...(clanName !== undefined && { clanName }),
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
    myomer,
  };

  return { def, errors };
}

const files = readdirSync(mtfDir)
  .filter((f) => f.endsWith(".mtf"))
  .sort();
let generated = 0;
let skipped = 0;
mkdirSync(outDir, { recursive: true });
let nonBiped = 0;
let mixed = 0;
const written = new Map();
for (const file of files) {
  const text = readFileSync(join(mtfDir, file), "utf8");
  // Bipedal 'Mechs only: LAM / Quad / Tripod sheets are out of scope.
  const config = /^Config:\s*(.*?)\s*$/m.exec(text)?.[1];
  if (config !== undefined && !/^Biped/i.test(config)) {
    nonBiped++;
    continue;
  }
  // Mixed tech base sheets are not supported yet.
  if (/^techbase:\s*Mixed/im.test(text)) {
    mixed++;
    continue;
  }
  const { def, errors } = parseMtf(text, file);
  if (def === null || errors.length > 0) {
    console.error(`SKIP ${file}:`);
    for (const e of errors) console.error(`  - ${e}`);
    continue;
  }
  const outFile = join(outDir, `${def.model.toLowerCase()}.json`);
  const owner = written.get(outFile);
  if (owner !== undefined) {
    console.error(`SKIP ${file}:`);
    console.error(`  - duplicate model code ${def.model} (already produced by ${owner})`);
    continue;
  }
  written.set(outFile, file);
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
  `\n${generated} generated, ${skipped} skipped, ${nonBiped} non-biped and ${mixed} mixed-tech ignored. Run 'npm run pack && npm test' to validate.`,
);
