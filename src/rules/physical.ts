/**
 * Physical attack rules (BattleTech Total Warfare, pp. 144–153).
 *
 * Implements punch, kick, club, physical-weapon (strike), charge and DFA
 * attacks. Charge and DFA are declared by movement (ending a path in an enemy
 * hex), stop the attacker in front of the target, and never displace anyone.
 * A club attack requires the
 * attacker to hold a club (`UnitState.club`), acquired through the pickup
 * rules in `game.ts` (severed limbs, trees, girders).
 *
 * Physical attacks are declared in the weapon attack phase and resolved
 * after all weapon attacks (TW p. 37 phase order within the unified phase).
 */

import { roll2D6, rollD6 } from "../core/dice";
import { bearingExact, hexDistance, isAdjacent, neighbor } from "../core/hex";
import { cellAt, groundLevel, terrainTargetMod } from "../core/terrain";
import type { ArmLocation, HexCoord, Location, Rng } from "../core/types";
import { isArm } from "../core/types";
import { mechDefFor } from "../data/index";
import type { ResolvedMechDef } from "../data/mech.schema";
import { weaponDefFor } from "../data/weapon.schema";
import { absentArmActuators, clubHandsFunctional, countArmActuators } from "./actuators";
import {
  type Arc,
  classifyArcWithBoundary,
  classifyFiringArc,
  defenderArcChoice,
  effectiveFacingForTwist,
  type Twist,
} from "./arcs";
import { isBuildingTerrain } from "./building";
import {
  type CriticalResolution,
  type CritMask,
  destroyedStructures,
  isWeaponCritted,
} from "./critical";
import {
  applyDamage,
  canFireFromLocation,
  type DamageApplication,
  type UnitDamageState,
} from "./damage";
import type { BattleState, UnitState } from "./game";
import {
  isImmobile,
  isTargetableBy,
  isUnitOnBoard,
  isUnitRemoved,
  losSideFor,
  partialCoverMod,
} from "./game";
import { isTsmActive } from "./heat";
import { hitLocationForArc, punchHitLocationForArc } from "./hitlocation";
import { losWoodsPointsBetween } from "./los";
import { attackerMovementModifier, TARGET_IMMOBILE_MOD, targetMovementModifier } from "./movement";
import { isPilotUnconscious } from "./pilot";
import { fallingDamageGroups } from "./piloting";
import { PRONE_ATTACKER_MOD, proneTargetModifier } from "./tohit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PhysicalAttackType = "punch" | "kick" | "club" | "strike" | "charge" | "dfa";

/** Charge and DFA are declared by movement (ending a path in an enemy hex),
 *  never through `declareAttacks`; the attacker stops in the hex before the
 *  target and no unit is ever displaced. */
export function isMeleeCharge(type: PhysicalAttackType): type is "charge" | "dfa" {
  return type === "charge" || type === "dfa";
}

/** Melee equipment usable through a strike (TW p.146 subset). */
export type PhysicalWeaponName = "Hatchet" | "Sword" | "Retractable Blade";

/** One declared physical attack.
 *
 * Immutable: all fields are `readonly`, so instances are assigned (shared by reference), never copied. */
export interface PhysicalAttackDecl {
  readonly type: PhysicalAttackType;
  readonly targetId: string;
  /** For punch: which arm. For kick: which leg. For strike: mounting arm. */
  readonly limb?: "leftArm" | "rightArm" | "leftLeg" | "rightLeg";
  /** For strike: which mounted physical weapon is used. */
  readonly weapon?: PhysicalWeaponName;
  /** Torso twist the attacker declared with (TW pp.37-38): holds through the
   *  physical sub-pass, which re-checks arcs against it. */
  readonly twist?: Twist;
}

export interface PhysicalModifiers {
  /** Base to-hit: piloting skill. */
  readonly base: number;
  /** Attack-type modifier (punch +0, kick −2, club −1, strike per weapon). */
  readonly attackMod: number;
  /** Attacker movement modifier (same band as weapon attacks). */
  readonly attackerMoveMod: number;
  /** Target movement modifier: hex band + jump extra, folding prone
   *  (−2 adjacent/+1 otherwise) and immobile (−4) cumulatively. */
  readonly targetMoveMod: number;
  /** Terrain modifier on target: target-hex woods + intervening woods. */
  readonly terrainMod: number;
  /** Partial-cover modifier (TW p.102): same source as weapon attacks. */
  readonly coverMod: number;
  /** Actuator damage modifier on attacker. */
  readonly actuatorMod: number;
  /** Prone attacker modifier (+2, cumulative with movement). */
  readonly proneMod: number;
}

/** Physical to-hit number: the sum of the modifiers. */
export function physicalToHitTotal(m: PhysicalModifiers): number {
  return (
    m.base +
    m.attackMod +
    m.attackerMoveMod +
    m.targetMoveMod +
    m.terrainMod +
    m.coverMod +
    m.actuatorMod +
    m.proneMod
  );
}

export interface DamageGroup {
  readonly location: Location;
  readonly damage: number;
  /** Through-armor critical: this group's location roll was a 2 on the 2D6
   *  table (charge groups roll their own locations, TW p.121). */
  readonly tac?: boolean;
  /** Arc whose column located this group and whose armor it strikes. Set by
   *  charge / DFA groups, where it can differ from the attack direction: a DFA
   *  against a prone 'Mech reads the Rear column and so hits rear armor
   *  (TW p.150). Absent: the damage side follows the attack direction. */
  readonly arc?: Arc;
}

/** Damage of all the groups together. */
export function damageGroupsTotal(groups: readonly DamageGroup[]): number {
  let n = 0;
  for (const g of groups) n += g.damage;
  return n;
}

