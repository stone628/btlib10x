/**
 * Physical attack rules (BattleTech Total Warfare, pp. 144–153).
 *
 * Implements punch, kick, push, and club attacks. Charge and DFA are
 * deferred to a future phase. Club acquisition (blown-off limbs, trees)
 * is also deferred — the club attack itself is implemented but requires
 * the attacker to have a club (tracked via `hasClub` on UnitState).
 *
 * Physical attacks are declared in the weapon attack phase and resolved
 * after all weapon attacks (TW p. 37 phase order within the unified phase).
 */

import { roll2D6, rollD6 } from "../core/dice";
import { bearingExact, isAdjacent, neighbor } from "../core/hex";
import { cellAt } from "../core/terrain";
import type { ArmLocation, HexCoord, Location, Rng } from "../core/types";
import { isArm } from "../core/types";
import { mechDefFor } from "../data/index";
import type { ResolvedMechDef } from "../data/mech.schema";
import { weaponDefFor } from "../data/weapon.schema";
import { countArmActuators } from "./actuators";
import {
  type Arc,
  classifyArcWithBoundary,
  classifyFiringArc,
  defenderArcChoice,
  effectiveFacingForTwist,
} from "./arcs";
import { destroyedStructures } from "./critical";
import {
  applyDamage,
  canFireFromLocation,
  type DamageApplication,
  type UnitDamageState,
} from "./damage";
import type { BattleState, UnitState } from "./game";
import { isUnitRemoved } from "./game";
import { isTsmActive } from "./heat";
import { hitLocationForArc, punchHitLocation } from "./hitlocation";
import { preexistingDamageModifier, rollPilotingCheck } from "./piloting";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PhysicalAttackType = "punch" | "kick" | "push" | "club" | "strike";

/** Melee equipment usable through a strike (TW p.146 subset). */
export type PhysicalWeaponName = "Hatchet" | "Sword" | "Retractable Blade";

export interface PhysicalAttackDecl {
  readonly type: PhysicalAttackType;
  readonly targetId: string;
  /** For punch: which arm. For kick: which leg. For strike: mounting arm. */
  readonly limb?: "leftArm" | "rightArm" | "leftLeg" | "rightLeg";
  /** For strike: which mounted physical weapon is used. */
  readonly weapon?: PhysicalWeaponName;
}

export interface PhysicalModifiers {
  /** Base to-hit: piloting skill. */
  readonly base: number;
  /** Attack-type modifier (punch +0, kick −2, push −1, club −1, strike per weapon). */
  readonly attackMod: number;
  /** Attacker movement modifier (same as weapon attacks). */
  readonly attackerMoveMod: number;
  /** Target movement modifier. */
  readonly targetMoveMod: number;
  /** Terrain modifier on target. */
  readonly terrainMod: number;
  /** Actuator damage modifier on attacker. */
  readonly actuatorMod: number;
  /** Prone attacker modifier. */
  readonly proneMod: number;
  /** Total to-hit number. */
  readonly total: number;
}

export interface DamageGroup {
  readonly location: Location;
  readonly damage: number;
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
  readonly targetDisplacedTo: HexCoord | null;
  readonly attackerDisplacedTo: HexCoord | null;
  readonly targetPsr: { target: number; roll: number | null; success: boolean } | null;
  readonly attackerPsr: { target: number; roll: number | null; success: boolean } | null;
  readonly attackerFalls: boolean;
  readonly targetFalls: boolean;
  readonly notes: string[];
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

/** Push: −1 to-hit, 0 damage. */
export const PUSH_ATTACK_MOD = -1;

/** Club: −1 to-hit, 1 damage per 5 tons (round up). */
export const CLUB_ATTACK_MOD = -1;
export const CLUB_DAMAGE_PER_TONS = 5;

/** Physical weapons (TW p.146): per-weapon to-hit modifier and damage
 *  formula `ceil(tonnage / damagePerTons) + damageBonus`. All three use the
 *  standard hit-location table on the Arm arc (forward or mounting-arm side)
 *  and are TSM-sensitive (doubled while TSM is active, TW p.143/p.146). The
 *  optional Punch/Kick table election (+4) and the different-levels
 *  auto-swap (TW p.150) are deferred, matching punch/kick/club in this
 *  subset. */
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
 * damage, terrain) except heat and sensor modifiers.
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
  const attackMod = attackTypeModifier(type, weapon);

  // Attacker movement modifier (same as weapon attacks)
  const attackerMoveMod = physicalAttackerMoveMod(attacker);

  // Target movement modifier
  const targetMoveMod = physicalTargetMoveMod(target);

  // Terrain modifier on target hex
  const terrainMod = physicalTerrainMod(battle, target);

  // Actuator damage modifier
  const actuatorMod = physicalActuatorMod(attacker, type, limb, weapon);

  // Prone attacker modifier
  const proneMod = attacker.prone ? 2 : 0;

  const total =
    base + attackMod + attackerMoveMod + targetMoveMod + terrainMod + actuatorMod + proneMod;

  return {
    base,
    attackMod,
    attackerMoveMod,
    targetMoveMod,
    terrainMod,
    actuatorMod,
    proneMod,
    total,
  };
}

