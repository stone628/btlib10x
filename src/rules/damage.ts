import type { LimbLocation, Location, TorsoLocation } from "../core/types";
import {
  armFor,
  damageTransferTo,
  isArm,
  isKillLocation,
  isTorso,
  shoulderOf,
} from "../core/types";
import type { Arc } from "./arcs";
import type { CaseKind } from "./critical";

/** Per-location numeric value (armor HP, IS HP, etc.). */
export type LocationValue = Record<Location, number>;
export type TorsoLocationValue = Record<TorsoLocation, number>;

/**
 * Layered damage state for one unit: front armor plus rear torso armor plus
 * internal structure per location. Rear armor only exists on the three torso
 * locations. Damage drains the active armor pool (front or rear, by arc), then
 * that location's internal structure, then transfers inward.
 */
export interface UnitDamageState {
  /** Front armor per location; torso values are the front pool only. */
  readonly armor: LocationValue;
  /** Rear armor on the torso locations (other locations lack one). */
  readonly armorRear: TorsoLocationValue;
  /** Internal structure per location. */
  readonly internalStructure: LocationValue;
}

export interface DamageTransferStep {
  readonly location: Location;
  readonly pool: "armor" | "armorRear" | "structure";
  readonly damageApplied: number;
  readonly depleted: boolean;
}

export interface DamageApplication {
  /** Layered damage state after the application. */
  readonly after: UnitDamageState;
  /** Layered damage state immediately before the application ran. */
  readonly before: UnitDamageState;
  readonly steps: readonly DamageTransferStep[];
  /** Locations whose internal structure reached 0 during this application. */
  readonly newlyDestroyed: readonly Location[];
  /** Limbs blown off. `applyDamage` yields arms only (side-torso destruction,
   *  TW p.121; the leg is unharmed). Callers that merge crit results (attack.ts)
   *  may also add legs (TW p.124: 12 on a leg determination). */
  readonly blownOffLimbs: readonly LimbLocation[];
  /** This damage destroyed the 'Mech (TW p. 128): `applyDamage` sets it when a
   *  kill location (head / center torso) reaches 0 internal structure; merged
   *  applications also set it when a critical hit destroys the 'Mech (cockpit,
   *  head blown off, third engine hit). Says nothing about the MechWarrior,
   *  whose fate is resolved separately (cockpit crit, CT ammo/weapon blast,
   *  TO auto-eject). */
  readonly mechDestroyed: boolean;
}

/** Damage points this application spent marking circles (armor + structure).
 *  This is TW's "damage points taken": wipes from step-5 destruction
 *  (TW p.122), vented CASE damage and unspent overkill never become steps,
 *  so they are excluded here. */
export function dealtOf(app: Pick<DamageApplication, "steps">): number {
  let n = 0;
  for (const s of app.steps) n += s.damageApplied;
  return n;
}

/** Locations whose internal structure the application damaged, in order.
 *  Each gets its own critical roll (TW p.124: "A single hit damaging
 *  multiple locations gives a critical roll for each location"). */
export function structureStruck(app: DamageApplication): Location[] {
  const out: Location[] = [];
  for (const s of app.steps) {
    if (s.pool === "structure" && s.damageApplied > 0 && !out.includes(s.location)) {
      out.push(s.location);
    }
  }
  return out;
}

function clone(state: UnitDamageState): UnitDamageState {
  return {
    armor: { ...state.armor },
    armorRear: { ...state.armorRear },
    internalStructure: { ...state.internalStructure },
  };
}

/** Which armor pool a hit to `location` drains for the given `arc`. */
function poolOf(
  state: UnitDamageState,
  location: Location,
  arc: Arc,
): { kind: "armor" | "armorRear"; value: number } {
  if (arc === "rear" && isTorso(location)) {
    return { kind: "armorRear", value: state.armorRear[location] ?? 0 };
  }
  return { kind: "armor", value: state.armor[location] };
}