export interface PhysicalResolution {
  readonly type: PhysicalAttackType;
  readonly attackerId: string;
  readonly targetId: string;
  /** Mounted physical weapon used (strike only). */
  readonly weapon?: PhysicalWeaponName;
  readonly toHit: number;
  readonly roll: number | null;
  readonly hit: boolean;
  readonly autoHit: boolean;
  readonly autoMiss: boolean;
  readonly damageToTarget: DamageGroup[];
  readonly damageToAttacker: DamageGroup[];
  /** One damage application per `damageToTarget` group, in order, as for
   *  weapon `applications`; drives the armor-change detail (`blastDetail`). */
  readonly applications: readonly DamageApplication[];
  /** The same for `damageToAttacker` (self-damage detail). */
  readonly attackerApplications: readonly DamageApplication[];
  /** Critical resolutions triggered by the target damage, rendered with the
   *  same `critLines` formatter as weapon `crits`. */
  readonly crits: readonly CriticalResolution[];
  readonly notes: string[];
  /** True when the hit-location roll was 2 (through-armor critical, TW p.123). */
  readonly throughArmorCrit: boolean;
  /** Why the attack never rolled (attackerDown | targetDown | dfaAborted |
   *  advanced | voided:<hexTaken|attackerDown> | invalid:<reason>). */
  readonly missReason?: string;
  /** Charge / DFA whose target had left its hex (`missReason` "advanced"):
   *  the hex the attacker moved into instead. */
  readonly advancedTo?: HexCoord;
  /** Kick target PSR deferred to the end-of-phase sweep (TW pp.59,147). */
  readonly kickTargetPsrPending?: boolean;
  /** Kick attacker PSR on a miss, deferred to the end-of-phase sweep. */
  readonly kickAttackerPsrPending?: boolean;
  /** Charge / DFA hit: PSR modifier the target rolls at the end-of-phase
   *  sweep (TW p.60: +2). */
  readonly targetPsrMod?: number;
  /** Charge / DFA hit: PSR modifier the attacker rolls at the sweep
   *  (charge +2, DFA +4). */
  readonly attackerPsrMod?: number;
  /** DFA missed: the attacker falls automatically (2 levels, rear hit
   *  location, TW p.150). */
  readonly dfaMissFall?: boolean;
}

// ---------------------------------------------------------------------------
// Constants (TW pp. 144–147)
// ---------------------------------------------------------------------------

/** Punch: +0 to-hit, 1 damage per 10 tons (round up). */
export const PUNCH_ATTACK_MOD = 0;
export const PUNCH_DAMAGE_PER_TONS = 10;

/** Kick: −2 to-hit, 1 damage per 5 tons (round up). */
export const KICK_ATTACK_MOD = -2;
export const KICK_DAMAGE_PER_TONS = 5;

/** Charge / DFA: +0 to-hit, plus the Piloting-skill difference (TW p.144). */
export const CHARGE_ATTACK_MOD = 0;
export const DFA_ATTACK_MOD = 0;
/** Charge: 1 damage per 10 tons per hex moved to the target; 1 per 10 tons
 *  of the target to the attacker (TW p.148). */
export const CHARGE_DAMAGE_PER_TONS = 10;
/** DFA: tonnage / 10 x 3 to the target, tonnage / 5 to the attacker's legs
 *  (TW p.150). */
export const DFA_DAMAGE_MULTIPLIER = 3;
export const DFA_RECOIL_PER_TONS = 5;
/** PSRs after a hit (TW p.60): target +2; charger +2; DFA attacker +4. */
export const CHARGE_PSR_MOD = 2;
export const DFA_ATTACKER_PSR_MOD = 4;
/** A failed DFA drops the attacker as from a 2-level fall (TW p.150). */
export const DFA_MISS_LEVELS_FALLEN = 2;

/** Club: −1 to-hit, 1 damage per 5 tons (round up). */
export const CLUB_ATTACK_MOD = -1;
export const CLUB_DAMAGE_PER_TONS = 5;

/** Physical weapons (TW p.146): per-weapon to-hit modifier and damage
 *  formula `ceil(tonnage / damagePerTons) + damageBonus`. All three use the
 *  standard hit-location table on the Arm arc (forward or mounting-arm side)
 *  and are TSM-sensitive (doubled while TSM is active, TW p.143/p.146). The
 *  optional Punch/Kick table election (+4) is deferred; the different-levels
 *  auto-swap (TW p.150) is implemented via `physicalLocationTable`. */
export interface PhysicalWeaponStats {
  readonly toHitMod: number;
  readonly damagePerTons: number;
  readonly damageBonus: number;
}

export const PHYSICAL_WEAPONS: Readonly<Record<PhysicalWeaponName, PhysicalWeaponStats>> = {
  Hatchet: { toHitMod: -1, damagePerTons: 5, damageBonus: 0 },
  Sword: { toHitMod: -2, damagePerTons: 10, damageBonus: 1 },
  "Retractable Blade": { toHitMod: -2, damagePerTons: 10, damageBonus: 0 },
};

/** Is `name` one of the three modeled physical weapons? */
export function isPhysicalWeaponName(name: string): name is PhysicalWeaponName {
  return name === "Hatchet" || name === "Sword" || name === "Retractable Blade";
}

/** Maximum to-hit: over 12 auto-miss (TW p. 144). */
export const PHYSICAL_MAX_TOHIT = 12;
/** Minimum to-hit: 2 or less auto-hit (TW p. 144). */
export const PHYSICAL_MIN_TOHIT = 2;

// ---------------------------------------------------------------------------
// To-hit computation
// ---------------------------------------------------------------------------

/**
 * Compute the to-hit number for a physical attack (TW p. 144).
 *
 * Base = piloting skill. Add attack-type modifier + all standard
 * weapon-attack modifiers (attacker movement, target movement, actuator
 * damage, terrain) except heat and sensor modifiers. Attacker movement,
 * target movement, and terrain reuse the weapon-attack helpers so both
 * paths follow the Attack Modifiers Table (TW pp. 117–118) cumulatively.
 */
export function computePhysicalToHit(
  battle: BattleState,
  attacker: UnitState,
  target: UnitState,
  type: PhysicalAttackType,
  limb: "leftArm" | "rightArm" | "leftLeg" | "rightLeg" | undefined,
  weapon?: PhysicalWeaponName,
): PhysicalModifiers {
  const base = attacker.piloting;
  const melee = isMeleeCharge(type);
  // Charge / DFA (TW p.144): add the Piloting-skill difference when the
  // target's rating is lower, subtract it when the attacker's is lower.
  const attackMod =
    attackTypeModifier(type, weapon) + (melee ? attacker.piloting - target.piloting : 0);

  // Attacker movement (TW pp. 113, 117–118): same band as weapon attacks,
  // plus +2 when prone — cumulative (ran then dropped prone is +4).
  const attackerMoveMod = attackerMovementModifier(attacker.moveMode ?? "standStill");

  // Target movement (TW pp. 109, 113, 117–118): full hex band + jump extra,
  // plus prone (−2 adjacent, +1 otherwise) and immobile (−4) — cumulative.
  const distance = hexDistance(attacker.position, target.position);
  const targetMoveMod =
    targetMovementModifier(target.hexesMovedThisTurn, target.jumpedThisTurn, undefined) +
    (target.prone ? proneTargetModifier(distance) : 0) +
    (isImmobile(target) ? TARGET_IMMOBILE_MOD : 0);

  // Terrain (TW pp. 107–108, 117–118): target-hex woods + intervening woods.
  // Partial cover (TW p.102) is a separate term — same as weapon attacks.
  const targetTerrain = cellAt(battle, target.position).terrain;
  // Charge / DFA are not modified for terrain (TW p.144).
  // One hexside chain for woods and cover (TW p.101, LOS-02).
  const losSide = losSideFor(battle, attacker, target, undefined);
  const terrainMod = melee
    ? 0
    : terrainTargetMod(targetTerrain) +
      losWoodsPointsBetween(battle, attacker.position, target.position, undefined, losSide);
  const coverMod = melee ? 0 : partialCoverMod(battle, attacker, target, losSide);

  // Actuator damage modifier
  const actuatorMod = physicalActuatorMod(attacker, type, limb, weapon);

  // Prone attacker modifier (TW p. 113), cumulative with movement above.
  const proneMod = attacker.prone ? PRONE_ATTACKER_MOD : 0;

  return {
    base,
    attackMod,
    attackerMoveMod,
    targetMoveMod,
    terrainMod,
    coverMod,
    actuatorMod,
    proneMod,
  };
}

