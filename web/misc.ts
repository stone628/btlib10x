import type {
  Facing,
  HexCoord,
  Location,
  ResolvedMechDef,
  TerrainType,
  WeaponCategory,
} from "btlib10x";
import { i18n, type MessageKey } from "./i18n";
import { lookupMech } from "./lookup";

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
  const def = lookupMech(model);
  if (def === undefined) throw new Error(i18n("err.unknownModel", { model }));
  return def;
}

/** Display coordinates are 1-based (the internal value itself). */
export function hexCoordStr(hex: HexCoord): string {
  return `${hex.col},${hex.row}`;
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