export interface DamageOptions {
  caseKind?: CaseKind | undefined;
  /** Skip armor at every location; damage hits IS directly (TW ammo explosion). */
  bypassArmor?: boolean | undefined;
}

/**
 * Apply one damage grouping against `damage` starting at `location` for the
 * given firing `arc` (defaults to front). Damage first drains the active armor
 * pool (front, or rear for rear-arc torso hits), then that location's internal
 * structure; once both are gone it transfers inward per the graph. CASE
 * protection (optional, from ammo explosions) caps the overflow at the
 * protected location. When `bypassArmor` is set, armor is skipped at every
 * location in the chain — damage goes straight to IS (per TW, ammo-explosion
 * overflow transfers to the next location's internal structure). Pure: returns
 * the updated layered damage state.
 */
export function applyDamage(
  damage: UnitDamageState,
  location: Location,
  amount: number,
  arc: Arc = "front",
  options?: DamageOptions,
): DamageApplication {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`damage must be a positive integer, got ${amount}`);
  }
  const next = clone(damage);
  const steps: DamageTransferStep[] = [];
  const newlyDestroyed: Location[] = [];
  const blownOffLimbs: LimbLocation[] = [];
  const caseKind = options?.caseKind;
  const bypassArmor = options?.bypassArmor;
  let mechDestroyed = false;
  let remaining = caseKind === "caseII" ? 1 : amount;
  let current: Location | null = location;
  while (current !== null && remaining > 0 && !mechDestroyed) {
    const cur: Location = current;

    // Armor at every location is skipped when bypassing (TW ammo-explosion
    // overflow, p.123 Step 8 / p.125) or when the location is already
    // destroyed — its remaining armor was wiped with it (TW p.122 step 5),
    // so damage carries inward.
    if (!bypassArmor && next.internalStructure[cur] > 0) {
      const pool = poolOf(next, cur, arc);
      if (pool.value > 0) {
        const applied = Math.min(remaining, pool.value);
        const after = pool.value - applied;
        if (pool.kind === "armorRear" && isTorso(cur)) next.armorRear[cur] = after;
        else next.armor[cur] = after;
        remaining -= applied;
        steps.push({
          location: cur,
          pool: pool.kind,
          damageApplied: applied,
          depleted: after === 0,
        });
        // If armor absorbed everything, we're done; otherwise continue to IS.
        if (remaining === 0 || after > 0) break;
      }
    }

    const isBefore = next.internalStructure[cur];
    if (isBefore > 0) {
      const applied = Math.min(remaining, isBefore);
      const after = isBefore - applied;
      next.internalStructure[cur] = after;
      remaining -= applied;
      const depleted = after === 0;
      steps.push({ location: cur, pool: "structure", damageApplied: applied, depleted });
      // Asymmetry note: plain-damage destruction (this branch) does NOT
      // mark the location's crit slots destroyed and does NOT strip its
      // ammo bins here. Only ammo-explosion destruction does so, via
      // `markLocationCatastrophicallyDestroyed` in `critical.ts`. The
      // design lets salvage readers recover components in locations
      // destroyed by overflow; future salvage module must gate on
      // `isUnitLocationDestroyed(damage, loc) || critSlotsDestroyed[loc][i]`
      // to cover both paths. Armor IS wiped here on both paths: TW p.122
      // step 5 destroys the location "along with any remaining armor there
      // (front or rear)".
      if (depleted) {
        zeroLocationStructure(next, cur);
        newlyDestroyed.push(cur);
        if (isKillLocation(cur)) {
          mechDestroyed = true;
          break;
        }
        const arm = armFor(cur);
        if (arm !== undefined && next.internalStructure[arm] > 0) {
          next.internalStructure[arm] = 0;
          next.armor[arm] = 0;
          newlyDestroyed.push(arm);
          blownOffLimbs.push(arm);
        }
      }
      if (remaining > 0 && !mechDestroyed) {
        if (caseKind !== undefined && cur === location) {
          // CASE / CASE II: contain the blast here instead of transferring
          // inward - remaining damage is ignored; the blast just vents.
          break;
        }
        current = damageTransferTo(cur);
      } else break;
    } else {
      // CASE still vents a blast in a location already at 0 IS (CRIT-02).
      if (caseKind !== undefined && cur === location) break;
      current = damageTransferTo(cur);
    }
  }

  // `damage` is never mutated (all writes go to `next`), so `pre` may alias it.
  return {
    after: next,
    before: damage as UnitDamageState,
    steps,
    newlyDestroyed,
    blownOffLimbs,
    mechDestroyed,
  };
}