function attackTypeModifier(type: PhysicalAttackType, weapon?: PhysicalWeaponName): number {
  switch (type) {
    case "punch":
      return PUNCH_ATTACK_MOD;
    case "kick":
      return KICK_ATTACK_MOD;
    case "club":
      return CLUB_ATTACK_MOD;
    case "strike":
      return weapon !== undefined ? (PHYSICAL_WEAPONS[weapon]?.toHitMod ?? 0) : 0;
    case "charge":
      return CHARGE_ATTACK_MOD;
    case "dfa":
      return DFA_ATTACK_MOD;
  }
}

/**
 * Actuator damage modifier for physical attacks (TW pp. 145–147).
 * Punch: +2 per damaged upper/lower arm actuator, +1 if no hand.
 * Kick: +2 per damaged upper/lower leg actuator, +1 per damaged foot.
 * Club: +2 per damaged upper/lower arm actuator.
 * Strike: like punch but in the mounting arm only; a damaged hand adds +1
 *   except on the Retractable Blade (TW p.146, hand exception).
 */
function physicalActuatorMod(
  attacker: UnitState,
  type: PhysicalAttackType,
  limb: "leftArm" | "rightArm" | "leftLeg" | "rightLeg" | undefined,
  weapon?: PhysicalWeaponName,
): number {
  const def = mechDefFor(attacker);
  const damage = attacker.damage;
  const destroyed = attacker.critSlotsDestroyed;

  switch (type) {
    case "punch": {
      if (!limb) return 0;
      if (limb !== "leftArm" && limb !== "rightArm") return 0;
      const counts = countArmActuators(def, damage, destroyed, limb);
      const absent = absentArmActuators(def, limb);
      let mod = 0;
      mod += (counts.upper + counts.lower + absent.upper + absent.lower) * 2;
      if (counts.hand > 0 || absent.hand > 0) mod += 1;
      return mod;
    }
    case "kick": {
      if (!limb) return 0;
      if (limb !== "leftLeg" && limb !== "rightLeg") return 0;
      // Leg actuators: +2 per damaged upper/lower (TW p.117–118
      // physical-only row), +1 per damaged foot.
      let mod = 0;
      const structs = destroyedStructuresIn(limb, def, damage, destroyed);
      if (structs.includes("upperLegActuator")) mod += 2;
      if (structs.includes("lowerLegActuator")) mod += 2;
      if (structs.includes("footActuator")) mod += 1;
      return mod;
    }
    case "club": {
      // +2 per damaged upper/lower arm actuator (both arms)
      let mod = 0;
      for (const arm of ["leftArm", "rightArm"] as const) {
        const counts = countArmActuators(def, damage, destroyed, arm);
        mod += (counts.upper + counts.lower) * 2;
      }
      return mod;
    }
    case "strike": {
      const arm = resolveStrikeArm(def, weapon, limb);
      if (arm === null) return 0;
      const counts = countArmActuators(def, damage, destroyed, arm);
      let mod = (counts.upper + counts.lower) * 2;
      if (counts.hand > 0 && weapon !== "Retractable Blade") mod += 1;
      return mod;
    }
    case "charge":
    case "dfa":
      return 0;
  }
}

// Helper functions for actuator counting
function destroyedStructuresIn(
  location: Location,
  def: ResolvedMechDef,
  damage: UnitDamageState,
  destroyed: Readonly<CritMask>,
): string[] {
  return destroyedStructures(def, damage, destroyed, location);
}

function countDestroyedStructure(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  destroyed: Readonly<CritMask>,
  location: Location,
  name: string,
): number {
  return destroyedStructures(def, damage, destroyed, location).filter((n) => n === name).length;
}

// ---------------------------------------------------------------------------
// Physical-weapon mount helpers
// ---------------------------------------------------------------------------

/** Arms mounting `weapon` on `def` (physical weapons mount in arms, TW p.146). */
export function strikeMountArms(
  def: ResolvedMechDef,
  weapon: PhysicalWeaponName | undefined,
): ArmLocation[] {
  if (weapon === undefined) return [];
  const arms: ArmLocation[] = [];
  for (const [key, mount] of Object.entries(def.weapons)) {
    void key;
    if (mount.weapon !== weapon) continue;
    if (isArm(mount.location)) arms.push(mount.location);
  }
  return arms;
}

/**
 * Resolve the mounting arm for a strike: the explicit `limb` when it is an
 * arm mounting the weapon, else the unique mounting arm, else the right arm
 * when it mounts the weapon, else the left. Returns null when no arm
 * mounts the weapon (or `weapon` is undefined).
 */
export function resolveStrikeArm(
  def: ResolvedMechDef,
  weapon: PhysicalWeaponName | undefined,
  limb: "leftArm" | "rightArm" | "leftLeg" | "rightLeg" | undefined,
): ArmLocation | null {
  if (weapon === undefined) return null;
  const arms = strikeMountArms(def, weapon);
  if (arms.length === 0) return null;
  if (limb === "leftArm" || limb === "rightArm") {
    return arms.includes(limb) ? limb : null;
  }
  if (arms.length === 1) return arms[0]!;
  if (arms.includes("rightArm")) return "rightArm";
  return arms[0]!;
}

