import type { Rng } from "../../core/types";
import { weaponDefFor } from "../../data/weapon.schema";
import { pooledShotsLeft } from "../ammo";
import { resolveWeaponAttack } from "../attack";
import { losEnds, losSideFor, partialCoverBuildingHex } from "./geometry";
import { missileDefenseFor } from "./missileDefense";
import { requireUnit } from "./queries";
import type {
  AmsEngagement,
  AttackPhaseContext,
  BattleState,
  UnitAttackResolution,
  UnitAttackResult,
  UnitState,
} from "./types";
import {
  ownStateFor,
  runningStateFor,
  spendOwnAmmo,
  volleyContextFor,
  weaponToHitInputFor,
} from "./weaponState";

export function resolveUnitAttacks(
  state: BattleState,
  unit: UnitState,
  rng: Rng,
  ctx: AttackPhaseContext,
): UnitAttackResult {
  const volley = volleyContextFor(unit);
  const def = volley.def;
  // TW resolves weapon attacks simultaneously, so the unit's own Streak
  // launchers see its bins as they stood at phase start: damage and crits
  // other units' fire put on it this phase cannot strand, destroy or
  // explode a bin out from under its own volley, whatever the resolution
  // order. `own` is that phase-start view, debited only by the unit's own
  // Streak (and AMS) shots; each shot is mirrored onto the running ledger
  // (which carries the crits the unit takes), see `spendOwnAmmo`.
  const own = ownStateFor(ctx.own, unit);
  const jammedWeapons: number[] = [];
  const resolutions: UnitAttackResolution[] = [];

  for (const decl of unit.declaredWeaponAttacks) {
    const key = ctx.nextKey++;
    const mount = def.weapons[decl.weaponIndex]!;
    const weapon = weaponDefFor(mount);
    const target = requireUnit(state, decl.targetId);
    const secondaryMod = decl.secondaryMod ?? 0;
    let ammoExhausted = false;

    // Streak launchers share one pool per weapon name and fire only on a
    // hit: an earlier launcher may have drained the pool mid-resolution.
    // With nothing left the launcher cannot fire — auto-miss without
    // touching dice (no ammo spent, no heat).
    if (weapon.streak === true && pooledShotsLeft(def, own, weapon.name) < 1) {
      ammoExhausted = true;
    }

    const run = runningStateFor(ctx.running, target);
    const targetBaseDamage = run.damage;
    const engagements: AmsEngagement[] = [];
    const missileDefense = missileDefenseFor(target, key, ctx, rng, engagements);

    const resolution = resolveWeaponAttack({
      ...weaponToHitInputFor(state, unit, volley, decl, ctx.phaseStartCf),
      rng,
      ammoExhausted,
      targetDamage: targetBaseDamage,
      ...(missileDefense !== undefined ? { missileDefense } : {}),
      ...(state.critsDisabled
        ? {}
        : {
            targetCrits: {
              model: target.model,
              critSlotsDestroyed: run.critSlotsDestroyed,
              ammoBins: run.ammoBins,
              baseCritSlotsDestroyed: target.critSlotsDestroyed,
            },
          }),
    });
    run.damage = resolution.targetDamageAfter;
    const lastCrit = resolution.crits[resolution.crits.length - 1];
    if (lastCrit !== undefined) {
      run.critSlotsDestroyed = lastCrit.critSlotsDestroyed;
      run.ammoBins = lastCrit.ammoBins;
    }
    const ams = engagements[0];

    // Streak launchers expend one shot only when to-hit succeeds: miss
    // means launcher never fired (no ammo, no heat, no damage).
    const streakFired = weapon.streak === true && resolution.hit;
    if (weapon.streak === true && !resolution.hit) {
      resolutions.push({
        targetId: target.id,
        secondaryMod,
        resolution,
        weaponHeat: 0,
        buildingDamage: 0,
      });
      continue;
    }
    // Draw from the shared weapon-name pool so mounts with no directly
    // linked bins still spend shared ammo. The pre-resolution guard above
    // guarantees at least one shot remains, so this always draws exactly 1.
    if (streakFired) spendOwnAmmo(def, unit, weapon.name, ctx, rng);

    const shots = decl.rapidFire === true ? (weapon.rapidFireShots ?? 1) : 1;
    const weaponHeat = (weapon.heat ?? 0) * shots;

    // TW p. 171: the hex absorbs, from each attack that hits, damage equal
    // to its CF at the beginning of the phase / 10 (round up). Each Damage
    // Value grouping with its own hit location roll counts as a separate
    // attack. The occupant takes only what the groupings have left
    // (absorbed inside `resolveWeaponAttack`); the building is charged what
    // it actually absorbed.
    const buildingDamage = resolution.buildingAbsorbed ?? 0;
    const losSide = losSideFor(state, unit, target, losEnds(state, unit, target));
    const coverHex =
      resolution.coverDamage !== undefined
        ? partialCoverBuildingHex(state, unit, target, losSide)
        : undefined;

    resolutions.push({
      targetId: target.id,
      secondaryMod,
      resolution,
      weaponHeat,
      buildingDamage,
      ...(coverHex !== undefined && resolution.coverDamage !== undefined
        ? { coverBuilding: { hex: coverHex, damage: resolution.coverDamage } }
        : {}),
      ...(ams !== undefined ? { ams } : {}),
    });

    if (resolution.jammed && !jammedWeapons.includes(decl.weaponIndex)) {
      jammedWeapons.push(decl.weaponIndex);
    }
  }

  return {
    unitId: unit.id,
    resolutions,
    jammedWeapons,
  };
}
