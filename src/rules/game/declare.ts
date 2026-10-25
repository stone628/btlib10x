import { hexDistance } from "../../core/hex";
import { cellAt } from "../../core/terrain";
import { isArm, isLeg, type Rng } from "../../core/types";
import { mechDefFor } from "../../data/index";
import type { ResolvedMechDef } from "../../data/mech.schema";
import { isFireableWeapon, weaponDefFor } from "../../data/weapon.schema";
import { armWeaponToHitModifier, targetingComputerModifier } from "../actuators";
import { binsForWeaponName, consumeAmmoForName, pooledShotsLeft } from "../ammo";
import {
  type Arc,
  classifyFiringArc,
  effectiveFacingForTwist,
  mountArcLocation,
  mountCanFireIntoArc,
  type SecondaryTargetMod,
  secondaryTargetModifier,
  twistDelta,
} from "../arcs";
import { countDestroyedSensor, isWeaponCritted } from "../critical";
import { canFireMount, isUnitLocationDestroyed } from "../damage";
import { toHitHeatModifier } from "../heat";
import {
  losBlockedByBuilding,
  losBlockedByElevation,
  losClear,
  losWoodsPointsBetween,
} from "../los";
import {
  isMeleeCharge,
  type PhysicalAttackDecl,
  type PhysicalWeaponName,
  resolveStrikeArm,
  validatePhysicalAttack,
} from "../physical";
import { isPilotUnconscious } from "../pilot";
import { sensorAttackModifier, sensorsBlind } from "../piloting";
import { computeToHit, toHitTotal } from "../tohit";
import { applyClubDrop } from "./clubs";
import { isImmobile } from "./condition";
import {
  attackDirectionFor,
  losEnds,
  losSideFor,
  partialCoverMod,
  shooterInPartialCover,
} from "./geometry";
import { isShutdown, isTargetableBy, isUnitOnBoard, isUnitRemoved, requireUnit } from "./queries";
import { requireCurrentActor } from "./turnOrder";
import type {
  BattleState,
  DeclareAttacksOptions,
  GameEvent,
  ValidatedAttackVolley,
  ValidatedTargetVolley,
  WeaponAttackDecl,
} from "./types";

/** Normalize physical attack limbs: a limbless punch defaults to the right
 *  arm, a limbless kick to the right leg (TW lets the attacker pick; the
 *  default keeps single-command declarations deterministic). A limbless
 *  strike defaults to its mounting arm (right when both mount it).
 *  A club carries no limb. */
export function normalizePhysicalDecls(
  def: ResolvedMechDef,
  decls: readonly PhysicalAttackDecl[],
): PhysicalAttackDecl[] {
  return decls.map((d) => {
    if (d.type === "punch" && d.limb === undefined) return { ...d, limb: "rightArm" as const };
    if (d.type === "kick" && d.limb === undefined) return { ...d, limb: "rightLeg" as const };
    if (d.type === "strike" && d.limb === undefined && d.weapon !== undefined) {
      const arm = resolveStrikeArm(def, d.weapon, undefined);
      if (arm !== null) return { ...d, limb: arm };
    }
    return d;
  });
}

/**
 * Enforce the one-type-per-turn rule (TW p. 144) with the two-arm punch
 * exception (one punch per arm, separate rolls). Strikes are physical
 * weapon attacks: at most one per turn even with two mounted (TW p.144).
 * Throws on violation.
 */