/** Weapon-mount index of `weapon` in `arm`, or null when not mounted there. */
export function strikeWeaponIndex(
  def: ResolvedMechDef,
  weapon: PhysicalWeaponName,
  arm: ArmLocation,
): number | null {
  for (const [key, mount] of Object.entries(def.weapons)) {
    if (mount.weapon === weapon && mount.location === arm) return Number(key);
  }
  return null;
}

/** Physical weapon mounted in `arm`, or null when the arm mounts none. */
export function strikeWeaponInArm(
  def: ResolvedMechDef,
  arm: ArmLocation,
): PhysicalWeaponName | null {
  for (const name of ["Hatchet", "Sword", "Retractable Blade"] as const) {
    if (strikeMountArms(def, name).includes(arm)) return name;
  }
  return null;
}

/** Every mounted (arm, physical weapon) pair on `def`. */
export function strikeMounts(def: ResolvedMechDef): ReadonlyArray<{
  readonly arm: ArmLocation;
  readonly weapon: PhysicalWeaponName;
}> {
  const out: Array<{ arm: ArmLocation; weapon: PhysicalWeaponName }> = [];
  for (const weapon of ["Hatchet", "Sword", "Retractable Blade"] as const) {
    for (const arm of strikeMountArms(def, weapon)) out.push({ arm, weapon });
  }
  return out;
}

/** Outcome of resolving a strike declaration to a concrete mount. */
export type StrikeMountResolution =
  | { readonly ok: true; readonly arm: ArmLocation; readonly weapon: PhysicalWeaponName }
  | { readonly ok: false; readonly reason: "none" | "ambiguous" };

/**
 * Resolve which mount a strike uses (TW p.146, one strike per turn): an
 * explicit arm selects the weapon mounted there (`"none"` when it mounts
 * nothing); an omitted arm resolves to the sole mount, `"none"` when the
 * unit mounts no physical weapon, `"ambiguous"` when it mounts two or more.
 */
export function resolveStrikeMount(
  def: ResolvedMechDef,
  limb: ArmLocation | undefined,
): StrikeMountResolution {
  if (limb !== undefined) {
    const weapon = strikeWeaponInArm(def, limb);
    return weapon === null ? { ok: false, reason: "none" } : { ok: true, arm: limb, weapon };
  }
  const all = strikeMounts(def);
  if (all.length === 1) return { ok: true, arm: all[0]!.arm, weapon: all[0]!.weapon };
  return { ok: false, reason: all.length === 0 ? "none" : "ambiguous" };
}

// ---------------------------------------------------------------------------
// Damage computation
// ---------------------------------------------------------------------------

/** Compute damage for a physical attack type (TW pp. 145–147).
 *
 * TSM (TW p.143) doubles punch, kick, club, and physical-weapon (hatchet,
 * sword, retractable blade — all "Yes" in the TW p.146 table) damage while
 * active, applied after the actuator halving below.
 */
export function physicalDamage(
  type: PhysicalAttackType,
  attacker: UnitState,
  limb: "leftArm" | "rightArm" | "leftLeg" | "rightLeg" | undefined,
  weapon?: PhysicalWeaponName,
): number {
  const def = mechDefFor(attacker);
  const tons = def.tonnage;
  const tsm = isTsmActive(def, attacker.heat);
  const doubled = (dmg: number): number => (tsm ? dmg * 2 : dmg);

  switch (type) {
    case "punch": {
      let dmg = Math.ceil(tons / PUNCH_DAMAGE_PER_TONS);
      if (limb && (limb === "leftArm" || limb === "rightArm")) {
        const counts = countArmActuators(def, attacker.damage, attacker.critSlotsDestroyed, limb);
        const absent = absentArmActuators(def, limb);
        // Halve for each damaged or absent upper/lower arm actuator, cumulative
        let divisor = 1;
        if (counts.upper > 0 || absent.upper > 0) divisor *= 2;
        if (counts.lower > 0 || absent.lower > 0) divisor *= 2;
        dmg = Math.floor(dmg / divisor);
        return Math.max(1, doubled(dmg));
      }
      return doubled(dmg);
    }
    case "kick": {
      let dmg = Math.ceil(tons / KICK_DAMAGE_PER_TONS);
      if (limb && (limb === "leftLeg" || limb === "rightLeg")) {
        const destroyed = attacker.critSlotsDestroyed;
        const damage = attacker.damage;
        let divisor = 1;
        const structs = destroyedStructuresIn(limb, def, damage, destroyed);
        if (structs.includes("upperLegActuator")) divisor *= 2;
        if (structs.includes("lowerLegActuator")) divisor *= 2;
        dmg = Math.floor(dmg / divisor);
        return Math.max(1, doubled(dmg));
      }
      return doubled(dmg);
    }
    case "club":
      return doubled(Math.ceil(tons / CLUB_DAMAGE_PER_TONS));
    case "strike": {
      const stats = weapon !== undefined ? PHYSICAL_WEAPONS[weapon] : undefined;
      if (stats === undefined) return 0;
      let dmg = Math.ceil(tons / stats.damagePerTons) + stats.damageBonus;
      const arm = resolveStrikeArm(def, weapon, limb);
      if (arm !== null) {
        const counts = countArmActuators(def, attacker.damage, attacker.critSlotsDestroyed, arm);
        // Halve for each damaged upper/lower actuator, cumulative (TW p.146
        // "affected by actuator damage" on the damage axis, as for punches).
        let divisor = 1;
        if (counts.upper > 0) divisor *= 2;
        if (counts.lower > 0) divisor *= 2;
        dmg = Math.floor(dmg / divisor);
        return Math.max(1, doubled(dmg));
      }
      return doubled(dmg);
    }
    // Charge / DFA damage is not TSM-sensitive (TW p.143 lists punch, kick
    // and club only).
    case "charge":
      // TW p.148: hexes moved, not counting the target's hex (which the
      // attacker never enters). An adjacent charge moves 0 hexes and deals
      // 0 damage, but a hit still forces both sides' +2 PSRs.
      return Math.ceil((tons * attacker.hexesMovedThisTurn) / CHARGE_DAMAGE_PER_TONS);
    case "dfa":
      return Math.ceil(tons / PUNCH_DAMAGE_PER_TONS) * DFA_DAMAGE_MULTIPLIER;
  }
}

/** Damage the attacker takes from its own charge / DFA that hit (TW pp.148,
 *  150): a charger takes 1 per 10 tons of the target, a DFA attacker takes
 *  tonnage / 5. Zero for every other attack type. */