function attackTypeModifier(type: PhysicalAttackType, weapon?: PhysicalWeaponName): number {
  switch (type) {
    case "punch":
      return PUNCH_ATTACK_MOD;
    case "kick":
      return KICK_ATTACK_MOD;
    case "push":
      return PUSH_ATTACK_MOD;
    case "club":
      return CLUB_ATTACK_MOD;
    case "strike":
      return weapon !== undefined ? (PHYSICAL_WEAPONS[weapon]?.toHitMod ?? 0) : 0;
  }
}

/**
 * Attacker movement modifier for physical attacks (TW p. 113).
 * Same as weapon attacks: standStill 0, walk +1, run +2, jump +3, prone +2.
 */
function physicalAttackerMoveMod(attacker: UnitState): number {
  if (attacker.prone) return 2;
  switch (attacker.moveMode) {
    case "standStill":
      return 0;
    case "walk":
      return 1;
    case "run":
      return 2;
    case "jump":
      return 3;
    default:
      return 0;
  }
}

/**
 * Target movement modifier for physical attacks (TW p. 109).
 * Same band as weapon attacks.
 */
function physicalTargetMoveMod(target: UnitState): number {
  if (target.prone) return -2;
  const hexes = target.movesThisTurn.length;
  if (hexes === 0) return 0;
  if (hexes <= 2) return 0;
  if (hexes <= 4) return 1;
  if (hexes <= 6) return 2;
  if (hexes <= 9) return 3;
  return 4;
}

/**
 * Terrain modifier for physical attacks (TW p. 112).
 * Light woods +1, heavy woods +2, rubble +1, rough +1.
 */
function physicalTerrainMod(battle: BattleState, target: UnitState): number {
  const cell = cellAt(battle, target.position);
  switch (cell.terrain) {
    case "lightWoods":
      return 1;
    case "heavyWoods":
      return 2;
    case "rubble":
      return 1;
    case "rough":
      return 1;
    default:
      return 0;
  }
}

/**
 * Actuator damage modifier for physical attacks (TW pp. 145–147).
 * Punch: +2 per damaged upper/lower arm actuator, +1 if no hand.
 * Kick: +1 per damaged upper/lower leg actuator.
 * Push: +2 per damaged shoulder.
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
      let mod = 0;
      mod += (counts.upper + counts.lower) * 2;
      if (counts.hand > 0) mod += 1;
      return mod;
    }
    case "kick": {
      if (!limb) return 0;
      if (limb !== "leftLeg" && limb !== "rightLeg") return 0;
      // Leg actuators: upperLegActuator, lowerLegActuator, footActuator
      let mod = 0;
      const structs = destroyedStructuresIn(limb, def, damage, destroyed);
      if (structs.includes("upperLegActuator")) mod += 1;
      if (structs.includes("lowerLegActuator")) mod += 1;
      if (structs.includes("footActuator")) mod += 1;
      return mod;
    }
    case "push": {
      // +2 per damaged shoulder
      let mod = 0;
      const leftShoulder = countDestroyedStructure(def, damage, destroyed, "leftArm", "shoulder");
      const rightShoulder = countDestroyedStructure(def, damage, destroyed, "rightArm", "shoulder");
      mod += (leftShoulder + rightShoulder) * 2;
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
  }
}

// Helper functions for actuator counting
function destroyedStructuresIn(
  location: Location,
  def: ResolvedMechDef,
  damage: UnitDamageState,
  destroyed: Readonly<Record<Location, readonly boolean[]>>,
): string[] {
  return destroyedStructures(def, damage, destroyed, location);
}

function countDestroyedStructure(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  destroyed: Readonly<Record<Location, readonly boolean[]>>,
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
 * active, applied after the actuator halving below. Push deals no damage.
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
        // Halve for each damaged upper/lower arm actuator, cumulative
        let divisor = 1;
        if (counts.upper > 0) divisor *= 2;
        if (counts.lower > 0) divisor *= 2;
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
    case "push":
      return 0;
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
  }
}

// ---------------------------------------------------------------------------
// Hit location
// ---------------------------------------------------------------------------

/**
 * Roll hit location for a physical attack (TW pp. 145, 147).
 * Punch: 1D6 on Punch Location Table.
 * Kick: 1D6 on Kick Location Table.
 * Club: 1D6 on Standard Hit Location Table.
 * Strike: 2D6 on Standard Hit Location Table (TW p.146).
 * Push: no damage, no location roll.
 */