export function checkPhysicalSetShape(
  unitId: string,
  normalized: readonly PhysicalAttackDecl[],
): void {
  if (normalized.some((d) => isMeleeCharge(d.type))) {
    throw new Error(`${unitId}: charge and DFA are declared by movement, not in the attack phase`);
  }
  const types = new Set(normalized.map((d) => d.type));
  if (types.size > 1)
    throw new Error(`${unitId} may make only one type of physical attack per turn`);
  const punches = normalized.filter((d) => d.type === "punch");
  if (punches.length > 2) throw new Error(`${unitId} may punch with at most two arms`);
  const punchLimbs = punches.map((d) => d.limb);
  if (new Set(punchLimbs).size !== punchLimbs.length)
    throw new Error(`${unitId} may punch with each arm only once per turn`);
  const strikes = normalized.filter((d) => d.type === "strike");
  if (strikes.length > 1)
    throw new Error(`${unitId} may make only one physical weapon attack per turn`);
  // TW p. 144: one physical attack per turn; two punches (one per arm) are
  // the only exception.
  if (punches.length === 0 && normalized.length > 1)
    throw new Error(`${unitId} may make only one ${normalized[0]!.type} per turn`);
}

/** Validation core shared by `validateAttacks` and `declareAttacks`.
 *  Runs every gate `declareAttacks` enforces: unit status (removed /
 *  shutdown / unconscious), sensors, prone arm-prop, and per-decl checks
 *  (weapon bounds, dup, jammed / destroyed, location, rapid-fire,
 *  multiple-target primary / secondary modifier, target validity, arc, LOS,
 *  range, to-hit, ammo), plus the
 *  physical set (one-type / two-punch shape, per-decl legality with the
 *  twist-aware arcs of `validatePhysicalAttack`, and the weapon/physical
 *  interaction backstop below). On success returns the primary target, each
 *  weapon's firing arc, and per-target attack direction, distance, range
 *  bracket, and secondary-target modifier (empty when no weapon attacks
 *  were passed). Does NOT mutate state, consume RNG, or
 *  emit events. Phase and actor-queue are checked by `declareAttacks`,
 *  not here. */
