import { D2D6_MAX, roll2D6 } from "../../core/dice";
import type { Rng } from "../../core/types";
import { shutdownAvoid } from "../heat";
import { isPilotUnconscious } from "../pilot";
import { leaveHull, resolveEjection } from "./consequences";
import { isNominal, isShutdown, isUnitRemoved, requireUnit } from "./queries";
import { requireCurrentActor } from "./turnOrder";
import type { BattleState, GameEvent } from "./types";

/** Pilot eject, resolved during the movement phase: the pilot leaves the
 *  'Mech after an ejection PSR (see `resolveEjection`), the unit leaves the
 *  battle (counted against victory) and its frame stays on the board as a
 *  hull (`isHull`). The emergency exit: available to any active unit,
 *  including shut-down and immobile ones. */
export function ejectPilot(state: BattleState, unitId: string, rng: Rng, sink: GameEvent[]): void {
  requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  // A voluntary exit is a window of its own: no one earns credit for it.
  state.currentDealt = { before: { damage: {}, crit: {} }, total: {}, byAttacker: {} };
  resolveEjection(state, unit, rng, sink, "manual");
}

/** Voluntary abandonment (house rule adapted from TO:AR p.165): a 'Mech
 *  that is shut down at its movement activation — so shut down in an earlier
 *  turn, an active 'Mech cannot abandon in a single turn — may have its pilot
 *  step out instead of any other action (restart included). No Piloting
 *  Skill Roll and no pilot hits; the unit becomes a hull at once, in the
 *  posture it stood in (`removed = "pilotAbandoned"`), and the pilot
 *  survives for campaign purposes. Marks the unit as having acted. */
export function abandonPilot(state: BattleState, unitId: string, sink: GameEvent[]): void {
  requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (!isShutdown(unit)) {
    throw new Error(
      `${unitId} must be shut down to abandon: shut down this turn, abandon the next`,
    );
  }
  if (isPilotUnconscious(unit)) throw new Error(`${unitId} is unconscious and cannot abandon`);
  if (state.actedThisPhase.includes(unitId)) throw new Error(`${unitId} already acted this phase`);
  // A voluntary exit is a window of its own: no one earns credit for it.
  state.currentDealt = { before: { damage: {}, crit: {} }, total: {}, byAttacker: {} };
  leaveHull(state, unit, "pilotAbandoned", sink);
  state.actedThisPhase.push(unitId);
}

/** Voluntary shutdown declaration, resolved during the movement phase: the
 *  unit goes off-line ("manual") immediately and stays down until a
 *  successful voluntary startup. Unlike an involuntary shutdown it forces no
 *  PSR (TW p.160). Marks the unit as having acted. */
export function voluntaryShutdown(state: BattleState, unitId: string, sink: GameEvent[]): void {
  requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (isShutdown(unit)) throw new Error(`${unitId} is already shut down`);
  unit.shutdown = "manual";
  state.actedThisPhase.push(unitId);
  sink.push({
    kind: "shutdownCheck",
    unitId,
    result: "manual",
    manual: true,
    roll: 0,
    heat: unit.heat,
    avoid: 0,
    threshold: 0,
  });
}

/** Voluntary startup attempt, resolved during the movement phase: roll 2D6
 *  against the shutdown avoidance number at the current heat. On success the
 *  unit comes online at once: the startup is its movement for the turn (it
 *  stands still) and it keeps the attack phase. On failure it remains shut
 *  down. Marks the unit as having acted either way. */
export function attemptVoluntaryStartup(
  state: BattleState,
  unitId: string,
  sink: GameEvent[],
  rng: Rng,
): void {
  requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (isNominal(unit)) throw new Error(`${unitId} is not shut down`);
  // A heat shutdown restarts only through the Heat Phase roll (TW p.160);
  // a movement-phase attempt would be a second roll in the same turn.
  if (unit.shutdown === "heat") {
    throw new Error(`${unitId} shut down from heat: the restart roll is made in the Heat Phase`);
  }
  const heat = unit.heat;
  const avoid = shutdownAvoid(heat);
  state.actedThisPhase.push(unitId);
  if (avoid > D2D6_MAX) {
    // No roll: heat 30+ blocks restart
    sink.push({
      kind: "restartCheck",
      unitId,
      result: "heat",
      manual: true,
      roll: 0,
      heat,
      avoid,
      threshold: 0,
    });
    return;
  }
  if (avoid > 0 && isPilotUnconscious(unit)) {
    // an unconscious pilot cannot attempt one.
    sink.push({
      kind: "restartCheck",
      unitId,
      result: "unconscious",
      manual: true,
      roll: 0,
      heat,
      avoid,
      threshold: 0,
    });
    return;
  }
  const roll = avoid === 0 ? 0 : roll2D6(rng);
  if (roll >= avoid) {
    unit.shutdown = "not";
    sink.push({
      kind: "restartCheck",
      unitId,
      result: "success",
      manual: true,
      roll,
      heat,
      avoid,
      threshold: 0,
    });
  } else {
    sink.push({
      kind: "restartCheck",
      unitId,
      result: "fail",
      manual: true,
      roll,
      heat,
      avoid,
      threshold: 0,
    });
  }
}
