import { hexDistance, isAdjacent } from "../../core/hex";
import { cellAt } from "../../core/terrain";
import { hexKey, type Rng } from "../../core/types";
import { mechDefFor } from "../../data/index";
import type { ResolvedMechDef } from "../../data/mech.schema";
import { weaponDefFor } from "../../data/weapon.schema";
import { armWeaponToHitModifier, targetingComputerModifier } from "../actuators";
import { type AmmoBins, consumeAmmoForName } from "../ammo";
import { mountArcLocation } from "../arcs";
import type { WeaponToHitInput } from "../attack";
import { cloneCritTable, countDestroyedSensor } from "../critical";
import { interveningTerrains } from "../los";
import { sensorAttackModifier } from "../piloting";
import { isImmobile } from "./condition";
import { BUILDING_ABSORB_DIVISOR } from "./constants";
import { inferPronePropArm, losEnds, losSideFor, partialCoverMod } from "./geometry";
import { cloneDamage, requireUnit } from "./queries";
import type {
  AttackPhaseContext,
  BattleState,
  RunningState,
  UnitState,
  VolleyContext,
  WeaponAttackDecl,
} from "./types";

/** The unit's running state, created from its committed state on first use. */
export function runningStateFor(
  running: Record<string, RunningState>,
  unit: UnitState,
): RunningState {
  let run = running[unit.id];
  if (run === undefined) {
    run = {
      damage: cloneDamage(unit.damage),
      critSlotsDestroyed: cloneCritTable(unit.critSlotsDestroyed),
      ammoBins: { ...unit.ammoBins },
    };
    running[unit.id] = run;
  }
  return run;
}

/** The unit's phase-start ammo view (see `resolveUnitAttacks`), created on
 *  first use and debited only by its own Streak and AMS shots. */
export function ownStateFor(own: Record<string, RunningState>, unit: UnitState): RunningState {
  let view = own[unit.id];
  if (view === undefined) {
    view = {
      damage: unit.damage,
      critSlotsDestroyed: unit.critSlotsDestroyed,
      ammoBins: { ...unit.ammoBins },
    };
    own[unit.id] = view;
  }
  return view;
}

/** Draw one shot of `weaponName` from the unit's phase-start view and
 *  mirror the spending onto its running ledger, so the phase ends with one
 *  set of bins and no shot spent twice. */
export function spendOwnAmmo(
  def: ResolvedMechDef,
  unit: UnitState,
  weaponName: string,
  ctx: AttackPhaseContext,
  rng: Rng,
): void {
  const own = ownStateFor(ctx.own, unit);
  const self = runningStateFor(ctx.running, unit);
  const next = consumeAmmoForName(def, own, weaponName, 1, unit.ammoPolicy, rng);
  const mirrored: AmmoBins = { ...self.ammoBins };
  for (const [id, left] of Object.entries(next)) {
    const spent = (own.ammoBins[id] ?? 0) - left;
    // A bin already exploded or spilled this phase holds 0: the shot
    // left it before the blast, so there is nothing more to take.
    if (spent > 0) mirrored[id] = Math.max(0, (mirrored[id] ?? 0) - spent);
  }
  own.ammoBins = next;
  self.ammoBins = mirrored;
}

export function volleyContextFor(unit: UnitState): VolleyContext {
  const def = mechDefFor(unit);
  return {
    def,
    preHeat: unit.heat,
    sensorMod: sensorAttackModifier(
      countDestroyedSensor(def, unit.damage, unit.critSlotsDestroyed),
    ),
    pronePropArm: inferPronePropArm(def, unit.declaredWeaponAttacks, unit.prone),
  };
}

/** Everything about one declared shot the to-hit roll depends on. */
export function weaponToHitInputFor(
  state: BattleState,
  unit: UnitState,
  volley: VolleyContext,
  decl: WeaponAttackDecl,
  phaseStartCf: Record<string, number>,
): WeaponToHitInput {
  const mount = volley.def.weapons[decl.weaponIndex]!;
  const weapon = weaponDefFor(mount);
  const target = requireUnit(state, decl.targetId);
  const losProne = losEnds(state, unit, target);
  const losSide = losSideFor(state, unit, target, losProne);
  const secondaryMod = decl.secondaryMod ?? 0;
  const rapidFire = decl.rapidFire ?? false;
  return {
    gunnery: unit.gunnery,
    attackerMoved: unit.moveMode ?? "standStill",
    attackerHeat: volley.preHeat,
    tcMod: targetingComputerModifier(volley.def, unit.damage, unit.critSlotsDestroyed, weapon),
    ...(secondaryMod !== 0 ? { secondaryTargetMod: secondaryMod } : {}),
    attackerProne: unit.prone,
    ...(volley.pronePropArm !== null ? { propArm: volley.pronePropArm } : {}),
    sensorMod: volley.sensorMod,
    actuatorMod: armWeaponToHitModifier(
      volley.def,
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
    interveningTerrains: interveningTerrains(
      state,
      unit.position,
      target.position,
      losProne,
      losSide,
    ),
    distance: hexDistance(unit.position, target.position),
    // Resolution keys hit location and armor pool off the attack direction
    // (side of the target struck); the attacker-side firing arc only
    // gatekept the declaration.
    ...(decl.attackDirection !== undefined
      ? { arc: decl.attackDirection }
      : decl.arc !== undefined
        ? { arc: decl.arc }
        : {}),
    weapon: weapon.name,
    heatMode: unit.heatFlamer,
    shots: rapidFire ? (weapon.rapidFireShots ?? 1) : 1,
    buildingAbsorb: Math.ceil(
      (phaseStartCf[hexKey(target.position)] ?? 0) / BUILDING_ABSORB_DIVISOR,
    ),
    missesStrikeBuilding:
      phaseStartCf[hexKey(target.position)] !== undefined &&
      isAdjacent(unit.position, target.position),
    attackerLevel: cellAt(state, unit.position).level,
    targetLevel: cellAt(state, target.position).level,
  };
}
