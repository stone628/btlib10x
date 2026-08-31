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

import { CODE, CRIT_SLOT_COUNTS, LOCATIONS, SOAK_TOKEN, STRUCTURE_TOKEN } from "./mtf-tables.mjs";

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
  // both shapes after the IS/CL prefix is normalized off.
  let m = /^(?:IS|CL)\s+Ammo\s+(.+?)\s*$/.exec(t);
  if (m) {
    const tok = m[1].trim();
    const stripped = normalizeCritWeaponToken(tok);
    const name = CODE[tok] ?? CODE[stripped] ?? null;
    if (name) return { ok: true, slot: { kind: "ammo", weapon: name } };
    errors.push(`Unmapped ammo crit-slot token ${JSON.stringify(t)} in ${fileLabel}`);
    return { ok: false };
  }
  // "<code> Ammo" (compact codes).
  m = /^(.+?)\s+Ammo\s*$/.exec(t);
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
    return { ok: true, slot: { kind: "soak" } };
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
