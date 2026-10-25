import { cellAt } from "../../core/terrain";
import type { MoveMode, Rng } from "../../core/types";
import { mechDefFor } from "../../data/index";
import { countDestroyedGyro, effectiveMovement } from "../critical";
import { canAttemptStandUp } from "../damage";
import { effectiveMoveBudget, isTsmActive } from "../heat";
import { isPilotUnconscious } from "../pilot";
import { GYRO_DESTROYED_HITS, preexistingDamageModifier } from "../piloting";
import { releaseClub } from "./clubs";
import { applyFall, pushPilotingCheck } from "./consequences";
import { DROP_BUDGET_MIN, DROP_MP_COST, POSTURE_MOVE_HEAT, STAND_MP_COST } from "./constants";
import { isShutdown, isUnitRemoved, requireUnit } from "./queries";
import { requireCurrentActor } from "./turnOrder";
import type { BattleState, GameEvent, PostureChange, PosturePool, UnitState } from "./types";

/** MP a stand-up or drop charges for `unit` as it stands now (TW pp.49-50). */
export function postureCost(unit: UnitState, posture: PostureChange): number {
  return posture === "standUp" ? standUpCost(unit) : DROP_MP_COST;
}

export function posturePool(cost: number, posture: PostureChange): PosturePool {
  return posture === "standUp"
    ? { mp: cost, exhausted: cost < STAND_MP_COST, modeHeatPaid: true, freeFacing: true }
    : { mp: cost, exhausted: false, modeHeatPaid: false, freeFacing: false };
}

export function remainingAfterPosture(budget: number, pool: PosturePool): number {
  return pool.exhausted ? 0 : Math.max(0, budget - pool.mp);
}

/**
 * MP left for the movement that follows a stand-up or drop, out of the
 * locomotion `budget` (the walking or running MP the unit has now). Posture
 * and movement share one pool (TW pp.49-50); a stand made through Minimum
 * Movement leaves nothing (TW p.49). Call before the posture change: the
 * stand-up cost depends on the unit's current walking MP.
 */
export function postureMoveBudget(unit: UnitState, posture: PostureChange, budget: number): number {
  return remainingAfterPosture(budget, posturePool(postureCost(unit, posture), posture));
}

/**
 * True when `attemptStandUp` / `executePostureMove("standUp")` will not refuse
 * the unit's condition: legs and arms (`canAttemptStandUp`, TW p.50) and a
 * gyro that is not destroyed (TW p.125). Mobility (MP), heat, shutdown and
 * consciousness are not tested.
 */
export function canUnitStandUp(unit: UnitState): boolean {
  return (
    canAttemptStandUp(unit.damage) &&
    countDestroyedGyro(mechDefFor(unit), unit.damage, unit.critSlotsDestroyed) < GYRO_DESTROYED_HITS
  );
}

/**
 * Stand-up attempt for a prone unit (TW p.50): spends `STAND_MP_COST` (or the
 * remaining walk budget, whichever is smaller — TW p.50 lets a 1-MP-prone
 * 'Mech like a one-leg unit still attempt to stand) and adds 1 heat, then
 * rolls a PSR with preexisting-damage modifiers only. On success the 'Mech
 * is left standing facing the direction it had been prone in; on failure it
 * crashes back down for fresh falling damage. A 'Mech with a destroyed gyro,
 * both legs gone, one leg + both arms gone, or no walking MP cannot attempt
 * to stand (TW pp.49-50).
 *
 * Returns the MP cost actually charged for the stand. The stand ends the
 * activation; to move after it in the same activation, use
 * `executePostureMove`, which charges both from one pool.
 */
