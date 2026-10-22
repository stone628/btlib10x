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
   *  grants a −4 target modifier, added to the hex-based band (which is 0
   *  for a unit that cannot have moved this turn). */
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
  /** Targeting-computer modifier (-1 for an eligible weapon, TW p.143); caller
   *  computes per weapon via `targetingComputerModifier`. */
  readonly tcMod?: number;
  /** Multiple-targets modifier (TW p.108): +1 for a secondary target in the
   *  attacker's forward arc, +2 for one in a side/rear arc; 0 for the primary
   *  target. Never cumulative across targets. Weapon attacks only. */
  readonly secondaryTargetMod?: number;
}

export interface ToHitBreakdown {
  readonly gunnery: number;
  readonly attackerMod: number;
  readonly targetMod: number;
  /** Woods only: target-hex woods + intervening woods points. */
  readonly terrainMod: number;
  /** Partial-cover modifier (TW p.102): +1 terrain/wreck cover, +2 L2 wreck.
   *  Kept separate from `terrainMod` so the GATOR line can print `cover +1`.
   *  Leg hit-location rolls strike the cover instead (see `hitLocationPlaced`
   *  in `src/rules/attack.ts`). */
  readonly coverMod: number;
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
  /** Targeting-computer modifier (0 or -1, TW p.143). */
  readonly tcMod: number;
  /** Secondary-target modifier (0 for the primary target, else +1/+2). */
  readonly secondaryTargetMod: number;
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
export const PRONE_ATTACKER_MOD = 2;
/** Target modifier while prone and adjacent (TW p.113). */
const PRONE_TARGET_ADJACENT_MOD = -2;
/** Target modifier while prone and non-adjacent (TW p.113). */
const PRONE_TARGET_DISTANT_MOD = 1;
/** Max distance counting as adjacent for the prone-target modifier. */
const PRONE_ADJACENT_MAX_DISTANCE = 1;
/** Weapon modifier: the To-Hit Mod column (TW p.303-304), 0 when absent. */
export function weaponToHitModifier(weapon: WeaponDef): number {
  return weapon.toHitMod ?? 0;
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
      coverMod: 0,
      rangeMod: 0,
      weaponMod: 0,
      minRangeMod: 0,
      heatMod: 0,
      sensorMod: 0,
      actuatorMod: 0,
      tcMod: 0,
      secondaryTargetMod: 0,
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

  const terrainMod = mods.interveningWoods + terrainTargetMod(mods.targetTerrain);
  const coverMod = mods.partialCoverMod ?? 0;

  const rangeMod = RANGE_MOD[bracket];
  const weaponMod = weaponToHitModifier(mods.weapon);
  const min =
    mods.weapon.minRange !== undefined && mods.distance <= mods.weapon.minRange
      ? mods.weapon.minRange - mods.distance + 1
      : 0;
  const heatMod = mods.heatMod ?? 0;
  const sensorMod = mods.sensorMod ?? 0;
  const actuatorMod = mods.actuatorMod ?? 0;
  const tcMod = mods.tcMod ?? 0;
  const secondaryTargetMod = mods.secondaryTargetMod ?? 0;

  const parts = {
    gunnery: mods.gunnery,
    attackerMod,
    targetMod,
    terrainMod,
    coverMod,
    rangeMod,
    weaponMod,
    minRangeMod: min,
    heatMod,
    sensorMod,
    actuatorMod,
    tcMod,
    secondaryTargetMod,
    rangeBracket: bracket,
    outOfRange: false,
  };
  const total = toHitTotal(parts);
  return {
    ...parts,
    automatic: total <= D2D6_MIN ? "hit" : total > D2D6_MAX ? "miss" : null,
  };
}

/** Modified to-hit number: the sum of the breakdown's terms (infinite when
 *  out of range). */
export function toHitTotal(b: Omit<ToHitBreakdown, "automatic">): number {
  if (b.outOfRange) return Number.POSITIVE_INFINITY;
  return (
    b.gunnery +
    b.attackerMod +
    b.targetMod +
    b.terrainMod +
    b.coverMod +
    b.rangeMod +
    b.weaponMod +
    b.minRangeMod +
    b.heatMod +
    b.sensorMod +
    b.actuatorMod +
    b.tcMod +
    b.secondaryTargetMod
  );
}

const RANGE_VAR_DAMAGE_INDEX: Record<RangeBracket, number> = { short: 0, medium: 1, long: 2 };

/** Damage for the bracket actually rolled (handles V-code variable damage). */
export function damageForBracket(weapon: WeaponDef, bracket: RangeBracket): number {
  if (weapon.variableDamage !== undefined) {
    return weapon.variableDamage[RANGE_VAR_DAMAGE_INDEX[bracket]]!;
  }
  return weapon.damage ?? 0;
}

/** 2d6 ways to roll >= tn, over 36. TNs below 3 always hit; above 12 never do. */
const WAYS_TO_HIT: readonly number[] = [36, 36, 36, 35, 33, 30, 26, 21, 15, 10, 6, 3, 1, 0];

/** Probability that 2D6 rolls at least `tn` (TW p. 106: 2 or less always hits, over 12 never). */
export function hitProbability(tn: number): number {
  if (tn <= D2D6_MIN) return 1;
  if (tn > D2D6_MAX) return 0;
  return WAYS_TO_HIT[tn]! / 36;
}