export function physicalHitLocation(
  type: PhysicalAttackType,
  _target: UnitState,
  attackDirection: Arc,
  roll: number,
): Location {
  switch (type) {
    case "punch":
      return punchHitLocation(roll);
    case "kick":
      return kickHitLocation(roll, attackDirection);
    case "club":
    case "strike":
      return hitLocationForArc(attackDirection, roll);
    case "push":
      return "centerTorso"; // unused
  }
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
 * Validate a physical attack declaration (TW pp. 144–151).
 * Checks adjacency, arc, level difference, actuator damage, and
 * interaction with weapon fire.
 *
 * `twist` is the attacker's torso twist (TW pp. 105–106, 98–99: the
 * twist governs physical-attack arcs too). Punch and club attacker-side
 * arcs classify against the twisted facing; kick and push are feet-based
 * (TW pp. 147–149: kick uses the feet's forward arc, push/charge ignore
 * the twist) and never read it.
 */
export function validatePhysicalAttack(
  battle: BattleState,
  attackerId: string,
  decl: PhysicalAttackDecl,
  twist?: Arc | null,
): ValidationResult {
  const attacker = battle.units[attackerId];
  if (!attacker) return { ok: false, reason: `Unknown unit ${attackerId}` };
  if (isUnitRemoved(attacker)) return { ok: false, reason: `${attackerId} is removed` };
  if (attacker.unconscious) return { ok: false, reason: `${attackerId} is unconscious` };

  const target = battle.units[decl.targetId];
  if (!target) return { ok: false, reason: `Unknown target ${decl.targetId}` };
  if (isUnitRemoved(target)) return { ok: false, reason: `Target ${decl.targetId} is removed` };
  if (target.team === attacker.team) return { ok: false, reason: "Target must be enemy" };

  // Adjacency (TW p. 144)
  if (!isAdjacent(attacker.position, target.position)) {
    return { ok: false, reason: "Physical attack requires adjacency" };
  }

  // Level difference (TW p. 150)
  const attackerCell = cellAt(battle, attacker.position);
  const targetCell = cellAt(battle, target.position);
  const levelDiff = Math.abs(attackerCell.level - targetCell.level);
  if (levelDiff > 1) {
    return { ok: false, reason: "Level difference too great for physical attack" };
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
      return validatePunch(attacker, target, decl, twist ?? null);
    case "kick":
      return validateKick(attacker, target, decl);
    case "push":
      return validatePush(attacker, target, decl);
    case "club":
      return validateClub(attacker, target, decl, twist ?? null);
    case "strike":
      return validateStrike(attacker, target, decl, twist ?? null);
  }
}

