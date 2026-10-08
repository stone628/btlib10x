/**
 * Piloting Skill Rolls (BattleTech Total Warfare, pp. 59-60, 68-69).
 *
 * A 'Mech falls when its pilot fails a Piloting Skill Roll (PSR): roll 2D6
 * against `piloting + modifier`. A natural 2 always fails and a natural 12
 * always succeeds (standard TW dice); a target number above 12 falls
 * automatically without rolling. Modifiers come from the PSR table plus
 * preexisting damage (TW p.60):
 *
 *   trigger (this phase)            modifier
 *   20+ damage points in one phase  +1
 *   leg/foot actuator destroyed     +1 each
 *   hip actuator destroyed          +2 each
 *   gyro hit (first)                +3
 *   gyro destroyed                  automatic fall
 *   leg destroyed                   automatic fall
 *   entering rubble hex             +0
 *   entering depth-1 water hex      -1
 *   entering depth-2 water hex      +0
 *   entering depth-3+ water hex     +1
 *   entering a building             +0 light / +1 medium / +2 heavy / +5 hardened
 *   attempting to stand             +0
 *
 *   preexisting damage (applies to every PSR)
 *   per leg/foot actuator destroyed +1
 *   per hip destroyed               +2 (replaces other mods on that leg)
 *   gyro previously hit             +3
 *   per leg previously destroyed    +5 (replaces other mods on that leg)
 *
 * A shut-down 'Mech that must make a PSR falls automatically and its pilot
 * takes 1 point of damage (TW p.60 footnote). Falling damage is
 * `ceil(tonnage / 10) x (levels fallen + 1)`, grouped in 5-point clusters on
 * the Facing After Fall column (TW p.68); a fall underwater (depth 2+)
 * halves the damage, rounding the final total down (TW errata, p.57).
 * Levels fallen measure underlying terrain (hex fell into minus hex the
 * fall began from); a 'Mech that jumped that phase and falls from a failed
 * PSR counts as fallen 0 levels (TW errata, p.68). After the fall the pilot
 * makes a second PSR with the same modifiers (or +5 for an automatic fall
 * from a destroyed leg, +6 from a destroyed gyro) plus +1 per level above
 * 1 fallen, or takes 1 pilot hit. Pilot hits force consciousness rolls
 * (TW p.42): 1 hit -> 3+, 2 -> 5+, 3 -> 7+, 4 -> 10+, 5 -> 11+,
 * 6 hits = dead.
 *
 * All functions here are pure; game.ts commits the results onto UnitState.
 */

import { D2D6_MAX, D2D6_MIN, roll2D6, rollD6 } from "../core/dice";
import { ejectionLandingMod } from "../core/terrain";
import type { Facing, Rng, TerrainType } from "../core/types";
import { rotateFacing } from "../core/types";
import type { ResolvedMechDef } from "../data/mech.schema";
import type { Arc } from "./arcs";
import { type CritMask, countDestroyedGyro, destroyedStructures, HIP } from "./critical";
import { isUnitLocationDestroyed, type UnitDamageState } from "./damage";
import type { UnitSkillRange } from "./game";

/** Default pilot skill for `UnitInit`s that omit it (TW regular pilot). */
export const DEFAULT_PILOTING: UnitSkillRange = 5;

/** Default pilot hit capacity (TW p.41-42): the sixth hit kills the MechWarrior.
 *  `UnitInit.pilotHitMax` overrides it per pilot (tough / weak pilots). */
export const DEFAULT_PILOT_HIT_MAX = 6;

/** Ejection PSR base modifier (Tactical Operations); the Ejection Modifiers
 *  Table terms are summed on top by `ejectionModifier`. */
export const EJECTION_BASE_MODIFIER = 0;

/** Ejection Modifiers Table (TO p.165) situational terms. */
export const EJECTION_PRONE_MOD = 5;
export const EJECTION_UNCONSCIOUS_MOD = 3;
export const EJECTION_AUTO_MOD = 1;

export interface EjectionModifierInput {
  readonly landingTerrain: TerrainType;
  readonly landingLevel: number;
  readonly prone: boolean;
  readonly unconscious: boolean;
  /** Head internal structure points already lost (+1 each). */
  readonly headStructureDamage: number;
  /** True for automatic ejection (+1). */
  readonly auto: boolean;
}

/** Total Ejection Modifiers Table modifier (TO p.165). Planetary conditions
 *  are not modeled. */
export function ejectionModifier(input: EjectionModifierInput): number {
  return (
    EJECTION_BASE_MODIFIER +
    ejectionLandingMod(input.landingTerrain, input.landingLevel) +
    (input.prone ? EJECTION_PRONE_MOD : 0) +
    (input.unconscious ? EJECTION_UNCONSCIOUS_MOD : 0) +
    Math.max(0, input.headStructureDamage) +
    (input.auto ? EJECTION_AUTO_MOD : 0)
  );
}