export function validateAttacksImpl(
  state: BattleState,
  unitId: string,
  weaponDecls: readonly WeaponAttackDecl[],
  physicalDecls: readonly PhysicalAttackDecl[] = [],
  options: DeclareAttacksOptions = {},
): ValidatedAttackVolley {
  const unit = requireUnit(state, unitId);
  const wantWeapons = weaponDecls.length > 0;
  const wantPhysical = physicalDecls.length > 0;
  if (!wantWeapons && !wantPhysical)
    throw new Error("declareAttacks requires at least one declaration");
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is destroyed`);
  if (isShutdown(unit))
    throw new Error(
      wantWeapons
        ? `${unitId} is shut down and cannot fire`
        : `${unitId} is shut down and cannot attack`,
    );
  if (isPilotUnconscious(unit))
    throw new Error(
      wantWeapons
        ? `${unitId} is unconscious and cannot fire`
        : `${unitId} is unconscious and cannot attack`,
    );
  const def = mechDefFor(unit);
  const twist = options.twist ?? "front";
  const dropping = options.dropClub === true;
  if (dropping && unit.club === null) {
    throw new Error(`${unitId} holds no club to drop`);
  }
  // Carrying a club occupies both hands (TW p.146): punch, strike,
  // and arm-mounted weapon fire are barred until it is dropped first.
  const handsOccupied = unit.club !== null && !dropping;
  const normalizedPhysical = normalizePhysicalDecls(def, physicalDecls);
  if (wantPhysical) {
    checkPhysicalSetShape(unitId, normalizedPhysical);
    // TW p.145: the two punches may go to two different targets; every
    // other physical attack (and weapon fire) is independent of the weapon
    // target, so no single-target rule applies here.
    const physicalTargets = new Set(normalizedPhysical.map((p) => p.targetId));
    if (physicalTargets.size > 1 && normalizedPhysical.some((p) => p.type !== "punch")) {
      throw new Error("Only two punches may be split between two targets");
    }
    for (const p of normalizedPhysical) {
      const result = validatePhysicalAttack(state, unitId, p, twist, dropping);
      if (!result.ok) throw new Error(result.reason ?? "invalid physical attack");
    }
  }
  const sensorsOut = countDestroyedSensor(def, unit.damage, unit.critSlotsDestroyed);
  if (wantWeapons && sensorsBlind(sensorsOut)) {
    throw new Error(`${unitId} cannot fire: sensors destroyed (no weapon attacks)`);
  }
  const sensorMod = sensorAttackModifier(sensorsOut);
  const effectiveFacing = effectiveFacingForTwist(unit.facing, options.twist ?? "front");
  if (unit.prone && twistDelta(options.twist ?? "front") !== 0) {
    throw new Error(`${unitId} cannot twist torso while prone`);
  }
  if (wantWeapons && unit.prone) {
    if (
      isUnitLocationDestroyed(unit.damage, "leftArm") ||
      isUnitLocationDestroyed(unit.damage, "rightArm")
    ) {
      throw new Error(`${unitId} cannot fire while prone (need both arm location)`);
    }
    const hasLeft = weaponDecls.some((d) => def.weapons[d.weaponIndex]?.location === "leftArm");
    const hasRight = weaponDecls.some((d) => def.weapons[d.weaponIndex]?.location === "rightArm");
    if (hasLeft && hasRight) {
      throw new Error(`${unitId} cannot fire while prone (volley uses both arms; prop one)`);
    }
  }

  // Multiple targets (TW p.108): classify every weapon target against the
  // twisted facing first, so the primary target and each secondary modifier
  // are known before any to-hit is computed. Invalid targets are left for
  // the per-weapon checks below to reject with their specific error.
  const declaredTargets = [...new Set(weaponDecls.map((d) => d.targetId))];
  const forwardArcOf = new Map<string, boolean>();
  for (const id of declaredTargets) {
    const t = state.units[id];
    if (t === undefined || !isUnitOnBoard(t) || !isTargetableBy(unit, t)) continue;
    const a = classifyFiringArc(unit.position, t.position, effectiveFacing);
    if (a !== null) forwardArcOf.set(id, a === "front");
  }
  let primaryTargetId: string | null = null;
  if (declaredTargets.length > 0 && forwardArcOf.size === declaredTargets.length) {
    const forward = declaredTargets.filter((id) => forwardArcOf.get(id) === true);
    const requested = options.primaryTargetId;
    if (requested !== undefined) {
      if (!declaredTargets.includes(requested)) {
        throw new Error(`primary target ${requested} is not a declared weapon target`);
      }
      if (forward.length > 0 && !forward.includes(requested)) {
        throw new Error("primary target must be in the forward arc when any target is");
      }
      primaryTargetId = requested;
    } else {
      const first = declaredTargets[0]!;
      primaryTargetId = forward.length === 0 || forward.includes(first) ? first : forward[0]!;
    }
  }
  const secondaryModFor = (id: string): 0 | SecondaryTargetMod =>
    primaryTargetId === null || id === primaryTargetId
      ? 0
      : secondaryTargetModifier(unit.position, requireUnit(state, id).position, unit.facing, twist);

  const targetVolleys = new Map<string, ValidatedTargetVolley>();
  const seenWeapons = new Set<number>();
  const arcs: Record<number, Arc> = {};
  // TW p.103-104: same-name mounts share one ammo pool (any bin of the
  // right type, any location). Track claims within this volley so twins
  // declaring together cannot both spend the last shot.
  const claimedByWeaponName = new Map<string, number>();
  weaponDecls.forEach((decl) => {
    const mount = def.weapons[decl.weaponIndex];
    if (!mount) throw new Error(`weaponIndex ${decl.weaponIndex} out of range for ${unitId}`);
    const weapon = weaponDefFor(mount);
    if (weapon.physicalWeapon === true) {
      throw new Error(
        `${mount.weapon} on ${unitId} is physical-weapon equipment: strike with it, do not fire it`,
      );
    }
    if (!isFireableWeapon(weapon)) {
      throw new Error(`${mount.weapon} on ${unitId} is equipment, not a fireable weapon`);
    }

    if (seenWeapons.has(decl.weaponIndex)) {
      throw new Error(`${mount.weapon} on ${unitId} may only be declared once per turn`);
    }
    seenWeapons.add(decl.weaponIndex);

    if (unit.jammedWeapons.includes(decl.weaponIndex)) {
      throw new Error(`${mount.weapon} on ${unitId} is jammed`);
    }
    // Location first: a catastrophic wipe flags every slot there, and the
    // lost location is the clearer reason.
    if (!canFireMount(unit.damage, mount)) {
      throw new Error(
        `${mount.weapon} location (${mount.location}) is destroyed or its support torso is gone`,
      );
    }
    if (isWeaponCritted(def, unit.critSlotsDestroyed, decl.weaponIndex)) {
      throw new Error(`${mount.weapon} on ${unitId} is destroyed by a critical hit`);
    }
    if (handsOccupied && isArm(mount.location)) {
      throw new Error(
        `${mount.weapon} on ${unitId} cannot fire: hands occupied by club (drop it first)`,
      );
    }
    if (unit.prone && (mount.location === "rightLeg" || mount.location === "leftLeg")) {
      throw new Error(`${mount.weapon} on ${unitId} cannot fire while prone (leg-mounted)`);
    }
    const rapidFire = decl.rapidFire ?? false;
    if (rapidFire && weapon.rapidFireShots === undefined) {
      throw new Error(`${mount.weapon} is not rapid-fire`);
    }
    const shots = rapidFire ? (weapon.rapidFireShots ?? 1) : 1;

    const target = requireUnit(state, decl.targetId);
    if (!isUnitOnBoard(target)) throw new Error(`Target ${target.id} is removed from play`);
    if (!isTargetableBy(unit, target)) throw new Error("Target must belong to another team");

    const dist = hexDistance(unit.position, target.position);
    // Attacker-side firing arc (weapon legality, TW p.105 hex template).
    // Torso twist rotates the attacker's effective facing (see
    // `effectiveFacingForTwist`) before this classification so arm and
    // front-torso weapons cover the twisted arc. The template assigns every
    // hex wholly to one arc (no boundary pairs).
    // leg mounted weapon follows unit facing
    const fireArc = classifyFiringArc(
      unit.position,
      target.position,
      isLeg(mount.location) ? unit.facing : effectiveFacing,
    );
    if (fireArc === null) throw new Error("Attacker and target share a hex");
    arcs[decl.weaponIndex] = fireArc;
    const inArc = mountCanFireIntoArc(mount, fireArc);
    if (!inArc) {
      throw new Error(
        `${mount.weapon} on ${unitId} cannot fire into the ${fireArc} arc (target outside its firing arc)`,
      );
    }
    // Target-side attack direction (TW p.119): which side of the target the
    // attack strikes. Same for every weapon fired at this target.
    let targetVolley = targetVolleys.get(target.id);
    const losProne = losEnds(state, unit, target);
    const losSide = losSideFor(state, unit, target, losProne);
    const attackDirection =
      targetVolley?.attackDirection ?? attackDirectionFor(state, unit, target, losSide);

    const woodsPoints = losWoodsPointsBetween(
      state,
      unit.position,
      target.position,
      losProne,
      losSide,
    );
    if (!losClear(state, unit.position, target.position, losProne)) {
      if (losBlockedByBuilding(state, unit.position, target.position, losProne)) {
        throw new Error("Line of sight is blocked by intervening building");
      }
      if (losBlockedByElevation(state, unit.position, target.position, losProne)) {
        throw new Error("Line of sight is blocked by intervening elevation");
      }
      throw new Error("Line of sight is blocked by intervening woods");
    }

    if (isLeg(mount.location) && shooterInPartialCover(state, unit, target, losSide)) {
      throw new Error(
        `${mount.weapon} on ${unitId} cannot fire: leg-mounted weapons may not fire through a hex that gives the firing 'Mech partial cover`,
      );
    }

    if (dist > weapon.long) {
      throw new Error(`${mount.weapon}: target at range ${dist} exceeds long range ${weapon.long}`);
    }

    const breakdown = computeToHit({
      gunnery: unit.gunnery,
      attackerMovement: unit.moveMode ?? "standStill",
      attackerProne: unit.prone,
      sensorMod,
      actuatorMod: armWeaponToHitModifier(
        def,
        unit.damage,
        unit.critSlotsDestroyed,
        mountArcLocation(mount),
      ),
      targetHexesMoved: target.hexesMovedThisTurn,
      targetJumped: target.jumpedThisTurn,
      targetImmobile: isImmobile(target),
      targetProne: target.prone,
      targetTerrain: cellAt(state, target.position).terrain,
      partialCoverMod: partialCoverMod(state, unit, target, losSide),
      interveningWoods: woodsPoints,
      distance: dist,
      weapon,
      heatMod: toHitHeatModifier(unit.heat),
      tcMod: targetingComputerModifier(def, unit.damage, unit.critSlotsDestroyed, weapon),
      secondaryTargetMod: secondaryModFor(target.id),
    });
    targetVolley = {
      targetId: target.id,
      count: (targetVolley?.count ?? 0) + 1,
      attackDirection,
      distance: targetVolley?.distance ?? dist,
      rangeBracket: targetVolley?.rangeBracket ?? breakdown.rangeBracket,
      rangeMod: targetVolley?.rangeMod ?? breakdown.rangeMod,
      secondaryMod: secondaryModFor(target.id),
    };
    targetVolleys.set(target.id, targetVolley);
    if (breakdown.automatic === "miss") {
      throw new Error(
        `${mount.weapon}: modified TN ${toHitTotal(breakdown)} auto-misses; abort the declaration instead`,
      );
    }

    const needed = weapon.missiles !== undefined ? 1 : shots;
    // Pooled by weapon name: an unbound twin still draws from the shared
    // pool, so it gates and spends exactly like its sibling. Streaks fire
    // only on a hit (TW p.138) and resolve mid-volley exhaustion with an
    // auto-miss, so they need only one shared shot to declare and never
    // claim it up front; non-streaks spend at declare and accumulate.
    if (binsForWeaponName(def, mount.weapon).length > 0) {
      const left = pooledShotsLeft(def, unit, mount.weapon);
      if (weapon.streak === true) {
        if (left < 1) {
          throw new Error(`${mount.weapon}: needs 1 shot(s) but only ${left} remain`);
        }
      } else {
        const claimed = claimedByWeaponName.get(mount.weapon) ?? 0;
        if (left < claimed + needed) {
          throw new Error(
            `${mount.weapon}: needs ${claimed + needed} shot(s)${claimed > 0 ? ` (${claimed} already claimed by other mounts)` : ""} but only ${left} remain`,
          );
        }
        claimedByWeaponName.set(mount.weapon, claimed + needed);
      }
    }
  });

  const conflict = physicalWeaponConflict(def, weaponDecls, normalizedPhysical);
  if (conflict !== null) throw new Error(conflict);

  return {
    primaryTargetId,
    targets: declaredTargets.map((id) => targetVolleys.get(id)!),
    arcs,
    normalized: normalizedPhysical,
  };
}