/** A location is destroyed when its internal structure is depleted. */
export function isUnitLocationDestroyed(damage: UnitDamageState, location: Location): boolean {
  return damage.internalStructure[location] <= 0;
}

/** Wipe a location's structural pools in place: front armor, rear armor on
 *  torsos, and internal structure. Every destruction path lands here — plain
 *  damage via the `applyDamage` depleted branch and catastrophic paths via
 *  `markLocationCatastrophicallyDestroyed` — per TW p.122 step 5 the location
 *  goes "along with any remaining armor there (front or rear)". Lives here
 *  (not in `critical.ts`) so `damage.ts` needs no runtime import upward. */
export function zeroLocationStructure(damage: UnitDamageState, loc: Location): void {
  damage.armor[loc] = 0;
  if (isTorso(loc)) damage.armorRear[loc] = 0;
  damage.internalStructure[loc] = 0;
}

/** Classic destruction: head or center torso internal structure gone ends the 'Mech. */
export function isUnitDestroyed(damage: UnitDamageState): boolean {
  return damage.internalStructure.head <= 0 || damage.internalStructure.centerTorso <= 0;
}

/** Number of destroyed leg locations (TW p.122). */
export function destroyedLegs(damage: UnitDamageState): number {
  return (
    (damage.internalStructure.rightLeg <= 0 ? 1 : 0) +
    (damage.internalStructure.leftLeg <= 0 ? 1 : 0)
  );
}

/** Number of destroyed arm locations (TW p.50 / p.113). */
export function destroyedArms(damage: UnitDamageState): number {
  return (
    (damage.internalStructure.rightArm <= 0 ? 1 : 0) +
    (damage.internalStructure.leftArm <= 0 ? 1 : 0)
  );
}

/** True when both legs AND both arms are gone (TW p.122 "no legs and no arms
 *  = immobile"). A unit with both legs gone but arms intact can prop itself
 *  up to fire (p.122) and is not an immobile target. A unit with one leg and
 *  both arms gone is permanently prone (cannot stand, cannot fire) but per
 *  p.110 is not classed as an immobile target either. */
export function isUnitImmobile(damage: UnitDamageState): boolean {
  return destroyedLegs(damage) === 2 && destroyedArms(damage) === 2;
}

/** True when the unit is allowed to attempt a stand-up (TW p.50):
 *  one leg + both arms = cannot stand; both legs = cannot stand. */
export function canAttemptStandUp(damage: UnitDamageState): boolean {
  const legs = destroyedLegs(damage);
  const arms = destroyedArms(damage);
  if (legs >= 2) return false;
  if (legs === 1 && arms >= 2) return false;
  return true;
}

/** A mount can fire only while every location holding its slots can (split weapons need both). */
export function canFireMount(
  damage: UnitDamageState,
  mount: { readonly location: Location; readonly splitLocation?: Location },
): boolean {
  if (!canFireFromLocation(damage, mount.location)) return false;
  return mount.splitLocation === undefined || canFireFromLocation(damage, mount.splitLocation);
}

/** A weapon in `location` can fire only if that location (and its shoulder for arms) is intact. */
export function canFireFromLocation(damage: UnitDamageState, location: Location): boolean {
  if (damage.internalStructure[location] <= 0) return false;
  // Legs need only themselves: a lost side torso takes its arm (TW p.122), not its leg.
  if (isArm(location)) return damage.internalStructure[shoulderOf(location)] > 0;
  return true;
}
