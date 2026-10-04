import { describe, expect, it } from "vitest";
import { cellAt } from "../src/core/terrain";
import { mechDefFor } from "../src/data/index";
import { effectiveMovement } from "../src/rules/critical";
import type { GameEvent } from "../src/rules/game";
import { executeMove, requireUnit, rollInitiativePhase } from "../src/rules/game";
import { losClear } from "../src/rules/los";
import { reachableLandings } from "../src/rules/movement";
import { createTestBattle, scriptedRng } from "./helpers";

function battle(terrain: Parameters<typeof createTestBattle>[0], startType?: string) {
  const state = createTestBattle(
    terrain,
    [
      {
        id: "enf",
        model: "ENF-4R",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 2 },
        facing: "s",
      },
      {
        id: "hbk",
        model: "HBK-4G",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 1, row: 1 },
        facing: "s",
      },
    ],
    true,
  );
  void startType;
  rollInitiativePhase(state, scriptedRng(2, 2, 5, 5), []);
  return state;
}

describe("running and water (TW p.53, p.57)", () => {
  const terrain = [{ col: 2, row: 3, type: "water1" as const, level: 0 }];

  it("executeMove rejects a run that enters water", () => {
    const state = battle([...terrain, { col: 2, row: 4, type: "clear", level: 0 }]);
    expect(() =>
      executeMove(
        state,
        "enf",
        "run",
        [
          { kind: "enter", to: { col: 2, row: 3 } },
          { kind: "enter", to: { col: 2, row: 4 } },
        ],
        [],
      ),
    ).toThrow(/cannot enter water/);
  });

  it("minimum movement may still enter a single water hex", () => {
    const state = battle(terrain);
    const events: GameEvent[] = [];
    executeMove(state, "enf", "run", [{ kind: "enter", to: { col: 2, row: 3 } }], events, {
      rng: scriptedRng(6, 6, 6, 6),
    });
    expect(requireUnit(state, "enf").position).toEqual({ col: 2, row: 3 });
  });

  it("reachableLandings omits water when running but not when walking", () => {
    const state = battle(terrain);
    const base = {
      walking: 5,
      running: 8,
      jumping: 0,
      prone: false,
      grid: state,
      team: 0,
      occupantTeam: () => undefined,
    } as const;
    const run = reachableLandings({ col: 2, row: 2 }, "s", { ...base, mode: "run" });
    const walk = reachableLandings({ col: 2, row: 2 }, "s", { ...base, mode: "walk" });
    const isWater = (l: { hex: { col: number; row: number } }) =>
      l.hex.col === 2 && l.hex.row === 3;
    // Only the minimum-movement landing (1 hex ahead) reaches water on a run.
    expect(run.filter(isWater).length).toBe(1);
    // No other run path crosses the water hex.
    expect(
      run.filter((l) => !isWater(l) && l.path.some((p) => p.terrain === "water1")).length,
    ).toBe(0);
    expect(walk.filter(isWater).length).toBeGreaterThan(0);
  });
});

describe("jumping and water (TW p.53)", () => {
  it("depth 2+ forbids jumping; depth 1 loses leg-mounted jets", () => {
    const state = battle([]);
    const unit = requireUnit(state, "enf");
    const def = mechDefFor(unit);
    expect(effectiveMovement(def, unit.damage, unit.critSlotsDestroyed, false, 0).jumping).toBe(4);
    expect(effectiveMovement(def, unit.damage, unit.critSlotsDestroyed, false, 2).jumping).toBe(0);
    // ENF-4R mounts all four jets in its legs.
    expect(effectiveMovement(def, unit.damage, unit.critSlotsDestroyed, false, 1).jumping).toBe(0);
  });

  it("a 'Mech standing in depth 2 water cannot jump out", () => {
    const state = battle([{ col: 2, row: 2, type: "water2", level: 0 }]);
    expect(() =>
      executeMove(state, "enf", "jump", [{ kind: "enter", to: { col: 3, row: 2 } }], []),
    ).toThrow(/budget is 0/);
  });
});

describe("prone 'Mech in depth 1 water blocks LOS (TW p.102)", () => {
  it("blocks only when the water-1 endpoint is prone", () => {
    const state = battle([{ col: 2, row: 3, type: "water1", level: 0 }]);
    expect(cellAt(state, { col: 2, row: 3 }).terrain).toBe("water1");
    const from = { col: 2, row: 2 };
    const to = { col: 2, row: 3 };
    expect(losClear(state, from, to, state.wrecks)).toBe(true);
    expect(losClear(state, from, to, state.wrecks, { to: false })).toBe(true);
    expect(losClear(state, from, to, state.wrecks, { to: true })).toBe(false);
    expect(losClear(state, to, from, state.wrecks, { from: true })).toBe(false);
  });
});