export function validateAttacks(
  state: BattleState,
  unitId: string,
  weaponDecls: readonly WeaponAttackDecl[],
  physicalDecls: readonly PhysicalAttackDecl[] = [],
  options: DeclareAttacksOptions = {},
): void {
  validateAttacksImpl(state, unitId, weaponDecls, physicalDecls, options);
}

/**
 * Declare weapon and/or physical attacks for the current
 * weapon-attack-phase actor in one atomic call — the unit's single
 * attack declaration for the turn (a second call of either kind throws).
 * Weapons and physical attacks coexist in one turn (e.g. punch plus torso
 * weapons); commit order at resolution is weapons first, then physical.
 * Validates the full combined set (including the arm/leg weapon
 * interaction backstop) before mutating anything, so a throwing call
 * leaves no partial declarations behind. Emits one merged
 * `attacksDeclared` event carrying one weapon volley per target (primary
 * first; empty when the declaration holds physicals only) and the physical entries. At least
 * one declaration of either kind is required — except a lone `dropClub`,
 * which spends the activation shedding the club and attacking nothing.
 */
export function declareAttacks(
  state: BattleState,
  unitId: string,
  weaponDecls: readonly WeaponAttackDecl[] = [],
  physicalDecls: readonly PhysicalAttackDecl[] = [],
  sink: GameEvent[],
  rng: Rng,
  options: DeclareAttacksOptions = {},
): void {
  requireCurrentActor(state, unitId, "attack");
  const unit = requireUnit(state, unitId);
  const wantWeapons = weaponDecls.length > 0;
  const wantPhysical = physicalDecls.length > 0;
  if (!wantWeapons && !wantPhysical) {
    // Drop-only declaration: the unit spends its activation shedding the
    // club and attacks nothing this turn.
    if (options.dropClub !== true)
      throw new Error("declareAttacks requires at least one declaration");
    if (isUnitRemoved(unit)) throw new Error(`${unitId} is destroyed`);
    if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot attack`);
    if (isPilotUnconscious(unit)) throw new Error(`${unitId} is unconscious and cannot attack`);
    if (unit.club === null) throw new Error(`${unitId} holds no club to drop`);
    applyClubDrop(state, unit, sink);
    sink.push({ kind: "attacksDeclared", unitId, weapons: [], physical: [] });
    if (!state.actedThisPhase.includes(unitId)) state.actedThisPhase.push(unitId);
    return;
  }
  if (
    unit.declaredWeaponAttacks.length > 0 ||
    unit.declaredPhysicalAttacks.length > 0 ||
    unit.declaredPickup !== null
  )
    throw new Error(`${unitId} already declared attacks this turn`);
  const volley = validateAttacksImpl(state, unitId, weaponDecls, physicalDecls, options);
  const def = mechDefFor(unit);
  // Drop rides first in the declaration: hands are free for everything
  // queued below (validated as such above). The club stays intact in the
  // hex immediately, visible to later declarers.
  if (options.dropClub === true) {
    if (unit.club === null) throw new Error(`${unitId} holds no club to drop`);
    applyClubDrop(state, unit, sink);
  }
  // Consume non-streak ammo from the shared weapon-name pool per decl
  // (TW p.103-104); streak fires on hit and resolves its own ammo in
  // `resolveUnitAttacks`. RNG via ammo policy.
  if (wantWeapons) {
    for (const decl of weaponDecls) {
      const targetVolley = volley.targets.find((t) => t.targetId === decl.targetId);
      unit.declaredWeaponAttacks.push({
        ...decl,
        ...(options.twist !== undefined && options.twist !== "front"
          ? { twist: options.twist }
          : {}),
        ...(volley.arcs[decl.weaponIndex] !== undefined
          ? { arc: volley.arcs[decl.weaponIndex] }
          : {}),
        ...(targetVolley !== undefined
          ? {
              attackDirection: targetVolley.attackDirection,
              ...(targetVolley.secondaryMod !== 0
                ? { secondaryMod: targetVolley.secondaryMod }
                : {}),
            }
          : {}),
      });
      const mount = def.weapons[decl.weaponIndex];
      if (!mount) continue;
      const weapon = weaponDefFor(mount);
      const rapidFire = decl.rapidFire ?? false;
      const shots = rapidFire ? (weapon.rapidFireShots ?? 1) : 1;
      const needed = weapon.missiles !== undefined ? 1 : shots;
      if (binsForWeaponName(def, mount.weapon).length === 0) continue;
      if (weapon.streak === true) continue;
      unit.ammoBins = consumeAmmoForName(def, unit, mount.weapon, needed, unit.ammoPolicy, rng);
    }
  }
  if (wantPhysical) {
    for (const decl of volley.normalized) {
      unit.declaredPhysicalAttacks.push({
        ...decl,
        ...(options.twist ? { twist: options.twist } : {}),
      });
    }
  }
  sink.push({
    kind: "attacksDeclared",
    unitId,
    weapons: [...volley.targets]
      .sort(
        (a, b) =>
          Number(b.targetId === volley.primaryTargetId) -
          Number(a.targetId === volley.primaryTargetId),
      )
      .map((t) => ({
        targetId: t.targetId,
        count: t.count,
        distance: t.distance,
        rangeBracket: t.rangeBracket,
        rangeMod: t.rangeMod,
        secondaryMod: t.secondaryMod,
      })),
    physical: volley.normalized.map((d) => ({
      type: d.type,
      targetId: d.targetId,
      ...(d.weapon !== undefined ? { weapon: d.weapon as PhysicalWeaponName } : {}),
    })),
  });
  if (!state.actedThisPhase.includes(unitId)) state.actedThisPhase.push(unitId);
}

/**
 * Weapon / physical-attack interaction backstop (TW pp. 145–147): a
 * punching or striking arm or kicking leg cannot fire its mounted weapons
 * that turn, and a pushing / clubbing 'Mech fires no arm-mounted weapons
 * at all. Returns a human-readable conflict, or null when the combination
 * is legal. The web layer pre-checks the same rules for better messages;
 * `declareAttacks` enforces them on the combined declaration set.
 */
export function physicalWeaponConflict(
  def: ResolvedMechDef,
  weaponDecls: readonly WeaponAttackDecl[],
  physicalDecls: readonly PhysicalAttackDecl[],
): string | null {
  const punchedArms = new Set<string>();
  const kickedLegs = new Set<string>();
  const struckArms = new Set<string>();
  let noArmWeapons = false;
  for (const p of physicalDecls) {
    if (p.type === "punch" && p.limb !== undefined) punchedArms.add(p.limb);
    if (p.type === "kick" && p.limb !== undefined) kickedLegs.add(p.limb);
    if (p.type === "strike" && p.weapon !== undefined) {
      const arm = resolveStrikeArm(def, p.weapon, p.limb);
      if (arm !== null) struckArms.add(arm);
    }
    if (p.type === "club") noArmWeapons = true;
  }
  for (const w of weaponDecls) {
    const loc = def.weapons[w.weaponIndex]?.location;
    if (loc === undefined) continue;
    if (punchedArms.has(loc)) return `punching ${loc} cannot fire its weapons`;
    if (struckArms.has(loc)) return `striking ${loc} cannot fire its weapons`;
    if (kickedLegs.has(loc)) return `kicking ${loc} cannot fire its weapons`;
    if (noArmWeapons && isArm(loc)) return "pushing/clubbing 'Mech fires no arm-mounted weapons";
  }
  return null;
}

/** Attack-phase pass for the current actor: it declares no weapons,
 *  physical attacks, or pickup this turn and is marked as having acted.
 *  Mirrors `passMovement` for the alternating attack declarations
 *  (TW pp.37-38). */
export function passAttack(state: BattleState, unitId: string): void {
  requireCurrentActor(state, unitId, "attack");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (
    unit.declaredWeaponAttacks.length > 0 ||
    unit.declaredPhysicalAttacks.length > 0 ||
    unit.declaredPickup !== null
  )
    throw new Error(`${unitId} already declared attacks this turn`);
  if (unit.passedAttacks) throw new Error(`${unitId} already passed attacks this turn`);
  unit.passedAttacks = true;
  state.actedThisPhase.push(unitId);
}