function validatePunch(
  attacker: UnitState,
  target: UnitState,
  decl: PhysicalAttackDecl,
  twist: Arc | null,
): ValidationResult {
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
  // the p.105 template.
  const kickArc = classifyFiringArc(attacker.position, target.position, attacker.facing);
  if (kickArc === null) return { ok: false, reason: "Same hex" };
  if (kickArc === "rear") {
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

function validatePush(
  attacker: UnitState,
  target: UnitState,
  _decl: PhysicalAttackDecl,
): ValidationResult {
  // Target must be in hex directly in front (TW p. 147)
  const frontHex = neighbor(attacker.position, attacker.facing);
  if (frontHex.col !== target.position.col || frontHex.row !== target.position.row) {
    return { ok: false, reason: "Push requires target in hex directly ahead" };
  }

  // Target must be standing 'Mech not charging or performing DFA
  if (target.prone) {
    return { ok: false, reason: "Cannot push a prone 'Mech" };
  }

  // Compute attack direction (for PSR purposes)
  const back = bearingExact(target.position, attacker.position)!;
  const dir = classifyArcWithBoundary(target.facing, back);
  const attackDirection = defenderArcChoice(dir.arc, dir.altArc);

  return { ok: true, attackDirection };
}

function validateClub(
  attacker: UnitState,
  target: UnitState,
  _decl: PhysicalAttackDecl,
  twist: Arc | null,
): ValidationResult {
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
  twist: Arc | null,
): ValidationResult {
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

  // A critical hit on any slot of the equipment destroys it (TW p.146).
  const weaponIndex = strikeWeaponIndex(def, weapon, arm);
  if (weaponIndex !== null && attacker.destroyedWeapons.includes(weaponIndex)) {
    return { ok: false, reason: `${weapon} in ${arm} is destroyed` };
  }
  if (!canFireFromLocation(attacker.baseDamage, arm)) {
    return { ok: false, reason: `Cannot strike: ${arm} destroyed` };
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
 * damage groups, displacement, and PSR results.
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

  // Compute to-hit
  const mods = computePhysicalToHit(battle, attacker, target, decl.type, decl.limb, decl.weapon);

  // Auto-hit / auto-miss
  const autoHit = mods.total <= PHYSICAL_MIN_TOHIT;
  const autoMiss = mods.total > PHYSICAL_MAX_TOHIT;

  // Roll to-hit
  const roll = autoHit || autoMiss ? null : roll2D6(rng);
  const hit = autoHit || (roll !== null && roll >= mods.total);

  // Compute attack direction for hit location
  const back = bearingExact(target.position, attacker.position)!;
  const dir = classifyArcWithBoundary(target.facing, back);
  const attackDirection = defenderArcChoice(dir.arc, dir.altArc);

  // Compute damage
  const dmg = physicalDamage(decl.type, attacker, decl.limb, decl.weapon);
  const damageToTarget: DamageGroup[] = [];
  const damageToAttacker: DamageGroup[] = [];

  if (hit && dmg > 0) {
    // Roll hit location
    const locRoll = decl.type === "punch" || decl.type === "kick" ? rollD6(rng) : roll2D6(rng);
    const location = physicalHitLocation(decl.type, target, attackDirection, locRoll);
    damageToTarget.push({ location, damage: dmg });
  }

  // Displacement and PSRs. Preexisting damage (leg/hip/gyro, TW p.60)
  // applies to every PSR, evaluated against each side's own damage state.
  let targetDisplacedTo: HexCoord | null = null;
  let attackerDisplacedTo: HexCoord | null = null;
  let targetPsr: { target: number; roll: number | null; success: boolean } | null = null;
  let attackerPsr: { target: number; roll: number | null; success: boolean } | null = null;
  let attackerFalls = false;
  let targetFalls = false;

  /**
   * Roll one physical-attack PSR for `unit`, applying its own preexisting
   * damage (TW p.60). Pure dice wrapper so push/kick call sites stay flat.
   */
  function rollPhysicalPsr(
    rollRng: Rng,
    unit: UnitState,
  ): { target: number; roll: number | null; success: boolean } {
    const def = mechDefFor(unit);
    const pre = preexistingDamageModifier(def, unit.damage, unit.critSlotsDestroyed);
    return rollPilotingCheck(rollRng, unit.piloting, pre.modifier);
  }

  if (decl.type === "push") {
    if (hit) {
      // Target moves one hex in push direction, attacker advances (TW p. 147)
      const pushDir = attacker.facing;
      const targetNewHex = neighbor(target.position, pushDir);
      targetDisplacedTo = targetNewHex;
      attackerDisplacedTo = { ...target.position };

      // Both make PSR (TW p. 147)
      const targetPsrResult = rollPhysicalPsr(rng, target);
      targetPsr = targetPsrResult;
      if (!targetPsrResult.success) targetFalls = true;

      const attackerPsrResult = rollPhysicalPsr(rng, attacker);
      attackerPsr = attackerPsrResult;
      if (!attackerPsrResult.success) attackerFalls = true;
    }
  }

  if (decl.type === "kick") {
    // Target must make PSR regardless of hit/miss (TW p. 147), unless it
    // is prone: prone 'Mechs ignore PSRs to avoid falls (TW p.151).
    if (!target.prone) {
      const targetPsrResult = rollPhysicalPsr(rng, target);
      targetPsr = targetPsrResult;
      if (!targetPsrResult.success) targetFalls = true;
    }

    // Attacker makes PSR on miss (TW p. 147)
    if (!hit) {
      const attackerPsrResult = rollPhysicalPsr(rng, attacker);
      attackerPsr = attackerPsrResult;
      if (!attackerPsrResult.success) attackerFalls = true;
    }
  }

  return {
    type: decl.type,
    attackerId,
    targetId: decl.targetId,
    ...(decl.type === "strike" && decl.weapon !== undefined ? { weapon: decl.weapon } : {}),
    toHit: mods.total,
    roll,
    hit,
    autoHit,
    autoMiss,
    damageToTarget,
    damageToAttacker,
    targetDisplacedTo,
    attackerDisplacedTo,
    targetPsr,
    attackerPsr,
    attackerFalls,
    targetFalls,
    notes,
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
