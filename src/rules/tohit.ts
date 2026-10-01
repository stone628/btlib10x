import { D2D6_MAX, D2D6_MIN } from "../core/dice";
import { terrainTargetMod } from "../core/terrain";
import type { MoveMode, TerrainType } from "../core/types";
import type { WeaponDef } from "../data/weapon.schema";
import type { UnitSkillRange } from "./game";
import { attackerMovementModifier, TARGET_IMMOBILE_MOD, targetMovementModifier } from "./movement";

export type RangeBracket = "short" | "medium" | "long";

export interface AttackModifiers {
  readonly gunnery: number;
  readonly attackerMovement: MoveMode;
  readonly targetHexesMoved: number;
  readonly targetJumped: boolean;
  readonly targetTerrain: TerrainType;
  /** True when the target cannot move (shut down or both legs destroyed):
   *  grants a flat −4 target modifier instead of the hex-based band. */
  readonly targetImmobile?: boolean;
  /** True when the target is prone (but not immobile): −2 from an adjacent
   *  hex, +1 from every other hex (TW p.113). */
  readonly targetProne?: boolean;
  /** True when the attacker is prone: +2 attacker modifier (TW p.113). */
  readonly attackerProne?: boolean;
  /** Destroyed-sensor to-hit modifier on the attacker: 0 intact, +2 on the
   *  first hit; a second hit blinds the 'Mech (no weapon attacks, TW p.123).
   *  Callers map the destroyed-slot count via `sensorAttackModifier`. */
  readonly sensorMod?: number;
  /** Partial-cover to-hit modifier: 1 for partial-cover terrain (water1 /
   *  building), 2 for a target adjacent to a level-2 wreck; both only when
   *  the attacker is not higher than the cover. Leg hit-location rolls
   *  strike the cover instead of the target. */
  readonly partialCoverMod?: number;
  /** Sum of woods points among intervening hexes (0 when none). */
  readonly interveningWoods: number;
  readonly distance: number;
  readonly weapon: WeaponDef;
  /** Heat Scale to-hit modifier (+1..+4); caller computes from the heat value. */
  readonly heatMod?: number;
  /** Arm-actuator to-hit modifier for the firing arm: +4 on a destroyed
   *  shoulder (suppressing upper/lower), else +1 per destroyed upper/lower
   *  actuator in that arm (TW p.125). Caller computes per weapon mount via
   *  `armWeaponToHitModifier`. */
  readonly actuatorMod?: number;
}

export interface ToHitBreakdown {
  readonly gunnery: number;
  readonly attackerMod: number;
  readonly targetMod: number;
  readonly terrainMod: number;
  readonly rangeMod: number;
  /** Weapon To-Hit Mod column (TW p.303-304): -2 pulse, +1 MRM / Clan heavy lasers. */
  readonly weaponMod: number;
  /** Closer-than-minimum-range penalty: (minRange - distance) + 1, else 0. */
  readonly minRangeMod: number;
  /** Heat Scale modifier from the attacker's current heat (+1..+4), else 0. */
  readonly heatMod: number;
  /** Destroyed-sensor modifier from the attacker (0 intact, +2 on first hit). */
  readonly sensorMod: number;
  /** Arm-actuator modifier for the firing arm (0 when intact / non-arm). */
  readonly actuatorMod: number;
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

/** Default gunnery skill for `UnitInit`s that omit it (TW regular pilot). */
export const DEFAULT_GUNNERY: UnitSkillRange = 4;
/** Attacker modifier while prone (TW p.113). */
const PRONE_ATTACKER_MOD = 2;
/** Target modifier while prone and adjacent (TW p.113). */
const PRONE_TARGET_ADJACENT_MOD = -2;
/** Target modifier while prone and non-adjacent (TW p.113). */
const PRONE_TARGET_DISTANT_MOD = 1;
/** Max distance counting as adjacent for the prone-target modifier. */
const PRONE_ADJACENT_MAX_DISTANCE = 1;
/** To-hit bonus for pulse weapons without an explicit `toHitMod` (TW p.303). */
const PULSE_MOD = -2;

/** Weapon modifier: explicit `toHitMod`, falling back to -2 for legacy
 *  pulse-only defs that predate the generic column. */
export function weaponToHitModifier(weapon: WeaponDef): number {
  if (weapon.toHitMod !== undefined) return weapon.toHitMod;
  return weapon.pulse === true ? PULSE_MOD : 0;
}

/** Prone-target modifier by range (TW p.113): −2 adjacent, +1 otherwise. */
export function proneTargetModifier(distance: number): number {
  return distance <= PRONE_ADJACENT_MAX_DISTANCE
    ? PRONE_TARGET_ADJACENT_MOD
    : PRONE_TARGET_DISTANT_MOD;
}

export function computeToHit(mods: AttackModifiers): ToHitBreakdown {
  const bracket = rangeBracket(mods.weapon, mods.distance);
  if (bracket === null) {
    return {
      gunnery: mods.gunnery,
      attackerMod: 0,
      targetMod: 0,
      terrainMod: 0,
      rangeMod: 0,
      weaponMod: 0,
      minRangeMod: 0,
      heatMod: 0,
      sensorMod: 0,
      actuatorMod: 0,
      total: Number.POSITIVE_INFINITY,
      rangeBracket: "long",
      automatic: "miss",
      outOfRange: true,
    };
  }

  const attackerMod =
    attackerMovementModifier(mods.attackerMovement) +
    (mods.attackerProne === true ? PRONE_ATTACKER_MOD : 0);
  const targetMod =
    targetMovementModifier(mods.targetHexesMoved, mods.targetJumped, undefined) +
    (mods.targetProne === true ? proneTargetModifier(mods.distance) : 0) +
    (mods.targetImmobile === true ? TARGET_IMMOBILE_MOD : 0);

  const terrainMod =
    mods.interveningWoods + terrainTargetMod(mods.targetTerrain) + (mods.partialCoverMod ?? 0);

  const rangeMod = RANGE_MOD[bracket];
  const weaponMod = weaponToHitModifier(mods.weapon);
  const min =
    mods.weapon.minRange !== undefined && mods.distance <= mods.weapon.minRange
      ? mods.weapon.minRange - mods.distance + 1
      : 0;
  const heatMod = mods.heatMod ?? 0;
  const sensorMod = mods.sensorMod ?? 0;
  const actuatorMod = mods.actuatorMod ?? 0;

  const total =
    mods.gunnery +
    attackerMod +
    targetMod +
    terrainMod +
    rangeMod +
    weaponMod +
    min +
    heatMod +
    sensorMod +
    actuatorMod;

  return {
    gunnery: mods.gunnery,
    attackerMod,
    targetMod,
    terrainMod,
    rangeMod,
    weaponMod,
    minRangeMod: min,
    heatMod,
    sensorMod,
    actuatorMod,
    total,
    rangeBracket: bracket,
    automatic: total <= D2D6_MIN ? "hit" : total > D2D6_MAX ? "miss" : null,
    outOfRange: false,
  };
}

const RANGE_VAR_DAMAGE_INDEX: Record<RangeBracket, number> = { short: 0, medium: 1, long: 2 };

/** Damage for the bracket actually rolled (handles V-code variable damage). */
export function damageForBracket(weapon: WeaponDef, bracket: RangeBracket): number {
  if (weapon.variableDamage !== undefined) {
    return weapon.variableDamage[RANGE_VAR_DAMAGE_INDEX[bracket]]!;
  }
  return weapon.damage ?? 0;
}
