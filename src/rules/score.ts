/**
 * Battle score readout (docs/SCORING.md): TW p.257 Battle Value victory
 * points, extended so a unit still in play counts part of its value. A pure
 * read of the current state, valid at any moment of the battle; deciding a
 * winner from it stays with the caller (VISION §1).
 */

import type { Location } from "../core/types";
import { LOCATIONS, TORSO_LOCATIONS } from "../core/types";
import { mechDefFor, type ResolvedMechDef } from "../data/index";
import { type WeaponDef, weaponDefFor } from "../data/weapon.schema";
import { binsForWeaponName, pooledShotsLeft } from "./ammo";
import {
  countDestroyedEngine,
  countDestroyedGyro,
  countDestroyedSensor,
  isWeaponCritted,
} from "./critical";
import { canFireMount, isUnitLocationDestroyed, type UnitDamageState } from "./damage";
import type { BattleState, UnitState } from "./game/types";
import { SENSOR_BLIND_HITS } from "./piloting";
import { damageForBracket } from "./tohit";

/**
 * TechManual skill multiplier (TM p.315), `[gunnery][piloting]`, 0..8 each.
 * MUL BV is rated for a regular 4/5 MechWarrior (1.00).
 */
export const BV_SKILL_MULTIPLIER: readonly (readonly number[])[] = [
  [2.42, 2.31, 2.21, 2.1, 1.93, 1.75, 1.68, 1.59, 1.5],
  [2.21, 2.11, 2.02, 1.92, 1.76, 1.6, 1.54, 1.46, 1.38],
  [1.93, 1.85, 1.76, 1.68, 1.54, 1.4, 1.35, 1.28, 1.21],
  [1.66, 1.58, 1.51, 1.44, 1.32, 1.2, 1.16, 1.1, 1.04],
  [1.38, 1.32, 1.26, 1.2, 1.1, 1.0, 0.95, 0.9, 0.85],
  [1.31, 1.19, 1.13, 1.08, 0.99, 0.9, 0.86, 0.81, 0.77],
  [1.24, 1.12, 1.07, 1.02, 0.94, 0.85, 0.81, 0.77, 0.72],
  [1.17, 1.06, 1.01, 0.96, 0.88, 0.8, 0.76, 0.72, 0.68],
  [1.1, 0.99, 0.95, 0.9, 0.83, 0.75, 0.71, 0.68, 0.64],
];

/** Weight of an enemy unit's lost value in a team's score (TW p.257). */
export const SCORE_ENEMY_WEIGHT = 2;
/** Weight of an own unit's lost value, subtracted (TW p.257). */
export const SCORE_OWN_WEIGHT = 1;
/** `lost` of a crippled unit still in play, and the cap of the damage term. */
export const SCORE_CRIPPLED_LOST = 0.5;

/** Why a unit in play counts as crippled (TW p.258). */
export type CrippleReason =
  | "sideTorsoDestroyed"
  | "engineHits"
  | "gyroAndEngineHits"
  | "sensorsLost"
  | "limbStructureDamage"
  | "torsoStructureDamage"
  | "pilotHits"
  | "allWeaponsLost";

export interface UnitScore {
  readonly unitId: string;
  readonly model: string;
  readonly team: number;
  /** MUL BV of the model (0 when the MUL lists none). */
  readonly bv: number;
  /** BV × skill multiplier, rounded: the unit's value V. */
  readonly value: number;
  /** Armor + structure lost over the def's starting total, 0..1. */
  readonly damaged: number;
  /** Empty when not crippled or out of play. */
  readonly crippled: readonly CrippleReason[];
  /** True once the unit left play (hull or wreckage). */
  readonly outOfPlay: boolean;
  /** Fraction of `value` counted as lost: 1, 0.5 crippled, else damaged / 2. */
  readonly lost: number;
}

export interface TeamScore {
  readonly team: number;
  /** Victory points, rounded. */
  readonly score: number;
  /** Σ value × lost of this team's units. */
  readonly lostValue: number;
  readonly units: readonly UnitScore[];
}

/** Skill multiplier for a gunnery / piloting pair, clamped to the 0..8 table. */
export function bvSkillMultiplier(gunnery: number, piloting: number): number {
  const clamp = (n: number) => Math.min(8, Math.max(0, Math.round(n)));
  return BV_SKILL_MULTIPLIER[clamp(gunnery)]![clamp(piloting)]!;
}

function sumLocations(d: UnitDamageState): number {
  let total = 0;
  for (const loc of LOCATIONS) total += d.armor[loc] + d.internalStructure[loc];
  for (const loc of TORSO_LOCATIONS) total += d.armorRear[loc];
  return total;
}

function startingPoints(def: ResolvedMechDef): number {
  return sumLocations({
    armor: def.armor,
    armorRear: def.armorRear,
    internalStructure: def.internalStructure,
  });
}

/** Armor + structure lost against the def's full values, 0..1. */
export function damagedFraction(unit: UnitState): number {
  const def = mechDefFor(unit);
  const start = startingPoints(def);
  if (start <= 0) return 0;
  const left = sumLocations(unit.damage);
  return Math.min(1, Math.max(0, (start - left) / start));
}

