import { describe, expect, it } from "vitest";
import { neighbor } from "../src/core/hex";
import type { HexCell } from "../src/core/types";
import type { BattleState, GameEvent, UnitInit } from "../src/rules/game";
import { buildUnitInit, executeMove, requireUnit, rollInitiativePhase } from "../src/rules/game";
import { reachableLandings } from "../src/rules/movement";
import { createTestBattle, scriptedRng } from "./helpers";

// TW p.49 minimum movement: a unit with >= 1 MP may always enter the hex
// directly ahead (only expenditure, no facing change), counted as running.

const startHex = { col: 3, row: 3 };
const ahead = neighbor(startHex, "n");

/** HBK-4G (walk 4) alone-ish on a board with heavy woods (3 MP) straight ahead. */
function woodsBattle(): BattleState {
  const units: UnitInit[] = [
    buildUnitInit("a", "HBK-4G", 0, startHex, "n"),
    buildUnitInit("b", "ENF-4R", 1, { col: 6, row: 6 }, "n"),
  ];
  const state = createTestBattle(
    [{ col: ahead.col, row: ahead.row, type: "heavyWoods" }],
    units,
    true,
  );
  rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
  return state;
}

function heatReduceToWalk1(state: BattleState): void {
  requireUnit(state, "a").heat = 15; // -3 walking MP: 4 -> 1, run ceil(1.5) = 2 < 3
}

function loseLeg(state: BattleState): void {
  const d = requireUnit(state, "a").damage;
  d.armor.leftLeg = 0;
  d.internalStructure.leftLeg = 0;
}

const woodsGrid = (): { cells: HexCell[]; width: number; height: number } => {
  const width = 6;
  const height = 6;
  const cells: HexCell[] = new Array<HexCell>(width * height).fill({ terrain: "clear", level: 0 });
  cells[ahead.col - 1 + (ahead.row - 1) * width] = { terrain: "heavyWoods", level: 0 };
  return { cells, width, height };
};

const reach = (mode: "walk" | "run", walking: number, running: number) =>
  reachableLandings(startHex, "n", {
    mode,
    walking,
    running,
    jumping: 0,
    prone: false,
    grid: woodsGrid(),
    team: 0,
    occupantTeam: () => undefined,
  });

describe("minimum movement: reachableLandings", () => {
  it("offers the forward woods hex to a 1-MP run (budget 2 < cost 3)", () => {
    const rs = reach("run", 1, 2);
    const fwd = rs.find((l) => l.hex.col === ahead.col && l.hex.row === ahead.row);
    expect(fwd?.facing).toBe("n");
    expect(fwd?.path.map((p) => p.fragment)).toEqual(["U"]);
    expect(fwd?.path[0]?.baseMp).toBe(2);
  });

  it("one-leg style (walk 1, run 0) still gets the forward hex, charged 1", () => {
    const rs = reach("run", 1, 0);
    const fwd = rs.find((l) => l.hex.col === ahead.col && l.hex.row === ahead.row);
    expect(fwd?.path[0]?.baseMp).toBe(1);
    // nothing but the start hex and that single entry
    expect(rs.every((l) => l.path.length === 0 || l.path.length === 1)).toBe(true);
  });

  it("does not apply with 0 walking MP, in walk mode, or when the hex is affordable", () => {
    expect(reach("run", 0, 0)).toEqual([]);
    expect(
      reach("walk", 1, 2).some((l) => l.hex.col === ahead.col && l.hex.row === ahead.row),
    ).toBe(false);
    const rich = reach("run", 4, 6).filter(
      (l) => l.hex.col === ahead.col && l.hex.row === ahead.row,
    );
    expect(rich.every((l) => l.path.length >= 1)).toBe(true);
    expect(rich.length).toBeGreaterThan(0); // normal BFS reaches it, no duplicate landing
    const keys = rich.map((l) => l.facing);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("minimum movement: executeMove", () => {
  it("allows one forward step into heavy woods at 1 walking MP as a run", () => {
    const state = woodsBattle();
    heatReduceToWalk1(state);
    const events: GameEvent[] = [];
    executeMove(state, "a", "run", [{ kind: "enter", to: ahead }], events, {
      rng: scriptedRng(6, 6),
    });
    const u = requireUnit(state, "a");
    expect(u.position).toEqual(ahead);
    expect(u.mpSpent).toBe(2); // capped at the run budget, not the 3 MP terrain cost
    expect(u.moveMode).toBe("run");
    expect(u.heatPending).toBeGreaterThanOrEqual(2);
  });

  it("still rejects two steps (woods then clear) at 1 MP", () => {
    const state = woodsBattle();
    heatReduceToWalk1(state);
    expect(() =>
      executeMove(
        state,
        "a",
        "run",
        [
          { kind: "enter", to: ahead },
          { kind: "enter", to: neighbor(ahead, "n") },
        ],
        [],
      ),
    ).toThrow(/budget/);
  });

  it("rejects an affordable-looking backward step and 0-MP units", () => {
    const state = woodsBattle();
    heatReduceToWalk1(state);
    expect(() =>
      executeMove(state, "a", "run", [{ kind: "enter", to: neighbor(startHex, "s") }], []),
    ).toThrow();
    const zero = woodsBattle();
    requireUnit(zero, "a").heat = 30;
    expect(() => executeMove(zero, "a", "run", [{ kind: "enter", to: ahead }], [])).toThrow();
  });

  it("one-leg 'Mech may run only as a single forward hex (TW p.122 + p.49)", () => {
    const state = woodsBattle();
    loseLeg(state);
    const events: GameEvent[] = [];
    executeMove(state, "a", "run", [{ kind: "enter", to: ahead }], events, {
      rng: scriptedRng(6, 6, 6, 6),
    });
    expect(requireUnit(state, "a").mpSpent).toBe(1);

    const other = woodsBattle();
    loseLeg(other);
    const far = neighbor(neighbor(startHex, "n"), "n");
    expect(() =>
      executeMove(
        other,
        "a",
        "run",
        [
          { kind: "enter", to: neighbor(startHex, "n") },
          { kind: "enter", to: far },
        ],
        [],
      ),
    ).toThrow(/cannot run/);
  });
});
