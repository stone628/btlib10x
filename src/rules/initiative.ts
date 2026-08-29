import { roll2D6 } from "../core/dice.js";
import type { Rng } from "../core/types.js";

export interface InitiativeResult {
  readonly rolls: Readonly<Record<number, number>>;
  readonly winnerTeam: number;
}

/** Each team rolls 2D6; highest wins; ties reroll all dice. */
export function rollInitiative(teams: readonly number[], rng: Rng): InitiativeResult {
  if (teams.length < 2) throw new Error("Initiative requires at least two teams");
  const rolls: Record<number, number> = {};
  let best: number[] = [];
  let bestValue = -1;
  do {
    best = [];
    bestValue = -1;
    for (const team of teams) {
      const value = roll2D6(rng);
      rolls[team] = value;
      if (value > bestValue) {
        bestValue = value;
        best = [team];
      } else if (value === bestValue) {
        best.push(team);
      }
    }
  } while (best.length > 1);
  return { rolls, winnerTeam: best[0]! };
}
