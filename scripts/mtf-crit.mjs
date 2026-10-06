/**
 * Shared MTF crit-slot parser. Both `scripts/mtf.mjs` (full conversion) and
 * `scripts/backfill-crits.mjs` (merge critSlots into the existing 8 hand-
 * transcribed mech JSONs) call into here so the layout, token mapping, and
 * truncation rules stay identical.
 *
 * Exported:
 *   - `parseCritSlots(lines, errors, fileLabel) -> Record<Location, CritSlot[]>`
 *   - `LOCATIONS` — re-exported from ./mtf-tables.mjs
 *   - `CRIT_SLOT_COUNTS` — re-exported from ./mtf-tables.mjs
 */

import {
  AMMO_TOKEN,
  CODE,
  CRIT_SLOT_COUNTS,
  catalogWeapon,
  DHS_CRIT_SLOTS,
  ENGINE_CRIT_SLOTS,
  INERT_EQUIPMENT,
  LOCATIONS,
  SOAK_CRIT_TOTALS,
  SOAK_TOKEN,
  STRUCTURE_TOKEN,
} from "./mtf-tables.mjs";

export { CRIT_SLOT_COUNTS, LOCATIONS };

// Longer phrases first so "Right Arm" matches before "Right Torso" etc.
const BODY_PART_HEADERS = [
  ["Center Torso", "centerTorso"],
  ["Left Torso", "leftTorso"],
  ["Right Torso", "rightTorso"],
  ["Left Arm", "leftArm"],
  ["Right Arm", "rightArm"],
  ["Left Leg", "leftLeg"],
  ["Right Leg", "rightLeg"],
  ["Head", "head"],
];

/** Token with trailing facing / variant parentheticals removed ("(R)", "(Split)"). */
function baseToken(t) {
  let out = t.trim();
  for (;;) {
    const next = out.replace(/\s*\([^()]*\)\s*$/, "");
    if (next === out) return out;
    out = next;
  }
}

function normalizeCritWeaponToken(t) {
  const facingMatch = t.match(/\((R|F)\)\s*$/i);
  const rearFacing = facingMatch ? facingMatch[1].toUpperCase() === "R" : false;
  return {
    name: baseToken(t)
      .replace(/^(IS|CL)[\s_-]?/i, "")
      .replace(/\s+CL$/, "")
      .trim(),
    rearFacing,
  };
}

/** Tally ammo tons per catalog weapon from the MTF crit-slot lines.
 * Full-ton crits (e.g. "IS Ammo AC/10", "CLMG Ammo", "IS Machine Gun Ammo")
 * add 1 ton; "- Half" suffixed crits (e.g. "IS Machine Gun Ammo - Half") add
 * 0.5 tons. The caller multiplies by `SHOTS_PER_TON[weapon]` to get shot count
 * for the weapons-block `shots` field. Unmapped ammo-shaped lines are skipped
 * silently — `parseCritSlots` is the strict gate for unknown crit tokens. */
/**
 * Resolve an ammo crit line. Returns null when the line is not ammo-shaped,
 * else `{ weapon, half }` where `weapon` is the catalog name or null when the
 * ammo is unmapped. Handles "<code> Ammo", "IS Ammo <token>", "- Half" /
 * "- Full" suffixes, "(200)" shot-count notes and "Artemis-/Narc-capable"
 * variants (the munition type does not change the catalog ammo).
 */
