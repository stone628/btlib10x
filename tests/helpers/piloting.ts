import type { Rng } from "../../src/core/types";
import { resolvePhasePiloting } from "../../src/rules/game/pilotingPhase";
import type {
  BattleState,
  GameEvent,
  PhaseDealt,
  PhaseSnapshots,
  PilotingCheckReason,
} from "../../src/rules/game/types";
import { type DamageGroup, damageGroupsTotal } from "../../src/rules/physical";

/** Asymmetric matcher for an event's `groups`: their damage sums to `n`. */
export function groupsTotaling(n: number): {
  asymmetricMatch(groups: readonly DamageGroup[]): boolean;
  toString(): string;
} {
  return {
    asymmetricMatch: (groups) => damageGroupsTotal(groups) === n,
    toString: () => `groups totaling ${n}`,
  };
}

/**
 * Run the piloting sweep over a damage window opened on `before`, with
 * optional 20-point totals already marked, as an engine phase would.
 */
export function sweepPiloting(
  state: BattleState,
  rng: Rng,
  before: PhaseSnapshots,
  sink: GameEvent[],
  extraTriggers?: Readonly<
    Record<string, ReadonlyArray<{ reason: PilotingCheckReason; modifier: number }>>
  >,
  spareDfa = false,
  dealt: PhaseDealt = {},
): void {
  state.currentDealt = { before, total: { ...dealt }, byAttacker: {} };
  resolvePhasePiloting(state, rng, sink, extraTriggers, spareDfa);
}
