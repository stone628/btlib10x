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
 *   entering/leaving a building     +0 light / +1 medium / +2 heavy / +5 hardened
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
 * halves the damage, rounding down (TW errata). After the fall the pilot
 * makes a second PSR with the same modifiers (or +5 for an automatic fall
 * from a destroyed leg, +6 from a destroyed gyro) or takes 1 pilot hit.
 * Pilot hits force consciousness rolls (TW p.42): 1 hit -> 3+, 2 -> 5+,
 * 3 -> 7+, 4 -> 10+, 5 -> 11+, 6 hits = dead.
 *
 * All functions here are pure; game.ts commits the results onto UnitState.
 */

import { roll2D6, rollD6 } from "../core/dice.js";
import type { Facing, Location, Rng } from "../core/types.js";
import { rotateFacing } from "../core/types.js";
import type { ResolvedMechDef } from "../data/mech.schema.js";
import type { Arc } from "./arcs.js";

/** Default pilot skill for `UnitInit`s that omit it (TW regular pilot). */
export const DEFAULT_PILOTING = 5;

/** Pilot hits that kill the MechWarrior outright. */
export const PILOT_HITS_DEAD = 6;

/** Damage in a single phase that forces a PSR (TW p.60). */
export const PSR_DAMAGE_THRESHOLD = 20;

/** Crit-slot structure names that feed piloting. */
export const GYRO = "gyro";
export const HIP = "hip";
export const LIFE_SUPPORT = "lifeSupport";
export const SENSORS = "sensors";
export const LEG_ACTUATORS: ReadonlySet<string> = new Set([
  "upperLegActuator",
  "lowerLegActuator",
  "footActuator",
]);

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
): { target: number; roll: number | null; success: boolean } {
  const target = piloting + modifier;
  if (target <= 2) return { target, roll: null, success: true };
  if (target > 12) return { target, roll: null, success: false };
  const roll = roll2D6(rng);
  if (roll === 2) return { target, roll, success: false };
  if (roll === 12) return { target, roll, success: true };
  return { target, roll, success: roll >= target };
}

/** Count destroyed structure slots named `name` across all locations. */
export function countDestroyedStructure(
  def: ResolvedMechDef,
  destroyed: Readonly<Record<Location, readonly boolean[]>>,
  name: string,
): number {
  let n = 0;
  for (const loc of Object.keys(def.critSlots) as Location[]) {
    const layout = def.critSlots[loc];
    const flags = destroyed[loc];
    for (let i = 0; i < layout.length; i++) {
      const slot = layout[i];
      if (slot?.kind === "structure" && slot.name === name && (flags?.[i] ?? false)) n += 1;
    }
  }
  return n;
}

/** Destroyed structure names on one leg (`rightLeg` / `leftLeg`). */
export function destroyedLegStructures(
  def: ResolvedMechDef,
  destroyed: Readonly<Record<Location, readonly boolean[]>>,
  leg: "rightLeg" | "leftLeg",
): string[] {
  const out: string[] = [];
  const layout = def.critSlots[leg];
  const flags = destroyed[leg];
  for (let i = 0; i < layout.length; i++) {
    const slot = layout[i];
    if (slot?.kind === "structure" && (flags?.[i] ?? false)) out.push(slot.name);
  }
  return out;
}

/**
 * Preexisting-damage modifier for a PSR, evaluated against a crit-slot state
 * (TW p.60 "Preexisting Damage"): +1 per destroyed leg/foot actuator, +2 per
 * destroyed hip (which replaces the other actuator mods on that leg), +3 for
 * a previously hit gyro, +5 per previously destroyed leg (which replaces all
 * other mods on that leg).
 */
export interface PreexistingDamage {
  readonly modifier: number;
  /** Destroyed gyro slots (0, 1, or 2). */
  readonly gyroHits: number;
  /** Destroyed legs (internal structure gone). */
  readonly legsDestroyed: number;
}

export function preexistingDamageModifier(
  def: ResolvedMechDef,
  destroyed: Readonly<Record<Location, readonly boolean[]>>,
  legIsGone: (leg: "rightLeg" | "leftLeg") => boolean,
): PreexistingDamage {
  const gyroHits = countDestroyedStructure(def, destroyed, GYRO);
  let modifier = 0;
  let legsDestroyed = 0;
  for (const leg of ["rightLeg", "leftLeg"] as const) {
    if (legIsGone(leg)) {
      legsDestroyed += 1;
      modifier += 5;
      continue;
    }
    const names = destroyedLegStructures(def, destroyed, leg);
    if (names.includes(HIP)) {
      modifier += 2;
      continue;
    }
    for (const name of names) {
      if (LEG_ACTUATORS.has(name)) modifier += 1;
    }
  }
  if (gyroHits >= 1 && gyroHits < 2) modifier += 3;
  return { modifier, gyroHits, legsDestroyed };
}

/**
 * Consciousness target number for a pilot with `hits` hits (TW p.42):
 * 1 -> 3, 2 -> 5, 3 -> 7, 4 -> 10, 5 -> 11. Six hits kills the pilot.
 */
export function consciousnessTarget(hits: number): number | null {
  switch (hits) {
    case 1:
      return 3;
    case 2:
      return 5;
    case 3:
      return 7;
    case 4:
      return 10;
    case 5:
      return 11;
    default:
      return null;
  }
}

/** Roll one consciousness check: 2D6 >= target keeps the pilot awake. */
export function rollConsciousness(rng: Rng, target: number): { roll: number; success: boolean } {
  const roll = roll2D6(rng);
  return { roll, success: roll >= target };
}

/** Falling-damage total: ceil(tonnage / 10) x (levels fallen + 1) (TW p.68). */
export function fallingDamageTotal(tonnage: number, levelsFallen: number): number {
  return Math.ceil(tonnage / 10) * (levelsFallen + 1);
}

/** Damage totals split into 5-point clusters (last group takes the remnant). */
export function fallingDamageGroups(total: number): number[] {
  const groups: number[] = [];
  let rest = total;
  while (rest > 0) {
    const g = Math.min(5, rest);
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
 * column for the falling damage.
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
      return { roll, shift: -1, column: "leftSide" };
    default:
      return { roll, shift: -2, column: "leftSide" };
  }
}

/** New facing after a fall direction's shift. */
export function facingAfterFall(facing: Facing, shift: number): Facing {
  return rotateFacing(facing, shift);
}

/** Building-entry PSR modifier by building class (TW p.166). */
export function buildingEntryModifier(terrain: string): number | null {
  switch (terrain) {
    case "lightBuilding":
      return 0;
    case "mediumBuilding":
      return 1;
    case "heavyBuilding":
      return 2;
    case "hardenedBuilding":
      return 5;
    default:
      return null;
  }
}

/** Terrain-entry PSR modifier for water depth (TW p.60). */
export function waterEntryModifier(terrain: string): number | null {
  switch (terrain) {
    case "water1":
      return -1;
    case "water2":
      return 0;
    case "water3":
      return 1;
    default:
      return null;
  }
}
