import { isLeg, type Rng } from "../../core/types";
import { mechDefFor } from "../../data/index";
import { type WeaponDef, weaponDefFor } from "../../data/weapon.schema";
import { pooledShotsLeft } from "../ammo";
import { chooseAms, isAmsEngageable } from "../ams";
import {
  classifyFiringArc,
  effectiveFacingForTwist,
  mountCanFireIntoArc,
  type Twist,
} from "../arcs";
import { type MissileDefenseUse, weaponToHit } from "../attack";
import { isWeaponCritted } from "../critical";
import { canFireMount } from "../damage";
import { hitProbability, toHitTotal } from "../tohit";
import { isShutdown, isUnitRemoved, requireUnit } from "./queries";
import type { AmsEngagement, AttackPhaseContext, BattleState, UnitState } from "./types";
import { ownStateFor, spendOwnAmmo, volleyContextFor, weaponToHitInputFor } from "./weaponState";

/**
 * The unit's AMS able to engage this phase (TW p.129), judged at phase start
 * so fire resolved earlier in the phase never switches one off (simultaneous
 * fire, as for the unit's own Streaks): the unit is in play and powered, the
 * mount's location stands and its slots are intact. Leg AMS are out while
 * prone, as leg weapons are (TW p.113). Ammo is checked at engagement.
 */
export function amsMountsAtPhaseStart(unit: UnitState): number[] {
  if (isUnitRemoved(unit) || isShutdown(unit)) return [];
  const def = mechDefFor(unit);
  const mounts: number[] = [];
  for (const [key, mount] of Object.entries(def.weapons)) {
    const weaponIndex = Number(key);
    if (weaponDefFor(mount).antiMissile === undefined) continue;
    if (!canFireMount(unit.damage, mount)) continue;
    if (isWeaponCritted(def, unit.critSlotsDestroyed, weaponIndex)) continue;
    if (unit.prone && isLeg(mount.location)) continue;
    mounts.push(weaponIndex);
  }
  return mounts;
}

/** Torso twist the unit declared its attacks with this phase. */
export function declaredTwist(unit: UnitState): Twist {
  return (
    unit.declaredWeaponAttacks.find((d) => d.twist !== undefined)?.twist ??
    unit.declaredPhysicalAttacks.find((d) => d.twist !== undefined)?.twist ??
    "front"
  );
}

/** Weapon indices of the defender's AMS whose arc covers an attack from
 *  `attacker` (the weapon firing-arc test, torso twist included; leg mounts
 *  follow the unit's facing). */
export function amsCovering(
  defender: UnitState,
  mounts: readonly number[],
  attacker: UnitState,
): number[] {
  const def = mechDefFor(defender);
  const twisted = effectiveFacingForTwist(defender.facing, declaredTwist(defender));
  const covering: number[] = [];
  for (const weaponIndex of mounts) {
    const mount = def.weapons[weaponIndex]!;
    const arc = classifyFiringArc(
      defender.position,
      attacker.position,
      isLeg(mount.location) ? defender.facing : twisted,
    );
    if (arc !== null && mountCanFireIntoArc(mount, arc)) covering.push(weaponIndex);
  }
  return covering;
}

/**
 * Before any shot resolves: find every unit with a working AMS and list, in
 * resolution order, the declared missile attacks at it that an AMS covers,
 * with their phase-start hit chances (what the `amsPolicy` weighs). Keys
 * follow the declaration walk of `resolveUnitAttacks`.
 */
export function prepareMissileDefense(state: BattleState, ctx: AttackPhaseContext): void {
  let key = 0;
  for (const unit of Object.values(state.units)) {
    if (unit.declaredWeaponAttacks.length === 0) continue;
    const volley = volleyContextFor(unit);
    for (const decl of unit.declaredWeaponAttacks) {
      const attackKey = key++;
      const weapon = weaponDefFor(volley.def.weapons[decl.weaponIndex]!);
      if (!isAmsEngageable(weapon)) continue;
      const target = requireUnit(state, decl.targetId);
      let defender = ctx.ams[target.id];
      if (defender === undefined) {
        const mounts = amsMountsAtPhaseStart(target);
        if (mounts.length === 0) continue;
        defender = { mounts, used: new Set(), attacks: [] };
        ctx.ams[target.id] = defender;
      }
      const coveredBy = amsCovering(target, defender.mounts, unit);
      if (coveredBy.length === 0) continue;
      const { breakdown } = weaponToHit(
        weaponToHitInputFor(state, unit, volley, decl, ctx.phaseStartCf),
      );
      const hitChance =
        breakdown.automatic !== null
          ? breakdown.automatic === "hit"
            ? 1
            : 0
          : hitProbability(toHitTotal(breakdown));
      defender.attacks.push({ key: attackKey, weapon, hitChance, coveredBy });
    }
  }
}

/**
 * The target's AMS decision for the attack with resolution key `key`, asked
 * by `resolveWeaponAttack` once the attack hits (TW p.129). An engaging AMS
 * is marked used, spends its shot (AMS) and is logged for pass 2.
 */
export function missileDefenseFor(
  target: UnitState,
  key: number,
  ctx: AttackPhaseContext,
  rng: Rng,
  engagements: AmsEngagement[],
): ((weapon: WeaponDef) => MissileDefenseUse | null) | undefined {
  const defender = ctx.ams[target.id];
  const attack = defender?.attacks.find((a) => a.key === key);
  if (defender === undefined || attack === undefined) return undefined;
  return () => {
    const def = mechDefFor(target);
    const own = ownStateFor(ctx.own, target);
    const available = attack.coveredBy.filter((weaponIndex) => {
      if (defender.used.has(weaponIndex)) return false;
      const mount = def.weapons[weaponIndex]!;
      const weapon = weaponDefFor(mount);
      return weapon.antiMissile !== "ammo" || pooledShotsLeft(def, own, mount.weapon) > 0;
    });
    const pending = defender.attacks.filter((a) => a.key > key);
    const chosen = chooseAms(target.amsPolicy, attack, available, pending);
    if (chosen === null) return null;
    defender.used.add(chosen);
    const mount = def.weapons[chosen]!;
    const weapon = weaponDefFor(mount);
    let shotsLeft: number | null = null;
    if (weapon.antiMissile === "ammo") {
      spendOwnAmmo(def, target, mount.weapon, ctx, rng);
      shotsLeft = pooledShotsLeft(def, ownStateFor(ctx.own, target), mount.weapon);
    }
    const use: MissileDefenseUse = { weaponIndex: chosen, weapon: mount.weapon };
    engagements.push({ defenderId: target.id, use, heat: weapon.heat ?? 0, shotsLeft });
    return use;
  };
}
