import type { Facing, Location, ResolvedMechDef, TerrainType, WeaponCategory } from "btlib10x";
import {
  componentHitStatus,
  ensureMechRegistered,
  GYRO_DESTROYED_HITS,
  mechDefFor,
  type UnitState,
} from "btlib10x";
import { i18n, type MessageKey } from "./i18n";
import { lookupMech } from "./lookup";
import { unknownModelError } from "./query";

const CATEGORY_LABEL: Readonly<Record<WeaponCategory, MessageKey>> = {
  MISSILE: "info.weaponCategoryMissile",
  BALLISTIC: "info.weaponCategoryBallistic",
  ENERGY: "info.weaponCategoryEnergy",
  EQUIPMENT: "info.weaponCategoryEquipment",
};

export function weaponCategory(category: WeaponCategory): string {
  return i18n(CATEGORY_LABEL[category]);
}

/**
 * Pilot rating for gunnery 0..7, rendered as `{name}({gunnery})` using the
 * standard experience bands: 0-1 elite, 2-3 veteran, 4-5 regular, 6-7 green.
 */
export function gunneryLabel(gunnery: number): string {
  const band =
    gunnery <= 1
      ? "skill.elite"
      : gunnery <= 3
        ? "skill.veteran"
        : gunnery <= 5
          ? "skill.regular"
          : "skill.green";
  return `${i18n(band)}(${gunnery})`;
}

export function requireMechDef(model: string): ResolvedMechDef {
  const def = lookupMech(model) ?? ensureMechRegistered(model);
  if (def === undefined) throw unknownModelError(model);
  return def;
}

export const F = (f: Facing): string => i18n(`sheet.facing.${f}` as MessageKey);

export const PRN = (prone: boolean): string =>
  i18n(prone ? "sheet.postureProne" : "sheet.postureStand");

export const TRN = (terrain: TerrainType): string => i18n(`terrain.${terrain}` as MessageKey);

export const SHORT_LOC: Readonly<Record<Location, string>> = {
  head: "HD",
  centerTorso: "CT",
  rightTorso: "RT",
  leftTorso: "LT",
  rightArm: "RA",
  leftArm: "LA",
  rightLeg: "RL",
  leftLeg: "LL",
};

export function signedMod(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

/** Plain decimal integer (`-3`, `+2`, `7`); rejects `0x2`, `1e0`, `2.0`, ``. Null when invalid. */
export function strictInt(raw: string): number | null {
  return /^[+-]?\d+$/.test(raw) ? Number(raw) : null;
}

/** Player-typed spelling of an engine move mode (`standStill` -> `standstill`). */
export function modeWord(mode: string): string {
  return mode === "standStill" ? "standstill" : mode;
}

/** TW p.125 Gyro: a destroyed gyro means the 'Mech can never stand again. */
export function isGyroDestroyed(unit: UnitState): boolean {
  return (
    componentHitStatus(mechDefFor(unit), unit.damage, unit.critSlotsDestroyed).gyro >=
    GYRO_DESTROYED_HITS
  );
}