/** Pilot hits from a failed ejection PSR: floor(margin of failure / 2). */
export function ejectionDamage(r: PilotingRollResult): number {
  if (r.success) return 0;
  return Math.floor((r.target - (r.roll ?? D2D6_MIN)) / 2);
}

/** True for a legal `pilotHitMax`: an integer >= 1. */
export function isValidPilotHitMax(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/** Damage in a single phase that forces a PSR (TW p.60). */
export const PSR_DAMAGE_THRESHOLD = 20;

/** To-hit penalty while exactly one sensor slot is destroyed (TW p.123). */
export const SENSOR_ONE_HIT_MOD = 2;
/** Destroyed sensor slots that blind the 'Mech: no weapon attacks at all (TW p.123). */
export const SENSOR_BLIND_HITS = 2;

/** Weapon to-hit modifier for a destroyed-sensor count (0 intact, +2 on first hit). */
export function sensorAttackModifier(destroyedSensors: number): number {
  return destroyedSensors > 0 ? SENSOR_ONE_HIT_MOD : 0;
}

/** True when destroyed sensors blind the 'Mech entirely (second hit). */
export function sensorsBlind(destroyedSensors: number): boolean {
  return destroyedSensors >= SENSOR_BLIND_HITS;
}
export const LEG_ACTUATORS: ReadonlySet<string> = new Set([
  "upperLegActuator",
  "lowerLegActuator",
  "footActuator",
]);

/** Outcome of one Piloting Skill Roll; `roll` is null when it was automatic. */
export interface PilotingRollResult {
  readonly target: number;
  readonly roll: number | null;
  readonly success: boolean;
}

/**
 * Roll a Piloting Skill Roll against `piloting + modifier`. Returns the roll
 * outcome; a `null` roll means the outcome was automatic (no dice drawn).
 * A natural 2 always fails, a natural 12 always succeeds, and a target
 * number above 12 fails without rolling.
 */
export function rollPilotingCheck(
  rng: Rng,
  piloting: number,
  modifier: number,
): PilotingRollResult {
  const target = piloting + modifier;
  if (target <= D2D6_MIN) return { target, roll: null, success: true };
  if (target > D2D6_MAX) return { target, roll: null, success: false };
  const roll = roll2D6(rng);
  return { target, roll, success: roll >= target };
}

/**
 * Preexisting-damage modifier for a PSR, evaluated against a crit-slot state
 * (TW p.60 "Preexisting Damage"): LEG_ACTUATOR_MOD per destroyed leg/foot
 * actuator, HIP_MOD per destroyed hip (which replaces the other actuator
 * mods on that leg), GYRO_HIT_MOD for a previously hit gyro,
 * GYRO_DESTROYED_HITS or more gyro hits blocks standing, and
 * LEG_DESTROYED_MOD per previously destroyed leg (which replaces all
 * other mods on that leg).
 */
/** PSR modifier per destroyed leg (leg gone; replaces all other mods on that leg). */
export const LEG_DESTROYED_MOD = 5;
/** PSR modifier per destroyed hip (replaces other actuator mods on that leg). */
export const HIP_MOD = 2;
/** PSR modifier per destroyed leg/foot actuator. */
export const LEG_ACTUATOR_MOD = 1;
/** PSR modifier for a previously hit (but intact) gyro. */
export const GYRO_HIT_MOD = 3;
/** Destroyed gyro slots that forbid standing. */
export const GYRO_DESTROYED_HITS = 2;

export interface PreexistingDamage {
  readonly modifier: number;
  /** Destroyed gyro slots (0, 1, or 2). */
  readonly gyroHits: number;
  /** Destroyed legs (internal structure gone). */
  readonly legsDestroyed: number;
}

export function preexistingDamageModifier(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  destroyed: Readonly<CritMask>,
): PreexistingDamage {
  const gyroHits = countDestroyedGyro(def, damage, destroyed);
  let modifier = 0;
  let legsDestroyed = 0;
  for (const leg of ["rightLeg", "leftLeg"] as const) {
    if (isUnitLocationDestroyed(damage, leg)) {
      legsDestroyed += 1;
      modifier += LEG_DESTROYED_MOD;
      continue;
    }
    // TW p.60 note 5: a destroyed hip replaces every other critical
    // modifier on that leg.
    const legCrits = destroyedStructures(def, damage, destroyed, leg);
    if (legCrits.includes(HIP)) {
      modifier += HIP_MOD;
      continue;
    }
    for (const n of legCrits) {
      if (LEG_ACTUATORS.has(n)) modifier += LEG_ACTUATOR_MOD;
    }
  }
  if (gyroHits >= 1 && gyroHits < GYRO_DESTROYED_HITS) modifier += GYRO_HIT_MOD;
  return { modifier, gyroHits, legsDestroyed };
}

/**
 * Consciousness target numbers by pilot hits for the default six-hit pilot
 * (TW p.42); the sixth hit kills the pilot (see DEFAULT_PILOT_HIT_MAX).
 */
const CONSCIOUSNESS_TARGETS: readonly number[] = [0, 3, 5, 7, 10, 11];

/** Tonnage divisor for falling-damage totals: ceil(tonnage / 10). */
export const FALL_TONNAGE_DIVISOR = 10;
/** Falling damage lands in clusters of this size (last group takes remnant). */
export const FALL_CLUSTER_SIZE = 5;
/**
 * Consciousness target for a pilot with `hits` taken out of `hitMax`.
 * `null` once `hits >= hitMax` (pilot dead). The TW six-hit table is scaled to
 * `hitMax`: step = clamp(round(hits * 6 / hitMax), 1, 5). hitMax 6 is the
 * printed table; 5 gives 3,5,10,11; 7 gives 3,5,7,7,10,11. Zero hits needs no roll.
 */
export function consciousnessTarget(
  hits: number,
  hitMax: number = DEFAULT_PILOT_HIT_MAX,
): number | null {
  if (hits >= hitMax) return null;
  if (hits <= 0) return 0;
  const step = Math.min(5, Math.max(1, Math.round((hits * DEFAULT_PILOT_HIT_MAX) / hitMax)));
  return CONSCIOUSNESS_TARGETS[step] ?? null;
}

/** Roll one consciousness check: 2D6 >= target keeps the pilot awake. */
export function rollConsciousness(rng: Rng, target: number): { roll: number; success: boolean } {
  const roll = roll2D6(rng);
  return { roll, success: roll >= target };
}

/** Falling-damage total: ceil(tonnage / FALL_TONNAGE_DIVISOR) x (levels fallen + 1) (TW p.68). */
export function fallingDamageTotal(tonnage: number, levelsFallen: number): number {
  return Math.ceil(tonnage / FALL_TONNAGE_DIVISOR) * (levelsFallen + 1);
}

/** Damage totals split into FALL_CLUSTER_SIZE-point clusters (last group takes the remnant). */
export function fallingDamageGroups(total: number): number[] {
  const groups: number[] = [];
  let rest = total;
  while (rest > 0) {
    const g = Math.min(FALL_CLUSTER_SIZE, rest);
    groups.push(g);
    rest -= g;
  }
  return groups;
}

export interface FallDirection {
  /** Facing shift in hexsides (clockwise) from the Facing After Fall table. */
  readonly shift: number;
  /** Hit-location column the fall damage lands on. */
  readonly column: Arc;
}

/**
 * Facing After a Fall table (TW p.68): 1D6 picks the direction the 'Mech
 * falls relative to its facing, which rotates the 'Mech and selects the hit
 * column for the falling damage. Shifts run clockwise (positive = right):
 *
 *   1 same facing / front | 2 +1 / rightSide | 3 +2 / rightSide |
 *   4 +3 / rear | 5 -2 / leftSide | 6 -1 / leftSide
 */
export function rollFallDirection(rng: Rng): { roll: number } & FallDirection {
  const roll = rollD6(rng);
  switch (roll) {
    case 1:
      return { roll, shift: 0, column: "front" };
    case 2:
      return { roll, shift: 1, column: "rightSide" };
    case 3:
      return { roll, shift: 2, column: "rightSide" };
    case 4:
      return { roll, shift: 3, column: "rear" };
    case 5:
      return { roll, shift: -2, column: "leftSide" };
    default:
      return { roll, shift: -1, column: "leftSide" };
  }
}

/** New facing after a fall direction's shift. */
export function facingAfterFall(facing: Facing, shift: number): Facing {
  return rotateFacing(facing, shift);
}

/** Building-entry PSR modifiers by building class (TW p.167). */
const BUILDING_ENTRY_MODS: Readonly<Record<string, number>> = {
  lightBuilding: 0,
  mediumBuilding: 1,
  heavyBuilding: 2,
  hardenedBuilding: 5,
};

/** Building-entry PSR modifier by building class (TW p.167). */
export function buildingEntryModifier(terrain: string): number | null {
  return BUILDING_ENTRY_MODS[terrain] ?? null;
}

/** Water-entry PSR modifiers by depth (TW p.60). */
const WATER_ENTRY_MODS: Readonly<Record<string, number>> = {
  water1: -1,
  water2: 0,
  water3: 1,
};

/** Terrain-entry PSR modifier for water depth (TW p.60). */
export function waterEntryModifier(terrain: string): number | null {
  return WATER_ENTRY_MODS[terrain] ?? null;
}
