/**
 * Engagement modes (docs/INSTANT.md "Victory"). The engine never decides the winner: both
 * modes are stoppers handed to `gameLoop`, and the tallies are read from unit
 * state.
 *
 * - Annihilation (`destroyAll`; Standup Fight, TW p. 259): ends when one side
 *   has no unit left in play.
 * - Attrition (`damageRace`): ends after turn N (or earlier like Annihilation); the side
 *   that dealt more armor + structure damage wins, ties go to the TW p. 257
 *   BV score, then a draw. A destroyed unit or a hull counts its whole total.
 */
import { type BattleState, isUnitRemoved, scoreReport, type UnitState } from "btlib10x";

export type VictoryMode = { kind: "destroyAll" } | { kind: "damageRace"; turns: number };

export interface SideTally {
  readonly team: number;
  /** Armor + structure the other side's units lost. */
  readonly dealt: number;
  /** Armor + structure this side's units lost. */
  readonly taken: number;
  readonly lost: number;
  readonly units: number;
  /** TW p. 257 Battle Value score. */
  readonly score: number;
}

/** What settled the result: a side left alone in play, Attrition's damage
 *  total, its BV score tiebreak, or a tie on both. */
export type DecidedBy = "elimination" | "damage" | "score" | "tie";

export interface BattleResult {
  readonly winnerTeam: number | null;
  readonly decidedBy: DecidedBy;
  readonly turn: number;
  readonly sides: readonly SideTally[];
}

function unitTotal(u: UnitState): number {
  let n = 0;
  for (const v of Object.values(u.damage.armor)) n += Math.max(0, v);
  for (const v of Object.values(u.damage.armorRear)) n += Math.max(0, v);
  for (const v of Object.values(u.damage.internalStructure)) n += Math.max(0, v);
  return n;
}

/** Armor + structure of every unit at battle start. */
export function startTotals(state: BattleState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of Object.values(state.units)) out[u.id] = unitTotal(u);
  return out;
}

/** Points a unit has lost: its whole total once destroyed or left as a hull. */
export function unitLoss(u: UnitState, totals: Readonly<Record<string, number>>): number {
  const start = totals[u.id] ?? 0;
  if (isUnitRemoved(u)) return start;
  return Math.max(0, start - unitTotal(u));
}

function teamsAlive(state: BattleState): Set<number> {
  return new Set(
    Object.values(state.units)
      .filter((u) => !isUnitRemoved(u))
      .map((u) => u.team),
  );
}

export function makeStopper(mode: VictoryMode): (state: BattleState) => boolean {
  return (state) => {
    if (teamsAlive(state).size <= 1) return true;
    return mode.kind === "damageRace" && state.phase === "initiative" && state.turn > mode.turns;
  };
}

export function tallies(state: BattleState, totals: Readonly<Record<string, number>>): SideTally[] {
  const score = new Map(scoreReport(state).map((s) => [s.team, s.score]));
  return [1, 2].map((team) => {
    let dealt = 0;
    let taken = 0;
    let lost = 0;
    let units = 0;
    for (const u of Object.values(state.units)) {
      const loss = unitLoss(u, totals);
      if (u.team === team) {
        taken += loss;
        units += 1;
        if (isUnitRemoved(u)) lost += 1;
      } else dealt += loss;
    }
    return { team, dealt, taken, lost, units, score: score.get(team) ?? 0 };
  });
}

export function battleResult(
  state: BattleState,
  mode: VictoryMode,
  totals: Readonly<Record<string, number>>,
): BattleResult {
  const sides = tallies(state, totals);
  const alive = teamsAlive(state);
  const turn = mode.kind === "damageRace" ? Math.min(state.turn, mode.turns) : state.turn;
  if (alive.size <= 1) {
    const winnerTeam = alive.size === 1 ? [...alive][0]! : null;
    return { winnerTeam, decidedBy: "elimination", turn, sides };
  }
  const [a, b] = sides as [SideTally, SideTally];
  if (a.dealt !== b.dealt)
    return { winnerTeam: a.dealt > b.dealt ? a.team : b.team, decidedBy: "damage", turn, sides };
  if (a.score !== b.score)
    return { winnerTeam: a.score > b.score ? a.team : b.team, decidedBy: "score", turn, sides };
  return { winnerTeam: null, decidedBy: "tie", turn, sides };
}