/** Most damage a weapon can deal in one turn, over its range brackets. */
function maxDamage(weapon: WeaponDef): number {
  const shots = weapon.rapidFireShots ?? 1;
  if (weapon.missiles !== undefined) return weapon.missiles * (weapon.missileDamage ?? 1) * shots;
  const direct = Math.max(
    damageForBracket(weapon, "short"),
    damageForBracket(weapon, "medium"),
    damageForBracket(weapon, "long"),
  );
  return direct * shots;
}

/** TW p.258 "all weapons destroyed" test over a set of weapon defs: true when
 *  none reaches past 5 hexes and together they deal no more than 5. */
function weaponless(weapons: readonly WeaponDef[]): boolean {
  if (weapons.some((w) => w.long > 5)) return false;
  return weapons.reduce((sum, w) => sum + maxDamage(w), 0) <= 5;
}

function allWeaponsLost(unit: UnitState, def: ResolvedMechDef): boolean {
  const design: WeaponDef[] = [];
  const working: WeaponDef[] = [];
  for (const [key, mount] of Object.entries(def.weapons)) {
    const weapon = weaponDefFor(mount);
    if (weapon.physicalWeapon) continue;
    design.push(weapon);
    if (!canFireMount(unit.damage, mount)) continue;
    if (isWeaponCritted(def, unit.critSlotsDestroyed, Number(key))) continue;
    const fed = binsForWeaponName(def, mount.weapon).length > 0;
    if (fed && pooledShotsLeft(def, unit, mount.weapon) <= 0) continue;
    working.push(weapon);
  }
  // A unit that never cleared the bar can never lose all its weapons.
  if (weaponless(design)) return false;
  return weaponless(working);
}

/** TW p.258 crippling-damage conditions met by a unit in play. */
export function crippleReasons(unit: UnitState): CrippleReason[] {
  const def = mechDefFor(unit);
  const d = unit.damage;
  const out: CrippleReason[] = [];
  if (isUnitLocationDestroyed(d, "leftTorso") || isUnitLocationDestroyed(d, "rightTorso")) {
    out.push("sideTorsoDestroyed");
  }
  const engine = countDestroyedEngine(def, d, unit.critSlotsDestroyed);
  const gyro = countDestroyedGyro(def, d, unit.critSlotsDestroyed);
  if (engine >= 2) out.push("engineHits");
  else if (engine >= 1 && gyro >= 1) out.push("gyroAndEngineHits");
  if (countDestroyedSensor(def, d, unit.critSlotsDestroyed) >= SENSOR_BLIND_HITS) {
    out.push("sensorsLost");
  }
  const structureHit = (loc: Location) => d.internalStructure[loc] < def.internalStructure[loc];
  const limbs: Location[] = ["leftArm", "rightArm", "leftLeg", "rightLeg"];
  if (limbs.filter(structureHit).length >= 3) {
    out.push("limbStructureDamage");
  }
  // Torso structure damage counts only once that torso's front armor is gone.
  if (TORSO_LOCATIONS.filter((l) => structureHit(l) && d.armor[l] <= 0).length >= 2) {
    out.push("torsoStructureDamage");
  }
  if (unit.pilotHits >= 4) out.push("pilotHits");
  if (allWeaponsLost(unit, def)) out.push("allWeaponsLost");
  return out;
}

/** One unit's part of the score. */
export function unitScore(unit: UnitState): UnitScore {
  const def = mechDefFor(unit);
  const value = Math.round(def.bv * bvSkillMultiplier(unit.gunnery, unit.piloting));
  const damaged = damagedFraction(unit);
  const outOfPlay = unit.removed !== "not";
  const crippled = outOfPlay ? [] : crippleReasons(unit);
  const lost = outOfPlay
    ? 1
    : crippled.length > 0
      ? SCORE_CRIPPLED_LOST
      : Math.min(SCORE_CRIPPLED_LOST, SCORE_CRIPPLED_LOST * damaged);
  return {
    unitId: unit.id,
    model: unit.model,
    team: unit.team,
    bv: def.bv,
    value,
    damaged,
    crippled,
    outOfPlay,
    lost,
  };
}

/**
 * Every team's score right now, in ascending team order:
 * `2 × Σ enemy value × lost − 1 × Σ own value × lost`. Read-only.
 */
export function scoreReport(state: BattleState): TeamScore[] {
  const units = Object.values(state.units).map(unitScore);
  const teams = [...new Set(units.map((u) => u.team))].sort((a, b) => a - b);
  const lostBy = new Map<number, number>();
  for (const u of units) lostBy.set(u.team, (lostBy.get(u.team) ?? 0) + u.value * u.lost);
  return teams.map((team) => {
    const own = lostBy.get(team) ?? 0;
    let enemy = 0;
    for (const [t, v] of lostBy) if (t !== team) enemy += v;
    return {
      team,
      score: Math.round(SCORE_ENEMY_WEIGHT * enemy - SCORE_OWN_WEIGHT * own),
      lostValue: own,
      units: units.filter((u) => u.team === team),
    };
  });
}