function resolveAmmoLine(raw, clan = false) {
  const t = raw.trim();
  const half = /-\s*Half\b/i.test(t);
  // Peel trailing decorations (omnipod / variant parentheticals, "- Half",
  // "- Full", "Artemis-/Narc-capable") until the line is stable.
  let s = t;
  for (;;) {
    const next = s
      .replace(/\s*\([^()]*\)\s*$/, "")
      .replace(/\s*-\s*(?:Half|Full)\s*$/i, "")
      .replace(/\s+(?:Artemis|Narc)-capable\s*$/i, "")
      .replace(/\s+(?:HE|ER)$/, "")
      .trim();
    if (next === s) break;
    s = next;
  }
  let tok = null;
  let m = /^(?:IS|CL|Clan)\s+Ammo\s+(.+)$/.exec(s);
  if (m) tok = m[1].trim();
  else {
    m = /^(.+?)\s+Ammo$/.exec(s);
    if (m) tok = m[1].trim();
    else {
      // Compact "<IS|CL><stem>Ammo" form ("ISPlasmaRifleAmmo").
      m = /^((?:IS|CL)[A-Za-z0-9]+?)Ammo$/.exec(s);
      if (m) tok = m[1];
    }
  }
  if (tok === null) return null;
  // "Clan Ammo X" / "Clan X Ammo" name the tech base explicitly.
  const explicitClan = /^(?:CL|Clan)\b/i.test(s) ? true : /^IS\b/i.test(s) ? false : clan;
  const stripped = normalizeCritWeaponToken(tok).name;
  // Exact token first so Clan compact codes ("CLMG") win over the bare IS
  // stem ("MG") left after prefix stripping. On Clan sheets the catalog
  // lookup runs first so unprefixed names resolve to the Clan weapon.
  const legacy = () =>
    AMMO_TOKEN[tok] ?? CODE[tok] ?? AMMO_TOKEN[stripped] ?? CODE[stripped] ?? null;
  const fromCatalog = () => catalogWeapon(tok, explicitClan);
  const weapon = explicitClan ? (fromCatalog() ?? legacy()) : (legacy() ?? fromCatalog());
  return { weapon, half };
}

export function ammoBinsFromCrits(lines, techBase) {
  const bins = new Map();
  for (const line of lines) {
    const res = resolveAmmoLine(line, techBase === "Clan");
    if (res?.weapon) bins.set(res.weapon, (bins.get(res.weapon) ?? 0) + (res.half ? 0.5 : 1));
  }
  return bins;
}

function classifyCritLine(raw, errors, fileLabel, clan) {
  const t = raw.trim();
  if (t === "" || t === "-Empty-") return { ok: true, slot: { kind: "empty" } };
  // Physical-weapon equipment (Hatchet, TW p.146) links to a Hatchet weapon
  // mount like any other weapon (precedent: HCT-5S). The importer synthesizes
  // the mount from crits when the weapons block omits it (e.g. CN9-YLW2).
  if (t === "Hatchet") return { ok: true, slot: { kind: "weapon", weapon: "Hatchet" } };
  const ammo = resolveAmmoLine(t, clan);
  if (ammo !== null) {
    if (ammo.weapon) return { ok: true, slot: { kind: "ammo", weapon: ammo.weapon } };
    errors.push(`Unmapped ammo crit-slot token ${JSON.stringify(t)} in ${fileLabel}`);
    return { ok: false };
  }
  if (STRUCTURE_TOKEN[t]) {
    return { ok: true, slot: { kind: "structure", name: STRUCTURE_TOKEN[t] } };
  }
  if (SOAK_TOKEN[t]) {
    return { ok: true, slot: { kind: "soak", name: SOAK_TOKEN[t] } };
  }
  const stripped = normalizeCritWeaponToken(t);
  const base = baseToken(t);
  if (INERT_EQUIPMENT.has(t) || INERT_EQUIPMENT.has(base)) {
    return { ok: true, slot: { kind: "soak", name: "equipment" } };
  }
  if (STRUCTURE_TOKEN[base]) {
    return { ok: true, slot: { kind: "structure", name: STRUCTURE_TOKEN[base] } };
  }
  const legacy = CODE[t] ?? CODE[base] ?? CODE[stripped.name] ?? null;
  const name = clan
    ? (catalogWeapon(base, true) ?? legacy)
    : (legacy ?? catalogWeapon(base, false));
  if (name)
    return {
      ok: true,
      slot: { kind: "weapon", weapon: name, ...(stripped.rearFacing && { rearFacing: true }) },
    };
  errors.push(`Unmapped crit-slot token ${JSON.stringify(t)} in ${fileLabel}`);
  return { ok: false };
}