export function meleeRecoilDamage(
  type: PhysicalAttackType,
  attacker: UnitState,
  target: UnitState,
): number {
  if (type === "charge") return Math.ceil(mechDefFor(target).tonnage / CHARGE_DAMAGE_PER_TONS);
  if (type === "dfa") return Math.ceil(mechDefFor(attacker).tonnage / DFA_RECOIL_PER_TONS);
  return 0;
}

// ---------------------------------------------------------------------------
// Hit location
// ---------------------------------------------------------------------------

/**
 * Roll hit location for a physical attack (TW pp. 145–147, 150–151).
 * Punch: 1D6 on the Punch Location Table (TW p.145).
 * Kick: 1D6 on the Kick Location Table (TW p.147).
 * Club / strike: 2D6 on the 'Mech Hit Location Table (TW pp.145–146).
 * Every table reads the column matching the attack direction (left side,
 * front/rear, right side). Against a prone target every attack rolls 2D6 on
 * the 'Mech Hit Location Table (TW p.151).
 *
 * `levelDelta` is target level minus attacker level (0 when omitted for
 * backward compatibility). The Different Levels Table auto-swap (TW p.150)
 * and the prone-higher exception (TW p.151) select the effective table via
 * `physicalLocationTable`.
 */
export function physicalHitLocation(
  type: PhysicalAttackType,
  target: UnitState,
  attackDirection: Arc,
  roll: number,
  levelDelta = 0,
): Location {
  switch (physicalLocationTable(type, levelDelta, target.prone)) {
    case "punch":
      return punchHitLocationForArc(attackDirection, roll);
    case "kick":
      return kickHitLocation(roll, attackDirection);
    case "standard":
      return hitLocationForArc(attackDirection, roll);
  }
}

/**
 * Effective hit-location table for a physical attack (TW pp. 150–151).
 * Returns which family to roll: the Punch table (1D6), the Kick table
 * (1D6), or the standard table (2D6).
 *
 * - Prone target: every legal attack (kick at the same level; punch, club,
 *   strike one level higher) uses the 'Mech Hit Location Table — "use the
 *   appropriate column of the 'Mech Hit Location Table" (TW p.151). A prone
 *   target one level lower cannot be attacked (gated in validation).
 * - Same level: default tables (punch→punch, kick→kick, club/strike→standard).
 * - Standing target one level higher: punch/club/strike use the Kick Table.
 * - Standing target one level lower: kick/club/strike use the Punch Table.
 */
export function physicalLocationTable(
  type: PhysicalAttackType,
  levelDelta: number,
  targetProne: boolean,
): "punch" | "kick" | "standard" {
  // Charge uses the standard table; DFA the Punch table, or the standard
  // table's rear column against a prone target (TW pp.148, 150). Neither
  // swaps tables across levels.
  if (type === "charge") return "standard";
  if (type === "dfa") return targetProne ? "standard" : "punch";
  if (targetProne) return "standard";
  if (type === "punch") return levelDelta === 1 ? "kick" : "punch";
  if (type === "kick") return levelDelta === -1 ? "punch" : "kick";
  // club / strike
  if (levelDelta === 1) return "kick";
  if (levelDelta === -1) return "punch";
  return "standard";
}

