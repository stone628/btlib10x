import type { Location } from "../core/types.js";
import type { Arc } from "./arcs.js";

/**
 * Damage transfer graph (bipedal, quick-start damage-transfer diagram).
 * Once a location's armor and internal structure are both depleted, overflow
 * transfers inward. null = no further location; destroying head/centerTorso
 * internal structure kills the 'Mech.
 */
export const TRANSFER_INWARD: Readonly<Record<Location, Location | null>> = {
  rightArm: "rightTorso",
  leftArm: "leftTorso",
  rightLeg: "rightTorso",
  leftLeg: "leftTorso",
  rightTorso: "centerTorso",
  leftTorso: "centerTorso",
  centerTorso: null,
  head: null,
};

/** Flat hit-point counter per location (front armor, or re-used for IS). */
export type ArmorState = Record<Location, number>;

const TORSO_LOCATIONS: readonly Location[] = ["centerTorso", "rightTorso", "leftTorso"];

/** When a side torso's structure is destroyed, its arm is blown off too. */
const TORSO_TO_ARM: Readonly<Partial<Record<Location, Location>>> = {
  rightTorso: "rightArm",
  leftTorso: "leftArm",
};

/**
 * Layered damage state for one unit: front armor plus rear torso armor plus
 * internal structure per location. Rear armor only exists on the three torso
 * locations. Damage drains the active armor pool (front or rear, by arc), then
 * that location's internal structure, then transfers inward.
 */
export interface UnitDamageState {
  /** Front armor per location; torso values are the front pool only. */
  readonly armor: ArmorState;
  /** Rear armor on the torso locations (other locations lack one). */
  readonly armorRear: Partial<Record<Location, number>>;
  /** Internal structure per location. */
  readonly internalStructure: ArmorState;
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
  if (arc === "rear" && TORSO_LOCATIONS.includes(location)) {
    return { kind: "armorRear", value: state.armorRear[location] ?? 0 };
  }
  return { kind: "armor", value: state.armor[location] };
}

/**
 * Apply one damage grouping against `damage` starting at `location` for the
 * given firing `arc` (defaults to front). Damage first drains the active armor
 * pool (front, or rear for rear-arc torso hits), then that location's internal
 * structure; once both are gone it transfers inward per the graph. Pure:
 * returns the updated layered damage state.
 */
export function applyDamage(
  damage: UnitDamageState,
  location: Location,
  amount: number,
  arc: Arc = "front",
): DamageApplication {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`damage must be a positive integer, got ${amount}`);
  }
  const next = clone(damage);
  const steps: DamageTransferStep[] = [];
  const newlyDestroyed: Location[] = [];
  const blownOffArms: Location[] = [];
  let killed = false;

  let remaining = amount;
  let current: Location | null = location;
  while (current !== null && remaining > 0 && !killed) {
    const cur: Location = current;

    const pool = poolOf(next, cur, arc);
    if (pool.value > 0) {
      const applied = Math.min(remaining, pool.value);
      const after = pool.value - applied;
      if (pool.kind === "armorRear") next.armorRear[cur] = after;
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

    const isBefore = next.internalStructure[cur];
    if (isBefore > 0) {
      const applied = Math.min(remaining, isBefore);
      const after = isBefore - applied;
      next.internalStructure[cur] = after;
      remaining -= applied;
      const depleted = after === 0;
      steps.push({ location: cur, pool: "structure", damageApplied: applied, depleted });
      if (depleted) {
        newlyDestroyed.push(cur);
        if (cur === "head" || cur === "centerTorso") {
          killed = true;
          break;
        }
        const arm = TORSO_TO_ARM[cur];
        if (arm !== undefined && next.internalStructure[arm] > 0) {
          next.internalStructure[arm] = 0;
          next.armor[arm] = 0;
          newlyDestroyed.push(arm);
          blownOffArms.push(arm);
        }
      }
      if (remaining > 0 && !killed) current = TRANSFER_INWARD[cur];
      else break;
    } else {
      current = TRANSFER_INWARD[cur];
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
export function isLocationDestroyed(damage: UnitDamageState, location: Location): boolean {
  return damage.internalStructure[location] <= 0;
}

/** Classic destruction: head or center torso internal structure gone ends the 'Mech. */
export function isKilled(damage: UnitDamageState): boolean {
  return damage.internalStructure.head <= 0 || damage.internalStructure.centerTorso <= 0;
}

/** One or both legs' internal structure destroyed: cannot move or change facing. */
export function isImmobile(damage: UnitDamageState): boolean {
  return damage.internalStructure.rightLeg <= 0 || damage.internalStructure.leftLeg <= 0;
}

/** A weapon in `location` can fire only if that location (and its shoulder for arms) is intact. */
export function canFireFromLocation(damage: UnitDamageState, location: Location): boolean {
  if (damage.internalStructure[location] <= 0) return false;
  if (location === "rightArm" || location === "rightLeg") {
    return damage.internalStructure.rightTorso > 0;
  }
  if (location === "leftArm" || location === "leftLeg") {
    return damage.internalStructure.leftTorso > 0;
  }
  return true;
}
