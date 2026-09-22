import type { Location, TorsoLocation } from "../core/types.js";
import {
  armFor,
  damageTransferTo,
  isArm,
  isKillLocation,
  isLeg,
  isTorso,
  shoulderOf,
} from "../core/types.js";
import type { Arc } from "./arcs.js";
import type { CaseKind } from "./critical.js";

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
  /** Arms blown off because their shoulder torso's structure was destroyed. */
  readonly blownOffArms: readonly Location[];
  readonly killed: boolean;
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
  const blownOffArms: Location[] = [];
  const caseKind = options?.caseKind;
  const bypassArmor = options?.bypassArmor;
  let killed = false;
  let remaining = caseKind === "caseII" ? 1 : amount;
  let current: Location | null = location;
  while (current !== null && remaining > 0 && !killed) {
    const cur: Location = current;

    // Ammo-explosion overflow (bypassArmor) skips the armor pool entirely at
    // every location — damage lands on IS directly (TW).
    if (!bypassArmor) {
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
      // to cover both paths.
      if (depleted) {
        newlyDestroyed.push(cur);
        if (isKillLocation(cur)) {
          killed = true;
          break;
        }
        const arm = armFor(cur);
        if (arm !== undefined && next.internalStructure[arm] > 0) {
          next.internalStructure[arm] = 0;
          next.armor[arm] = 0;
          newlyDestroyed.push(arm);
          blownOffArms.push(arm);
        }
      }
      if (remaining > 0 && !killed) {
        if (caseKind !== undefined && cur === location) {
          // CASE / CASE II: contain the blast here instead of transferring
          // inward - remaining damage is ignored; the blast just vents.
          break;
        }
        current = damageTransferTo(cur);
      } else break;
    } else {
      current = damageTransferTo(cur);
    }
  }

  // `damage` is never mutated (all writes go to `next`), so `pre` may alias it.
  return {
    after: next,
    before: damage as UnitDamageState,
    steps,
    newlyDestroyed,
    blownOffArms,
    killed,
  };
}

/** A location is destroyed when its internal structure is depleted. */
export function isUnitLocationDestroyed(damage: UnitDamageState, location: Location): boolean {
  return damage.internalStructure[location] <= 0;
}

/** Classic destruction: head or center torso internal structure gone ends the 'Mech. */
export function isUnitDestroyed(damage: UnitDamageState): boolean {
  return damage.internalStructure.head <= 0 || damage.internalStructure.centerTorso <= 0;
}

/** One or both legs' internal structure destroyed: cannot move or change facing. */
export function isUnitImmobile(damage: UnitDamageState): boolean {
  return damage.internalStructure.rightLeg <= 0 || damage.internalStructure.leftLeg <= 0;
}

/** A weapon in `location` can fire only if that location (and its shoulder for arms) is intact. */
export function canFireFromLocation(damage: UnitDamageState, location: Location): boolean {
  if (damage.internalStructure[location] <= 0) return false;
  if (isArm(location) || isLeg(location)) {
    return damage.internalStructure[shoulderOf(location)] > 0;
  }
  return true;
}
