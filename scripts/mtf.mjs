import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 *     mount of that weapon; sibling launchers omit `ammoShots`.
 *   - running = ceil(walking * 1.5) (quick-start convention).
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

const LOCATION = {
  Head: "head",
  "Center Torso": "centerTorso",
  "Right Torso": "rightTorso",
  "Left Torso": "leftTorso",
  "Right Arm": "rightArm",
  "Left Arm": "leftArm",
  "Right Leg": "rightLeg",
  "Left Leg": "leftLeg",
  CT: "centerTorso",
  RT: "rightTorso",
  LT: "leftTorso",
  RA: "rightArm",
  LA: "leftArm",
  HD: "head",
  LL: "rightLeg",
  RL: "leftLeg",
};

// MTF weapon codes -> catalog weapon names. Covers the shipped MTFs plus common
// full-intro codes. Plain catalog names route through the same table (identity).
const CODE = {
  "Small Laser": "Small Laser",
  "Medium Laser": "Medium Laser",
  "Large Laser": "Large Laser",
  PPC: "PPC",
  "Snub-Nose PPC": "Snub-Nose PPC",
  Flamer: "Flamer",
  "Machine Gun": "Machine Gun",
  "Autocannon/2": "Autocannon/2",
  "Autocannon/5": "Autocannon/5",
  "Autocannon/10": "Autocannon/10",
  "Autocannon/20": "Autocannon/20",
  "Ultra AC/5": "Ultra AC/5",
  "Large Pulse Laser": "Large Pulse Laser",
  "Small Pulse Laser": "Small Pulse Laser",
  "LRM 5": "LRM 5",
  "LRM 10": "LRM 10",
  "LRM 15": "LRM 15",
  "LRM 20": "LRM 20",
  "SRM 2": "SRM 2",
  "SRM 4": "SRM 4",
  "SRM 6": "SRM 6",
  // IS compact codes.
  ISMediumLaser: "Medium Laser",
  ISLargeLaser: "Large Laser",
  ISSmallLaser: "Small Laser",
  ISPPC: "PPC",
  ISSNPPC: "Snub-Nose PPC",
  ISFlamer: "Flamer",
  ISMachineGun: "Machine Gun",
  ISAC2: "Autocannon/2",
  ISAC5: "Autocannon/5",
  ISAC10: "Autocannon/10",
  ISAC20: "Autocannon/20",
  ISUltraAC5: "Ultra AC/5",
  ISLargePulseLaser: "Large Pulse Laser",
  ISSmallPulseLaser: "Small Pulse Laser",
  ISLRM5: "LRM 5",
  ISLRM10: "LRM 10",
  ISLRM15: "LRM 15",
  ISLRM20: "LRM 20",
  ISSRM2: "SRM 2",
  ISSRM4: "SRM 4",
  ISSRM6: "SRM 6",
  // Clan compact codes.
  CLERMediumLaser: "CL ER Medium Laser",
  CLERLargeLaser: "CL ER Large Laser",
  CLERPPC: "CL ER PPC",
  CLStreakSRM2: "CL Streak SRM 2",
  CLStreakSRM4: "CL Streak SRM 4",
  CLStreakSRM6: "CL Streak SRM 6",
  CLGaussRifle: "CL Gauss Rifle",
  CLLBXAC10: "CL LB 10-X AC",
  CLLBXAC20: "CL LB 20-X AC",
};

// Shots per ton of ammunition, keyed by catalog weapon name. Used only when an
// MTF weapon line has no explicit `, Ammo:N` and ammo must come from the
// crit-slot ammo bins (counted in the crit sections).
const SHOTS_PER_TON = {
  "Autocannon/2": 45,
  "Autocannon/5": 20,
  "Autocannon/10": 10,
  "Autocannon/20": 5,
  "Ultra AC/5": 20,
  "LRM 5": 24,
  "LRM 10": 12,
  "LRM 15": 8,
  "LRM 20": 6,
  "SRM 2": 50,
  "SRM 4": 25,
  "SRM 6": 15,
  "CL Streak SRM 2": 50,
  "CL Streak SRM 4": 25,
  "CL Streak SRM 6": 15,
  "Gauss Rifle": 8,
  "CL Gauss Rifle": 16,
  "LB 10-X AC": 10,
  "LB 20-X AC": 5,
  "CL LB 10-X AC": 10,
  "CL LB 20-X AC": 5,
};

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

/** Crit-slot ammo tokens (MTF "IS Ammo <token>") -> catalog weapon name. */
const AMMO_TOKEN = {
  "AC/2": "Autocannon/2",
  "AC/5": "Autocannon/5",
  "AC/10": "Autocannon/10",
  "AC/20": "Autocannon/20",
  "LRM-5": "LRM 5",
  "LRM-10": "LRM 10",
  "LRM-15": "LRM 15",
  "LRM-20": "LRM 20",
  "SRM-2": "SRM 2",
  "SRM-4": "SRM 4",
  "SRM-6": "SRM 6",
};

/** Count ammo crit-bins per catalog weapon name from the crit sections. */
function ammoBinsFromCrits(lines) {
  const bins = new Map();
  for (const line of lines) {
    const t = line.trim();
    let name = null;
    // Format 1: "<code> Ammo" (Clan/compact), e.g. "CLStreakSRM4 Ammo".
    let m = /^(.+?)\s+Ammo\s*$/.exec(t);
    if (m) {
      const stem = m[1]
        .replace(/^IS |^CL /, "")
        .replace(/\s+CL$/, "")
        .trim();
      name = CODE[stem] ?? null;
    } else {
      // Format 2: "IS Ammo <token>", e.g. "IS Ammo AC/20".
      m = /^IS Ammo\s+(.+?)\s*$/.exec(t);
      if (m) name = AMMO_TOKEN[m[1].trim()] ?? null;
    }
    if (name) bins.set(name, (bins.get(name) ?? 0) + 1);
  }
  return bins;
}

function parseMtf(text, file) {
  const errors = [];
  const lines = text.split(/\r?\n/);
  const name = lines[1]?.trim() ?? "";
  const model = lines[2]?.trim() ?? "";
  if (!name) errors.push(`missing name in ${file}`);
  if (!model) errors.push(`missing model in ${file}`);
  // A bare numeric/non-alpha variant line (e.g. Mad Cat Mk II "2") is not a
  // usable model code; such 'Mechs are handled manually and skipped here.
  if (model && !/[A-Za-z]/.test(model)) {
    return {
      def: null,
      errors: [`variant ${JSON.stringify(model)} is not a model code; import this one manually`],
    };
  }

  const fields = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }

  const tonnage = numberRegex(text, "Mass");
  const walking = numberRegex(text, "Walk MP");
  const jumping = numberRegex(text, "Jump MP") ?? 0;

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

  // Shared bins: keep one `ammoShots` per weapon (the explicit mount, else the
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
    ammo !== null ? { weapon, location, ammoShots: ammo } : { weapon, location },
  );

  const source = `docs/mtf/${file}${fields.Source ? ` (${fields.Source})` : ""}. Armor stores front values; rear torso armor kept as 'centerTorsoRear' etc.; shared ammo written on one mount.`;

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
