import type { Rng } from "../../core/types";
import { awaitsDestroyedMark, destroyedReasonFor, isUnitWrecked } from "./condition";
import { markUnitDestroyed } from "./consequences";
import { resolveAirSupply, resolveHeatPhase } from "./heatPhase";
import { resolveAllAttacks } from "./resolveAttacks";
import { initiativePhaseGen, nextActor, rollInitiativePhase, startNextTurn } from "./turnOrder";
import type { BattleState, GameEvent, GameLoopResult, GameLoopStopper } from "./types";

export function advancePhase(state: BattleState, sink: GameEvent[], rng: Rng): void {
  sink.push(...advancePhaseGen(state, rng));
}

export function* advancePhaseGen(state: BattleState, rng: Rng): Generator<GameEvent> {
  const prevTurn = state.turn;
  const prevPhase = state.phase;
  state.actorQueue = null;
  switch (state.phase) {
    case "initiative": {
      if (state.initiativeWinnerTeam === null) {
        throw new Error("Roll initiative before leaving the initiative phase");
      }
      state.phase = "movement";
      break;
    }
    case "movement": {
      state.phase = "attack";
      state.actedThisPhase = [];
      break;
    }
    case "attack": {
      const sink: GameEvent[] = [];
      for (const unit of Object.values(state.units)) {
        if (awaitsDestroyedMark(unit) && isUnitWrecked(unit)) {
          markUnitDestroyed(state, unit, destroyedReasonFor(unit.damage), rng, sink);
        }
      }
      // The end phase starts with heat resolution: engine crit heat,
      // shutdown/restart checks, heat ammo explosions, then dissipation.
      resolveHeatPhase(state, rng, sink);
      sink.push({ kind: "attackPhaseStage", stage: "end", turn: state.turn });
      yield* sink;
      state.phase = "end";
      break;
    }
    case "end": {
      // Turn 0 is the setup placeholder `createBattle` parks in "end", not
      // a played End Phase.
      if (state.turn > 0) {
        const sink: GameEvent[] = [];
        resolveAirSupply(state, rng, sink);
        yield* sink;
      }
      startNextTurn(state);
      break;
    }
  }
  yield { kind: "phase", prevTurn, prevPhase, turn: state.turn, phase: state.phase };
}

/**
 * Advance the battle through transient phases (initiative roll, attack
 * resolution, phase transitions) until an actor must act or the game ends.
 * Mutates `state` in place; pure engine rules only — no session/UI state.
 * Throws if the loop exceeds 200 iterations (debug-only safety net).
 * engine keeps simulating, not responsible for win or lose
 */
export function gameLoop(
  state: BattleState,
  rng: Rng,
  stopper: GameLoopStopper,
  sink: GameEvent[],
): GameLoopResult {
  for (let i = 0; i < 200; i++) {
    if (stopper(state)) {
      return { actorId: null, stopped: true };
    }
    if (state.phase === "initiative") {
      rollInitiativePhase(state, rng, sink);
      continue;
    }
    if (state.phase === "end") {
      advancePhase(state, sink, rng);
      continue;
    }
    const id = nextActor(state);
    if (id !== null) return { actorId: id, stopped: false };
    if (state.phase === "attack") {
      resolveAllAttacks(state, rng, sink);
    }
    advancePhase(state, sink, rng);
  }
  throw new Error("phase driver exceeded 200 iterations");
}

export function* _battleLoopGen(state: BattleState, rng: Rng): Generator<GameEvent, boolean> {
  for (;;) {
    if (state.phase === "initiative") {
      yield* initiativePhaseGen(state, rng);
      continue;
    }
    if (state.phase === "end") {
      yield* advancePhaseGen(state, rng);
    }
  }
}