export function parseCritSlots(lines, errors, fileLabel, techBase) {
  const clan = techBase === "Clan";
  const out = {};
  for (const [, loc] of BODY_PART_HEADERS) out[loc] = [];

  const isHeaderLine = (t) => BODY_PART_HEADERS.some(([prefix]) => t === `${prefix}:`);

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]?.trim() ?? "";
    let matched = null;
    for (const [prefix, loc] of BODY_PART_HEADERS) {
      if (header === `${prefix}:`) {
        matched = loc;
        break;
      }
    }
    if (!matched) continue;
    const slots = out[matched];
    const max = CRIT_SLOT_COUNTS[matched];
    let warned = false;
    for (let j = i + 1; j < lines.length; j++) {
      const t = (lines[j] ?? "").trim();
      if (t === "") {
        i = j;
        break;
      }
      if (isHeaderLine(t)) {
        i = j - 1;
        break;
      }
      const isEmpty = t === "-Empty-";
      if (slots.length >= max) {
        if (!isEmpty && !warned) {
          errors.push(`${matched}: more than ${max} non-empty crit-slot lines; truncating`);
          warned = true;
        }
        continue;
      }
      if (isEmpty) {
        slots.push({ kind: "empty" });
        continue;
      }
      const res = classifyCritLine(t, errors, fileLabel, clan);
      if (res.ok) slots.push(res.slot);
    }
  }

  // Pad to official length with empty slots.
  for (const [, loc] of BODY_PART_HEADERS) {
    while (out[loc].length < CRIT_SLOT_COUNTS[loc]) out[loc].push({ kind: "empty" });
    if (out[loc].length > CRIT_SLOT_COUNTS[loc]) out[loc].length = CRIT_SLOT_COUNTS[loc];
  }
  return out;
}

/**
 * Map an MTF `Engine:` header to a row of `ENGINE_CRIT_SLOTS`.
 * Compact/XXL engines are not yet supported; they return `null` and push a
 * deferral error so the 'Mech is surfaced rather than misvalidated.
 */
function engineRowFromField(engineField, techBase, errors) {
  const e = (engineField ?? "").toLowerCase();
  if (e === "") return ENGINE_CRIT_SLOTS.standard;
  if (e.includes("compact")) {
    errors.push("compact engines are not yet supported by construction validation");
    return null;
  }
  if (e.includes("xxl")) {
    errors.push("XXL engines are not yet supported by construction validation");
    return null;
  }
  if (e.includes("xl")) {
    return techBase === "Clan" ? ENGINE_CRIT_SLOTS.clanXL : ENGINE_CRIT_SLOTS.isXL;
  }
  if (e.includes("light")) return ENGINE_CRIT_SLOTS.isLight;
  return ENGINE_CRIT_SLOTS.standard;
}

/**
 * Validate the crit-slot construction constraints for a parsed layout:
 * per-location + total engine crit-slot counts (from the `Engine:` header and
 * tech base) and the Endo Steel / Ferro-Fibrous soak totals (from the
 * `Structure:` / `Armor:` headers and tech base). Violations are pushed as
 * hard errors into `errors`, matching the fatal-error convention of
 * `parseCritSlots`.
 *
 * `meta`:
 *   - techBase       — "Inner Sphere" | "Clan" (from `TechBase:`)
 *   - engineField    — raw `Engine:` line, e.g. "360 XL Fusion Engine"
 *   - structureField — raw `Structure:` line, e.g. "Endo Steel" | "Standard"
 *   - armorField     — raw `Armor:` line, e.g. "Ferro-Fibrous" | "Standard"
 *   - myomer         — resolved myomer, "Standard" | "Triple Strength Myomer"
 */
