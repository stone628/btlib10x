import type { Location } from "../core/types.js";

/**
 * Damage transfer graph (bipedal, quick-start damage-transfer diagram).
 * null = no further location; destroying head/centerTorso kills the 'Mech.
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

/** Flat armor hit points per location; a location is destroyed when its value reaches 0. */
export type ArmorState = Record<Location, number>;

export interface DamageTransferStep {
  readonly location: Location;
  readonly damageApplied: number;
  readonly depleted: boolean;
}

export interface DamageApplication {
  readonly armor: ArmorState;
  readonly steps: readonly DamageTransferStep[];
  /** Locations whose armor reached 0 during this application. */
  readonly newlyDestroyed: readonly Location[];
  /** Arms blown off because their shoulder torso was destroyed. */
  readonly blownOffArms: readonly Location[];
  readonly killed: boolean;
}

function cloneArmor(armor: ArmorState): ArmorState {
  return { ...armor };
}

/**
 * Apply one damage grouping against `armor` starting at `location`, following
 * the transfer graph. Overflow transfers inward only after the current
 * location's armor is fully depleted; hits on already-destroyed locations
 * transfer inward immediately. Pure: returns the updated armor state.
 */
export function applyDamage(
  armor: ArmorState,
  location: Location,
  damage: number,
): DamageApplication {
  if (!Number.isInteger(damage) || damage <= 0) {
    throw new Error(`damage must be a positive integer, got ${damage}`);
  }
  const next = cloneArmor(armor);
  const steps: DamageTransferStep[] = [];
  const newlyDestroyed: Location[] = [];
  const blownOffArms: Location[] = [];
  let killed = false;

  let remaining = damage;
  let current: Location | null = location;
  while (current !== null && remaining > 0) {
    const cur: Location = current;
    const before = next[cur];
    if (before <= 0) {
      current = TRANSFER_INWARD[cur];
      continue;
    }
    const applied = Math.min(remaining, before);
    const after = before - applied;
    next[cur] = after;
    remaining -= applied;
    const depleted = after === 0;
    steps.push({ location: cur, damageApplied: applied, depleted });
    if (depleted) {
      newlyDestroyed.push(cur);
      if (cur === "head" || cur === "centerTorso") {
        killed = true;
        break;
      }
      if (cur === "rightTorso" && next.rightArm > 0) {
        next.rightArm = 0;
        newlyDestroyed.push("rightArm");
        blownOffArms.push("rightArm");
      }
      if (cur === "leftTorso" && next.leftArm > 0) {
        next.leftArm = 0;
        newlyDestroyed.push("leftArm");
        blownOffArms.push("leftArm");
      }
    }
    if (remaining > 0) {
      current = TRANSFER_INWARD[cur];
    } else {
      break;
    }
  }

  return { armor: next, steps, newlyDestroyed, blownOffArms, killed };
}

export function isLocationDestroyed(armor: ArmorState, location: Location): boolean {
  return armor[location] <= 0;
}

/** Quick-start destruction: head or center torso gone ends the 'Mech. */
export function isKilled(armor: ArmorState): boolean {
  return armor.head <= 0 || armor.centerTorso <= 0;
}

/** One or both legs destroyed: cannot move or change facing, may still fire. */
export function isImmobile(armor: ArmorState): boolean {
  return armor.rightLeg <= 0 || armor.leftLeg <= 0;
}

/** A weapon in `location` can fire only if that location (and its shoulder for arms) is intact. */
export function canFireFromLocation(armor: ArmorState, location: Location): boolean {
  if (armor[location] <= 0) return false;
  if (location === "rightArm" || location === "rightLeg") return armor.rightTorso > 0;
  if (location === "leftArm" || location === "leftLeg") return armor.leftTorso > 0;
  return true;
}
