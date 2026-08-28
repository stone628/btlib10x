import type { MoveMode, TerrainType } from "../core/types.js";
import type { WeaponDef } from "../data/weapons.js";
import { attackerMovementModifier, targetMovementModifier } from "./movement.js";

export type RangeBracket = "short" | "medium" | "long";

export interface AttackModifiers {
  readonly gunnery: number;
  readonly attackerMovement: MoveMode;
  readonly targetHexesMoved: number;
  readonly targetJumped: boolean;
  readonly targetTerrain: TerrainType;
  /** Sum of woods points among intervening hexes (0 when none). */
  readonly interveningWoods: number;
  readonly distance: number;
  readonly weapon: WeaponDef;
}

export interface ToHitBreakdown {
  readonly gunnery: number;
  readonly attackerMod: number;
  readonly targetMod: number;
  readonly terrainMod: number;
  readonly rangeMod: number;
  /** Pulse weapons: -2. */
  readonly pulseMod: number;
  /** Closer-than-minimum-range penalty: (minRange - distance) + 1, else 0. */
  readonly minRangeMod: number;
  readonly total: number;
  readonly rangeBracket: RangeBracket;
  /** Modified TN <= 2 auto-hits; > 12 auto-misses (attack may be aborted). */
  readonly automatic: "hit" | "miss" | null;
  readonly outOfRange: boolean;
}

function rangeBracket(weapon: WeaponDef, distance: number): RangeBracket | null {
  if (distance <= weapon.short) return "short";
  if (distance <= weapon.medium) return "medium";
  if (distance <= weapon.long) return "long";
  return null;
}

const RANGE_MOD: Record<RangeBracket, number> = {
  short: 0,
  medium: 2,
  long: 4,
};

export function computeToHit(mods: AttackModifiers): ToHitBreakdown {
  const bracket = rangeBracket(mods.weapon, mods.distance);
  if (bracket === null) {
    return {
      gunnery: mods.gunnery,
      attackerMod: 0,
      targetMod: 0,
      terrainMod: 0,
      rangeMod: 0,
      pulseMod: 0,
      minRangeMod: 0,
      total: Number.POSITIVE_INFINITY,
      rangeBracket: "long",
      automatic: "miss",
      outOfRange: true,
    };
  }

  const attackerMod = attackerMovementModifier(mods.attackerMovement);
  const targetMod = targetMovementModifier(mods.targetHexesMoved, mods.targetJumped);

  let terrainMod = mods.interveningWoods;
  terrainMod +=
    mods.targetTerrain === "lightWoods" ? 1 : mods.targetTerrain === "heavyWoods" ? 2 : 0;

  const rangeMod = RANGE_MOD[bracket];
  const pulseMod = mods.weapon.pulse === true ? -2 : 0;
  const min =
    mods.weapon.minRange !== undefined && mods.distance <= mods.weapon.minRange
      ? mods.weapon.minRange - mods.distance + 1
      : 0;

  const total = mods.gunnery + attackerMod + targetMod + terrainMod + rangeMod + pulseMod + min;

  return {
    gunnery: mods.gunnery,
    attackerMod,
    targetMod,
    terrainMod,
    rangeMod,
    pulseMod,
    minRangeMod: min,
    total,
    rangeBracket: bracket,
    automatic: total <= 2 ? "hit" : total > 12 ? "miss" : null,
    outOfRange: false,
  };
}

/** Damage for the bracket actually rolled (handles V-code variable damage). */
export function damageForBracket(weapon: WeaponDef, bracket: RangeBracket): number {
  if (weapon.variableDamage !== undefined) {
    return weapon.variableDamage[bracket === "short" ? 0 : bracket === "medium" ? 1 : 2]!;
  }
  return weapon.damage ?? 0;
}
