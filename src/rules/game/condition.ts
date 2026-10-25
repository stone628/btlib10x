import { mechDefFor } from "../../data/index";
import { type CriticalResolution, countDestroyedEngine, ENGINE_SLOTS_KILL } from "../critical";
import { isUnitDestroyed, isUnitImmobile, type UnitDamageState } from "../damage";
import { isPilotUnconscious } from "../pilot";
import { isHull, isShutdown, isUnitOnBoard } from "./queries";
import type { DestroyedReason, UnitState } from "./types";

export function isImmobile(unit: UnitState) {
  return (
    isHull(unit) || isShutdown(unit) || isPilotUnconscious(unit) || isUnitImmobile(unit.damage)
  );
}

/** True while a destruction sweep may still record a kill on `unit`: it is
 *  on the board (an active unit or a hull, see `markUnitDestroyed`). */
export function awaitsDestroyedMark(unit: UnitState): boolean {
  return isUnitOnBoard(unit);
}

/** The single kill-reason derivation for every damage path (weapon,
 *  physical, fall/collapse, heat): the first crit resolution in `crits`
 *  that killed the unit decides (its `killedReason`, first kill in that
 *  cascade, blasts included); otherwise the location whose IS hit zero. */
export function destroyedReasonFor(
  damage: UnitDamageState,
  crits?: readonly CriticalResolution[],
): DestroyedReason {
  for (const res of crits ?? []) {
    if (res.killedReason !== null) return res.killedReason;
  }
  if (damage.internalStructure.head <= 0) return "headDestroyed";
  if (damage.internalStructure.centerTorso <= 0) return "centerTorsoDestroyed";
  return "engineDestroyed";
}

/** Out of the game by damage alone: head or center torso gone, or three
 *  engine hits counting slots in destroyed locations (TW pp.125, 128). */
export function isUnitWrecked(unit: UnitState): boolean {
  return (
    isUnitDestroyed(unit.damage) ||
    countDestroyedEngine(mechDefFor(unit), unit.damage, unit.critSlotsDestroyed) >=
      ENGINE_SLOTS_KILL
  );
}

export function legGone(damage: UnitDamageState, leg: "rightLeg" | "leftLeg"): boolean {
  return (damage.internalStructure[leg] ?? 0) <= 0;
}