export function validateCritConstruction(slots, meta, errors) {
  const techBase = meta?.techBase ?? "";
  const structureField = meta?.structureField ?? "";
  const armorField = meta?.armorField ?? "";
  const myomer = meta?.myomer ?? "Standard";

  // Count engine structure slots per engine location (and total).
  const engine = {
    centerTorso: 0,
    leftTorso: 0,
    rightTorso: 0,
  };
  let engineTotal = 0;
  // Soak totals across all locations.
  const soak = { endoSteel: 0, ferroFibrous: 0, tsm: 0 };

  for (const loc of LOCATIONS) {
    for (const slot of slots[loc] ?? []) {
      if (slot.kind === "structure" && slot.name === "engine" && loc in engine) {
        engine[loc] += 1;
        engineTotal += 1;
      } else if (slot.kind === "soak") {
        if (slot.name === "endoSteel") soak.endoSteel += 1;
        else if (slot.name === "ferroFibrous") soak.ferroFibrous += 1;
        else if (slot.name === "tsm") soak.tsm += 1;
      }
    }
  }

  // Engine distribution (per location) against the header-declared type.
  const row = engineRowFromField(meta?.engineField, techBase, errors);
  if (row) {
    if (engineTotal !== row.total) {
      errors.push(`engine crit slots: ${engineTotal} counted, ${row.total} expected`);
    }
    for (const [loc, expected] of [
      ["centerTorso", row.ct],
      ["leftTorso", row.lt],
      ["rightTorso", row.rt],
    ]) {
      if (engine[loc] !== expected) {
        errors.push(`engine crit slots in ${loc}: ${engine[loc]} counted, ${expected} expected`);
      }
    }
  }

  // Endo Steel: expected only when the Structure: header declares it, and in
  // the tech-base-determined total when it does.
  if (structureField !== "") {
    const endoExpected = /endo/i.test(structureField) ? SOAK_CRIT_TOTALS.endoSteel[techBase] : 0;
    if (soak.endoSteel !== endoExpected) {
      errors.push(
        `Endo Steel crit slots: ${soak.endoSteel} counted, ${
          endoExpected === undefined ? 0 : endoExpected
        } expected`,
      );
    }
  }

  // Ferro-Fibrous: expected only when the Armor: header declares it.
  if (armorField !== "") {
    const ferroExpected = /ferro/i.test(armorField) ? SOAK_CRIT_TOTALS.ferroFibrous[techBase] : 0;
    if (soak.ferroFibrous !== ferroExpected) {
      errors.push(
        `Ferro-Fibrous crit slots: ${soak.ferroFibrous} counted, ${
          ferroExpected === undefined ? 0 : ferroExpected
        } expected`,
      );
    }
  }

  // Triple-Strength Myomer (TW p.143): occupies 6 crit slots when the Myomer:
  // header declares it, none otherwise.
  {
    const tsmExpected = myomer === "Triple Strength Myomer" ? 6 : 0;
    if (soak.tsm !== tsmExpected) {
      errors.push(
        `Triple Strength Myomer crit slots: ${soak.tsm} counted, ${tsmExpected} expected`,
      );
    }
  }
}

/**
 * Validate the `Heat Sinks:N Type` header against the crit-slot table, using
 * the construction rules for engine-mounted sinks: an engine mounts
 * `floor(walking * tonnage / 25)` sinks internally at no crit cost; every
 * remaining sink up to the header total occupies crit slots. Single sinks
 * take one slot each; double sinks take runs of `DHS_CRIT_SLOTS[techBase]`
 * slots per device. Violations are pushed as hard errors.
 *
 * `meta` extends `validateCritConstruction`'s meta with:
 *   - walking        — `Walk MP` (for the engine-rating sink capacity)
 *   - tonnage        — `Mass`
 *   - heatsink       — `{ type, count }` parsed from the `Heat Sinks:` header
 */
export function validateHeatSinks(slots, meta, errors) {
  const techBase = meta?.techBase ?? "";
  const hs = meta?.heatsink;
  if (!hs || typeof hs.count !== "number" || (hs.type !== "single" && hs.type !== "double")) {
    errors.push("Heat Sinks header missing or malformed (expected 'N Single' or 'N Double')");
    return;
  }
  const { type, count } = hs;
  if (count < 10) {
    errors.push(`Heat Sinks:${count} below minimum of 10`);
    return;
  }
  const width = DHS_CRIT_SLOTS[techBase] ?? 3;
  let external = 0;
  let mixed = false;
  for (const loc of LOCATIONS) {
    let run = 0;
    for (const slot of slots[loc] ?? []) {
      if (slot.kind === "structure" && slot.name === "doubleHeatSink") {
        run += 1;
        if (type === "single") mixed = true;
        continue;
      }
      if (run > 0 && run % width !== 0) {
        errors.push(`${loc}: double heat sink run length ${run} not divisible by ${width}`);
      }
      external += Math.floor(run / width);
      run = 0;
      if (slot.kind === "structure" && slot.name === "heatSink") {
        external += 1;
        if (type === "double") mixed = true;
      }
    }
    if (run > 0 && run % width !== 0) {
      errors.push(`${loc}: double heat sink run length ${run} not divisible by ${width}`);
    }
    external += Math.floor(run / width);
  }
  if (mixed) {
    errors.push("Heat Sinks: heatSink and doubleHeatSink crit slots cannot be mixed");
    return;
  }
  const internal = Math.floor(((meta?.walking ?? 0) * (meta?.tonnage ?? 0)) / 25);
  const expectedExternal = Math.max(0, count - internal);
  if (external !== expectedExternal) {
    errors.push(
      `Heat Sinks:${count} needs ${expectedExternal} external sink(s) (engine holds ${internal}); crit slots hold ${external}`,
    );
  }
}
