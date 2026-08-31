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
  CODE,
  CRIT_SLOT_COUNTS,
  ENGINE_CRIT_SLOTS,
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

function normalizeCritWeaponToken(t) {
  return t
    .replace(/\s*\((R|F)\)\s*$/i, "")
    .replace(/^(IS|CL)[\s_-]?/i, "")
    .replace(/\s+CL$/, "")
    .trim();
}

function classifyCritLine(raw, errors, fileLabel) {
  const t = raw.trim();
  if (t === "" || t === "-Empty-") return { ok: true, slot: { kind: "empty" } };
  // "IS Ammo <token>" / "CL Ammo <token>" (e.g. "IS Ammo AC/20"). Some MTFs
  // also write "CLGauss Ammo" etc.; the trailing-token lookup below covers
  // both shapes after the IS/CL prefix is normalized off. Trailing
  // parenthesized text (e.g. "(200)" denoting the bin's shot count) is
  // informational and dropped before lookup.
  let m = /^(?:IS|CL)\s+Ammo\s+(.+?)(?:\s*\(.+?\))?\s*$/.exec(t);
  if (m) {
    const tok = m[1].trim();
    const stripped = normalizeCritWeaponToken(tok);
    const name = CODE[tok] ?? CODE[stripped] ?? null;
    if (name) return { ok: true, slot: { kind: "ammo", weapon: name } };
    errors.push(`Unmapped ammo crit-slot token ${JSON.stringify(t)} in ${fileLabel}`);
    return { ok: false };
  }
  // "<code> Ammo" (compact codes). Same trailing-parenthesized tolerance as
  // above (e.g. "CLMG Ammo (200)").
  m = /^(.+?)\s+Ammo(?:\s*\(.+?\))?\s*$/.exec(t);
  if (m) {
    const stem = m[1];
    const stripped = normalizeCritWeaponToken(stem);
    const name = CODE[stem] ?? CODE[stripped] ?? null;
    if (name) return { ok: true, slot: { kind: "ammo", weapon: name } };
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
  const name = CODE[t] ?? CODE[stripped] ?? null;
  if (name) return { ok: true, slot: { kind: "weapon", weapon: name } };
  errors.push(`Unmapped crit-slot token ${JSON.stringify(t)} in ${fileLabel}`);
  return { ok: false };
}

export function parseCritSlots(lines, errors, fileLabel) {
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
      const res = classifyCritLine(t, errors, fileLabel);
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
 */
export function validateCritConstruction(slots, meta, errors) {
  const techBase = meta?.techBase ?? "";
  const structureField = meta?.structureField ?? "";
  const armorField = meta?.armorField ?? "";

  // Count engine structure slots per engine location (and total).
  const engine = {
    centerTorso: 0,
    leftTorso: 0,
    rightTorso: 0,
  };
  let engineTotal = 0;
  // Soak totals across all locations.
  const soak = { endoSteel: 0, ferroFibrous: 0 };

  for (const loc of LOCATIONS) {
    for (const slot of slots[loc] ?? []) {
      if (slot.kind === "structure" && slot.name === "engine" && loc in engine) {
        engine[loc] += 1;
        engineTotal += 1;
      } else if (slot.kind === "soak") {
        if (slot.name === "endoSteel") soak.endoSteel += 1;
        else if (slot.name === "ferroFibrous") soak.ferroFibrous += 1;
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
}