/** Bipedal 'Mech kick location table (TW p. 147). */
export function kickHitLocation(roll1d6: number, arc: Arc): Location {
  // Kick table: 1-3 and 4-6 rows
  // Left Side: 1-3 = Left Leg, 4-6 = Left Leg
  // Front/Rear: 1-3 = Right Leg, 4-6 = Left Leg
  // Right Side: 1-3 = Right Leg, 4-6 = Right Leg
  const row = roll1d6 <= 3 ? 0 : 1;
  switch (arc) {
    case "leftSide":
      return "leftLeg";
    case "front":
    case "rear":
      return row === 0 ? "rightLeg" : "leftLeg";
    case "rightSide":
      return "rightLeg";
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly attackDirection?: Arc;
}

/**
 * Validate a physical attack declaration (TW pp. 144–151, 171, 175).
 * Checks adjacency, building-hex exclusion, level difference (Different
 * Levels Table, TW p.150), prone-target restrictions (TW p.151), arc,
 * actuator damage, and interaction with weapon fire.
 *
 * `twist` is the attacker's torso twist (TW pp. 105–106, 98–99: the
 * twist governs physical-attack arcs too). Punch and club attacker-side
 * arcs classify against the twisted facing; kick is feet-based
 * (TW pp. 147–149: kick uses the feet's forward arc) and never reads it.
 *
 * `dropped` counts as empty-handed: a declaration that drops the held club
 * first validates as if the hands were already free (so a drop-first club
 * correctly fails the possession gate, while drop-first punch passes it).
 */
export function validatePhysicalAttack(
  battle: BattleState,
  attackerId: string,
  decl: PhysicalAttackDecl,
  twist: Twist = "front",
  dropped = false,
  startDamage?: UnitDamageState,
): ValidationResult {
  const attacker = battle.units[attackerId];
  if (!attacker) return { ok: false, reason: `Unknown unit ${attackerId}` };
  if (isUnitRemoved(attacker)) return { ok: false, reason: `${attackerId} is removed` };
  if (isPilotUnconscious(attacker)) return { ok: false, reason: `${attackerId} is unconscious` };

  const target = battle.units[decl.targetId];
  if (!target) return { ok: false, reason: `Unknown target ${decl.targetId}` };
  if (!isUnitOnBoard(target)) return { ok: false, reason: `Target ${decl.targetId} is removed` };
  // Enemies, or a hull of either team (TO:AR p.184).
  if (!isTargetableBy(attacker, target)) return { ok: false, reason: "Target must be enemy" };

  // A DFA attacker is in the air until the physical phase: no physical attack
  // may target it (TW p.149). A charging or DFA-ing unit is never a charge /
  // DFA target either (TW pp.148-149).
  if (target.meleeCharge?.kind === "dfa") {
    return { ok: false, reason: `${target.id} is performing a DFA and cannot be attacked` };
  }
  if (isMeleeCharge(decl.type) && target.meleeCharge !== null) {
    return { ok: false, reason: `${target.id} is charging and cannot be charged or DFA'd` };
  }

  // Adjacency (TW p. 144)
  if (!isAdjacent(attacker.position, target.position)) {
    return { ok: false, reason: "Physical attack requires adjacency" };
  }

  const attackerCell = cellAt(battle, attacker.position);
  const targetCell = cellAt(battle, target.position);

  // Building-hex exclusion (TW pp. 171, 175): no physical attack from
  // outside a building hex against a target inside one. The same
  // multi-hex building exception (adjacent, same level, same building)
  // is out of implementation scope — multi-hex building identity is not
  // tracked — so every outside->inside attack is rejected.
  if (isBuildingTerrain(targetCell.terrain) && !isBuildingTerrain(attackerCell.terrain)) {
    return {
      ok: false,
      reason: "Cannot make a physical attack from outside against a target inside a building hex",
    };
  }

  // Level difference (TW p. 150)
  // Levels are measured from the bottom of the hex a 'Mech stands on (TW p.150).
  const levelDelta = groundLevel(battle, target.position) - groundLevel(battle, attacker.position);
  if (Math.abs(levelDelta) > 1 && decl.type !== "dfa") {
    return { ok: false, reason: "Level difference too great for physical attack" };
  }

  // Different Levels Table (TW p.150) + prone-target restrictions (TW p.151).
  const levelGate = checkPhysicalLevelGate(decl.type, target.prone, levelDelta);
  if (levelGate !== null) {
    return { ok: false, reason: levelGate };
  }

  // Prone restrictions (TW p. 151)
  if (attacker.prone) {
    // Prone 'Mechs can only punch vehicles or thrash infantry
    // For now, reject all physical attacks while prone
    return { ok: false, reason: "Prone 'Mechs cannot make this physical attack" };
  }

  // Type-specific validation
  switch (decl.type) {
    case "punch":
      return validatePunch(attacker, target, decl, twist ?? null, dropped);
    case "kick":
      return validateKick(attacker, target, decl);
    case "club":
      return validateClub(attacker, target, decl, twist ?? null, dropped);
    case "strike":
      return validateStrike(
        attacker,
        target,
        decl,
        twist ?? null,
        dropped,
        startDamage ?? attacker.damage,
      );
    case "charge":
    case "dfa":
      return validateMeleeCharge(attacker, target, decl.type);
  }
}

/** Charge / DFA (TW pp.148-150): the target stands in the hex directly ahead
 *  (feet orientation, no twist). A charge may not follow a jump and a DFA
 *  must; the attacker never occupies the target hex. */
function validateMeleeCharge(
  attacker: UnitState,
  target: UnitState,
  type: "charge" | "dfa",
): ValidationResult {
  if (type === "charge" && attacker.jumpedThisTurn) {
    return { ok: false, reason: "A charge cannot follow a jump" };
  }
  if (type === "dfa" && !attacker.jumpedThisTurn) {
    return { ok: false, reason: "A DFA requires a jump" };
  }
  const ahead = neighbor(attacker.position, attacker.facing);
  if (ahead.col !== target.position.col || ahead.row !== target.position.row) {
    return { ok: false, reason: "Charge / DFA requires the target in the hex directly ahead" };
  }
  return { ok: true, attackDirection: meleeAttackDirection(attacker, target, type) };
}

/** Attack direction as seen from the target: a DFA reads it from the
 *  attacker's starting hex (TW p.150), everything else from where it stands. */
function meleeAttackDirection(
  attacker: UnitState,
  target: UnitState,
  type: PhysicalAttackType,
): Arc {
  const origin =
    type === "dfa" && attacker.meleeCharge !== null ? attacker.meleeCharge.from : attacker.position;
  const back =
    bearingExact(target.position, origin) ?? bearingExact(target.position, attacker.position)!;
  const dir = classifyArcWithBoundary(target.facing, back);
  return defenderArcChoice(dir.arc, dir.altArc);
}

/**
 * Different Levels Table gate (TW p.150) combined with the prone-target
 * restrictions (TW p.151). Returns null when `type` is legal at this
 * `levelDelta` (target level minus attacker level), else the rejection
 * reason. Same-level attacks defer to the per-type arc/prone checks;
 * prone same-level allows only kicks (DFA and vehicle charges are out of
 * scope), prone one level higher additionally allows punch/club/strike
 * (TW p.151), and prone one level lower allows nothing.
 */
function checkPhysicalLevelGate(
  type: PhysicalAttackType,
  targetProne: boolean,
  levelDelta: number,
): string | null {
  // DFA is legal at any level once its Jumping MP clears the hex (TW p.150
  // note); a charge may not target a prone 'Mech (TW p.151).
  if (type === "dfa") return null;
  if (type === "charge") return targetProne ? "Cannot charge a prone 'Mech" : null;
  if (targetProne) {
    if (levelDelta === 0) {
      return type === "kick" ? null : "Only kicks may target a prone 'Mech on the same level";
    }
    if (levelDelta === 1) {
      return type === "punch" || type === "club" || type === "strike"
        ? null
        : "Only punch, club and physical weapon attacks may target a prone 'Mech one level higher";
    }
    // Prone target one level lower: none (TW p.150).
    return "No physical attack may target a prone 'Mech one level lower";
  }
  if (levelDelta === 0) return null;
  if (levelDelta === 1) {
    // Standing target one level higher: punch and club (+physical weapon);
    // kick is illegal.
    return type === "punch" || type === "club" || type === "strike"
      ? null
      : "This physical attack cannot target a 'Mech one level higher";
  }
  // Standing target one level lower: kick and club (+physical weapon).
  return type === "kick" || type === "club" || type === "strike"
    ? null
    : "This physical attack cannot target a 'Mech one level lower";
}

function validatePunch(
  attacker: UnitState,
  target: UnitState,
  decl: PhysicalAttackDecl,
  twist: Twist,
  dropped: boolean,
): ValidationResult {
  // Carrying a club occupies both hands (TW p.146): no punching until it
  // is dropped first.
  if (!dropped && attacker.club !== null) {
    return { ok: false, reason: "Cannot punch: hands occupied by club (drop it first)" };
  }
  // Target must be in forward or side arc (TW p. 145), read off the
  // twisted torso facing (TW pp. 98–99) via the p.105 template.
  const arc = classifyFiringArc(
    attacker.position,
    target.position,
    effectiveFacingForTwist(attacker.facing, twist),
  );
  if (arc === null) return { ok: false, reason: "Same hex" };
  if (arc === "rear") {
    return { ok: false, reason: "Punch requires target in forward or side arc" };
  }

  // Shoulder must be undamaged (TW p. 145)
  if (decl.limb && (decl.limb === "leftArm" || decl.limb === "rightArm")) {
    const def = mechDefFor(attacker);
    const counts = countArmActuators(def, attacker.damage, attacker.critSlotsDestroyed, decl.limb);
    if (counts.shoulder > 0) {
      return { ok: false, reason: `Cannot punch: ${decl.limb} shoulder destroyed` };
    }
  }

  // A target in the right or left arc may only be punched by the
  // corresponding arm (TW p. 145). `limb` names the punching arm; a
  // missing limb carries no arm information and skips this check (game
  // flow normalizes it to the right arm before validation).
  if (arc === "leftSide" && decl.limb === "rightArm") {
    return { ok: false, reason: "A target in the left arc may only be punched by the left arm" };
  }
  if (arc === "rightSide" && decl.limb === "leftArm") {
    return { ok: false, reason: "A target in the right arc may only be punched by the right arm" };
  }

  // Compute attack direction for hit location
  const back = bearingExact(target.position, attacker.position)!;
  const dir = classifyArcWithBoundary(target.facing, back);
  const attackDirection = defenderArcChoice(dir.arc, dir.altArc);

  return { ok: true, attackDirection };
}

function validateKick(
  attacker: UnitState,
  target: UnitState,
  _decl: PhysicalAttackDecl,
): ValidationResult {
  // Target must be in one of three forward-arc hexes (TW p. 147), read off
  // the p.105 template. Adjacent `front` is exactly those three hexes, so
  // side and rear arcs are both rejected.
  const kickArc = classifyFiringArc(attacker.position, target.position, attacker.facing);
  if (kickArc === null) return { ok: false, reason: "Same hex" };
  if (kickArc !== "front") {
    return { ok: false, reason: "Kick requires target in forward arc" };
  }

  // Both hips must be undamaged (TW p. 147)
  const def = mechDefFor(attacker);
  const damage = attacker.damage;
  const destroyed = attacker.critSlotsDestroyed;
  const leftHip = countDestroyedStructure(def, damage, destroyed, "leftLeg", "hip");
  const rightHip = countDestroyedStructure(def, damage, destroyed, "rightLeg", "hip");
  if (leftHip > 0 || rightHip > 0) {
    return { ok: false, reason: "Cannot kick: hip destroyed" };
  }

  // Compute attack direction
  const back = bearingExact(target.position, attacker.position)!;
  const dir = classifyArcWithBoundary(target.facing, back);
  const attackDirection = defenderArcChoice(dir.arc, dir.altArc);

  return { ok: true, attackDirection };
}

function validateClub(
  attacker: UnitState,
  target: UnitState,
  _decl: PhysicalAttackDecl,
  twist: Twist,
  dropped: boolean,
): ValidationResult {
  // A club attack requires a held club (TW p. 145). A declaration that
  // drops first counts as empty-handed, so it always fails here.
  if (dropped || attacker.club === null) {
    return { ok: false, reason: "Cannot club: unit holds no club (pick one up first)" };
  }
  // Target must be in forward arc (TW p. 145), read off the twisted torso
  // facing (TW pp. 98–99) via the p.105 template.
  const clubArc = classifyFiringArc(
    attacker.position,
    target.position,
    effectiveFacingForTwist(attacker.facing, twist),
  );
  if (clubArc === null) return { ok: false, reason: "Same hex" };
  if (clubArc !== "front") {
    return { ok: false, reason: "Club requires target in forward arc" };
  }

  // Requires both shoulders undamaged and two undamaged hand actuators
  const def = mechDefFor(attacker);
  const damage = attacker.damage;
  const destroyed = attacker.critSlotsDestroyed;
  for (const arm of ["leftArm", "rightArm"] as const) {
    const counts = countArmActuators(def, damage, destroyed, arm);
    if (counts.shoulder > 0) {
      return { ok: false, reason: `Cannot club: ${arm} shoulder destroyed` };
    }
    if (counts.hand > 0) {
      return { ok: false, reason: `Cannot club: ${arm} hand actuator destroyed` };
    }
    if (absentArmActuators(def, arm).hand > 0) {
      return { ok: false, reason: `Cannot club: ${arm} has no hand actuator` };
    }
  }
  if (!clubHandsFunctional(def, damage, destroyed)) {
    return { ok: false, reason: "Cannot club: an arm is lost" };
  }

  // Compute attack direction
  const back = bearingExact(target.position, attacker.position)!;
  const dir = classifyArcWithBoundary(target.facing, back);
  const attackDirection = defenderArcChoice(dir.arc, dir.altArc);

  return { ok: true, attackDirection };
}

function validateStrike(
  attacker: UnitState,
  target: UnitState,
  decl: PhysicalAttackDecl,
  twist: Twist,
  dropped: boolean,
  startDamage: UnitDamageState,
): ValidationResult {
  // A strike needs its mounting hand free (TW p.146): no striking while
  // carrying a club.
  if (!dropped && attacker.club !== null) {
    return { ok: false, reason: "Cannot strike: hands occupied by club (drop it first)" };
  }
  const weapon = decl.weapon;
  if (weapon === undefined || !isPhysicalWeaponName(weapon)) {
    return { ok: false, reason: "Strike requires a physical weapon (hatchet, sword, blade)" };
  }
  // The catalog entry must exist (Hatchet / Sword / Retractable Blade ship
  // as EQUIPMENT with physicalWeapon: true).
  try {
    weaponDefFor({ weapon });
  } catch {
    return { ok: false, reason: `Unknown physical weapon: ${weapon}` };
  }
  const def = mechDefFor(attacker);
  const arm = resolveStrikeArm(def, weapon, decl.limb);
  if (arm === null) {
    return { ok: false, reason: `${attacker.id} does not mount a ${weapon.toLowerCase()}` };
  }

  if (!canFireFromLocation(startDamage, arm)) {
    return { ok: false, reason: `Cannot strike: ${arm} destroyed` };
  }
  // A critical hit on any slot of the equipment destroys it (TW p.146).
  // Checked after the arm: a catastrophic wipe flags every slot there.
  const weaponIndex = strikeWeaponIndex(def, weapon, arm);
  if (weaponIndex !== null && isWeaponCritted(def, attacker.critSlotsDestroyed, weaponIndex)) {
    return { ok: false, reason: `${weapon} in ${arm} is destroyed` };
  }

  // Shoulder must be undamaged in the striking arm (as for a punch).
  const counts = countArmActuators(def, attacker.damage, attacker.critSlotsDestroyed, arm);
  if (counts.shoulder > 0) {
    return { ok: false, reason: `Cannot strike: ${arm} shoulder destroyed` };
  }

  // Arm arc (TW p.146): forward arc or the side arc matching the mounting
  // arm, read off the twisted torso facing like punch/club (TW pp. 98–99)
  // via the p.105 template.
  const strikeArc = classifyFiringArc(
    attacker.position,
    target.position,
    effectiveFacingForTwist(attacker.facing, twist),
  );
  if (strikeArc === null) return { ok: false, reason: "Same hex" };
  const side: Arc = arm === "leftArm" ? "leftSide" : "rightSide";
  if (strikeArc !== "front" && strikeArc !== side) {
    return { ok: false, reason: "Strike requires target in forward or mounting-arm side arc" };
  }

  // Compute attack direction for hit location
  const back = bearingExact(target.position, attacker.position)!;
  const dir = classifyArcWithBoundary(target.facing, back);
  const attackDirection = defenderArcChoice(dir.arc, dir.altArc);

  return { ok: true, attackDirection };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single physical attack (TW pp. 144–151).
 * Pure function: does not mutate state. Returns the resolution with
 * damage groups.
 *
 * Kick PSRs are NOT rolled here: the kicked target's check on a hit and the
 * missed-kick attacker's check defer to the end-of-phase sweep (TW pp. 59,
 * 147) and come back as `kickTargetPsrPending` / `kickAttackerPsrPending`
 * for the caller to roll after all physical damage lands.
 */
export function resolvePhysicalAttack(
  battle: BattleState,
  attackerId: string,
  decl: PhysicalAttackDecl,
  rng: Rng,
): PhysicalResolution {
  const attacker = battle.units[attackerId]!;
  const target = battle.units[decl.targetId]!;
  const _def = mechDefFor(attacker);

  const notes: string[] = [];

  // Compute to-hit.
  const mods = computePhysicalToHit(battle, attacker, target, decl.type, decl.limb, decl.weapon);
  const total = physicalToHitTotal(mods);

  // Auto-hit / auto-miss
  const autoHit = total <= PHYSICAL_MIN_TOHIT;
  const autoMiss = total > PHYSICAL_MAX_TOHIT;

  // Roll to-hit
  const roll = autoHit || autoMiss ? null : roll2D6(rng);
  const hit = autoHit || (roll !== null && roll >= total);

  // Compute attack direction for hit location
  const attackDirection = meleeAttackDirection(attacker, target, decl.type);

  // Compute damage
  const dmg = physicalDamage(decl.type, attacker, decl.limb, decl.weapon);
  const damageToTarget: DamageGroup[] = [];
  const damageToAttacker: DamageGroup[] = [];

  let throughArmorCrit = false;
  if (isMeleeCharge(decl.type)) {
    // Charge / DFA (TW pp.148, 150): damage in 5-point groups, each group
    // located separately; the attacker takes recoil damage on a hit.
    if (hit) {
      const levelDelta =
        groundLevel(battle, target.position) - groundLevel(battle, attacker.position);
      const table = physicalLocationTable(decl.type, levelDelta, target.prone);
      // A DFA against a prone 'Mech reads the Rear column (TW p.150).
      const arc: Arc = decl.type === "dfa" && target.prone ? "rear" : attackDirection;
      for (const amount of fallingDamageGroups(dmg)) {
        const locRoll = table === "standard" ? roll2D6(rng) : rollD6(rng);
        damageToTarget.push({
          location: physicalHitLocation(decl.type, target, arc, locRoll, levelDelta),
          damage: amount,
          arc,
          ...(table === "standard" && locRoll === 2 ? { tac: true } : {}),
        });
      }
      const recoil = meleeRecoilDamage(decl.type, attacker, target);
      for (const amount of fallingDamageGroups(recoil)) {
        // Charge recoil: standard table, front column. DFA recoil: Kick
        // table, front column (TW p.150).
        damageToAttacker.push({
          location:
            decl.type === "charge"
              ? hitLocationForArc("front", roll2D6(rng))
              : kickHitLocation(rollD6(rng), "front"),
          damage: amount,
        });
      }
    }
  } else if (hit && dmg > 0) {
    // Different-levels table swap (TW p.150) and prone-higher exception
    // (TW p.151): the effective table selects the dice (punch/kick 1D6,
    // standard 2D6). No +4 election modifier on auto-swaps (TW p.146).
    const levelDelta =
      groundLevel(battle, target.position) - groundLevel(battle, attacker.position);
    const table = physicalLocationTable(decl.type, levelDelta, target.prone);
    const locRoll = table === "standard" ? roll2D6(rng) : rollD6(rng);
    // Through-armor critical on a 2 rolled on the 2D6 'Mech Hit Location
    // Table only (TW p.121 footnote, p.124); a 1D6 Punch/Kick roll of 2 is
    // just a location.
    throughArmorCrit = table === "standard" && locRoll === 2;
    const location = physicalHitLocation(decl.type, target, attackDirection, locRoll, levelDelta);
    damageToTarget.push({ location, damage: dmg });
  }

  let kickTargetPsrPending = false;
  let kickAttackerPsrPending = false;

  if (decl.type === "kick") {
    // Deferred to the end-of-phase sweep (TW pp. 59,147): on a hit the
    // kicked target rolls (unless prone, which ignores fall-avoidance PSRs
    // per TW p.151); on a miss only the attacker rolls. A missed kick never
    // forces a PSR on the target. No dice are drawn here so RNG order
    // matches the deferred rolls.
    kickTargetPsrPending = hit && !target.prone;
    kickAttackerPsrPending = !hit && !autoMiss;
  }

  const melee = isMeleeCharge(decl.type);
  return {
    type: decl.type,
    attackerId,
    targetId: decl.targetId,
    ...(decl.type === "strike" && decl.weapon !== undefined ? { weapon: decl.weapon } : {}),
    ...(melee && hit
      ? {
          targetPsrMod: CHARGE_PSR_MOD,
          attackerPsrMod: decl.type === "dfa" ? DFA_ATTACKER_PSR_MOD : CHARGE_PSR_MOD,
        }
      : {}),
    ...(decl.type === "dfa" && !hit ? { dfaMissFall: true } : {}),
    toHit: total,
    roll,
    hit,
    autoHit,
    autoMiss,
    damageToTarget,
    damageToAttacker,
    applications: [],
    attackerApplications: [],
    crits: [],
    notes,
    throughArmorCrit,
    ...(kickTargetPsrPending ? { kickTargetPsrPending } : {}),
    ...(kickAttackerPsrPending ? { kickAttackerPsrPending } : {}),
  };
}

// ---------------------------------------------------------------------------
// Damage application helper
// ---------------------------------------------------------------------------

/**
 * Apply physical attack damage to a target's damage state.
 * Returns the damage application result.
 */
export function applyPhysicalDamage(
  damage: UnitDamageState,
  group: DamageGroup,
  arc: Arc,
): DamageApplication {
  return applyDamage(damage, group.location, group.damage, arc);
}