export function attemptStandUp(
  state: BattleState,
  unitId: string,
  sink: GameEvent[],
  rng: Rng,
  locomotion: MoveMode = "walk",
): number {
  requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (!unit.prone) throw new Error(`${unitId} is not prone`);
  if (unit.jumpedThisTurn) throw new Error(`${unitId} jumped this turn and cannot stand up`);
  if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot stand up`);
  if (isPilotUnconscious(unit)) throw new Error(`${unitId} is unconscious and cannot stand up`);
  const def = mechDefFor(unit);
  const pre = preexistingDamageModifier(def, unit.damage, unit.critSlotsDestroyed);
  const budget = standUpWalkBudget(unit);
  if (pre.gyroHits >= GYRO_DESTROYED_HITS)
    throw new Error(`${unitId} has a destroyed gyro and cannot stand up`);
  if (!canAttemptStandUp(unit.damage)) throw new Error(`${unitId} cannot stand up in this state`);
  // TW pp.49-50: an attempt needs at least 1 MP (Minimum Movement).
  if (budget < 1) throw new Error(`${unitId} has no MP to attempt a stand`);
  const standCost = standUpCost(unit);
  // The declared mode sets the attacker movement modifier (TW p.49), even
  // when the 'Mech stands in place and moveUnit never re-sets it.
  unit.moveMode = locomotion === "run" ? "run" : "walk";
  unit.hexesMovedThisTurn = 0;
  unit.jumpedThisTurn = false;
  unit.mpSpent = standCost;
  state.actedThisPhase.push(unitId);
  // The stand costs 1 heat on top of the declared mode's own heat (TW p.159).
  const standHeat = POSTURE_MOVE_HEAT + (locomotion === "run" ? 2 : locomotion === "walk" ? 1 : 0);
  unit.heatPending += standHeat;
  sink.push({
    kind: "heatMove",
    unitId,
    heat: standHeat,
    base: unit.heat,
    totalGenerated: unit.heatPending,
  });
  const r = pushPilotingCheck(sink, unit, "standUp", 0, pre.modifier, rng, unit.position);
  if (r.success) {
    unit.prone = false;
    sink.push({
      kind: "moved",
      unitId,
      mode: "walk",
      prevMode: "prone",
      position: unit.position,
      facing: unit.facing,
      mpSpent: standCost,
      mpBudget: budget,
    });
    return standCost;
  }
  // Failed stand: the 'Mech crashes back down (TW p.50) for fresh fall damage.
  const terrain = cellAt(state, unit.position).terrain;
  applyFall(
    state,
    unit,
    rng,
    {
      cause: { kind: "failedPsr", reason: "standUp" },
      hex: unit.position,
      seatbeltModifier: pre.modifier,
      halved: terrain === "water2" || terrain === "water3",
      allowProne: true,
    },
    sink,
  );
  return standCost;
}

/** Walking MP a stand-up attempt draws on, whatever locomotion follows. */
export function standUpWalkBudget(unit: UnitState): number {
  const def = mechDefFor(unit);
  return effectiveMoveBudget(
    "walk",
    effectiveMovement(def, unit.damage, unit.critSlotsDestroyed, isTsmActive(def, unit.heat)),
    unit.heat,
  );
}

/** MP `attemptStandUp` charges: TW p.50 lets a prone 'Mech with only 1 MP
 *  (e.g. a one-leg 'Mech) still attempt to stand, at the cost of whatever
 *  walking budget it has, so the charge is capped at that budget. */
export function standUpCost(unit: UnitState): number {
  return Math.min(STAND_MP_COST, standUpWalkBudget(unit));
}

/**
 * Voluntary drop to the ground (TW p.49; 1 MP): no roll, no heat, no
 * falling damage; the 'Mech counts as walking for to-hit this turn.
 * Not allowed in a turn the 'Mech jumped.
 */
export function dropProne(state: BattleState, unitId: string, sink: GameEvent[]): void {
  requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (unit.prone) throw new Error(`${unitId} is already prone`);
  if (unit.jumpedThisTurn) throw new Error(`${unitId} jumped this turn and cannot drop prone`);
  if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot move`);
  if (isPilotUnconscious(unit)) throw new Error(`${unitId} is unconscious and cannot move`);
  const def = mechDefFor(unit);
  const budget = effectiveMoveBudget(
    "walk",
    effectiveMovement(def, unit.damage, unit.critSlotsDestroyed, isTsmActive(def, unit.heat)),
    unit.heat,
  );
  if (budget < DROP_BUDGET_MIN) throw new Error(`${unitId} has no MP to drop prone`);
  const prevMode = unit.moveMode ?? "standStill";
  unit.moveMode = "walk";
  unit.hexesMovedThisTurn = 0;
  unit.jumpedThisTurn = false;
  unit.mpSpent = DROP_MP_COST;
  unit.prone = true;
  releaseClub(state, unit, "fall", sink);
  state.actedThisPhase.push(unitId);
  // TW p.49: dropping to the ground causes no falling damage. The unitFell
  // marker is kept (zero damage, no groups, no crits) so the posture change
  // stays visible in the event log.
  sink.push(
    {
      kind: "unitFell",
      unitId,
      cause: { kind: "voluntaryDrop" },
      hex: unit.position,
      facingAfter: unit.facing,
      fallRoll: null,
      column: "front",
      levelsFallen: 0,
      groups: [],
      crits: [],
    },
    {
      kind: "moved",
      unitId,
      mode: "prone",
      prevMode,
      position: unit.position,
      facing: unit.facing,
      mpSpent: DROP_MP_COST,
      mpBudget: budget,
    },
  );
}
