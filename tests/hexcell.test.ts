import { describe, expect, it } from "vitest";
import { hexCell } from "../src/core/terrain";
import { loadBattleState, parseBattleState, saveBattleState } from "../src/index";
import { buildUnitInit, damageBuildingAt } from "../src/rules/game";
import { createTestBattle } from "./helpers";

function battle() {
  return createTestBattle(
    [
      { col: 3, row: 3, type: "lightBuilding", level: 1 },
      { col: 4, row: 3, type: "heavyWoods" },
    ],
    [
      buildUnitInit("a", "HBK-4G", 1, { col: 1, row: 1 }, "n"),
      buildUnitInit("b", "ENF-4R", 2, { col: 6, row: 6 }, "s"),
    ],
    true,
  );
}

describe("hexCell registry", () => {
  it("returns one shared instance per terrain/level pair", () => {
    expect(hexCell("clear")).toBe(hexCell("clear", 0));
    expect(hexCell("clear", 1)).not.toBe(hexCell("clear", 0));
    expect(hexCell("lightWoods")).not.toBe(hexCell("heavyWoods"));
    expect(hexCell("lightWoods", 2)).toEqual({ terrain: "lightWoods", level: 2 });
  });

  it("createBattle shares cells within and across battles", () => {
    const a = battle();
    const b = battle();
    expect(a.cells[0]).toBe(hexCell("clear"));
    expect(a.cells[0]).toBe(a.cells[1]);
    expect(a.cells[0]).toBe(b.cells[0]);
    expect(a.cells[2 + 2 * a.width]).toBe(hexCell("lightBuilding", 1));
  });

  it("stores the shared rubble cell when a building collapses", () => {
    const state = battle();
    damageBuildingAt(state, { col: 3, row: 3 }, 999, []);
    expect(state.cells[2 + 2 * state.width]).toBe(hexCell("rubble", 1));
  });

  it("snapshot load restores shared instances", () => {
    const state = battle();
    const snap = saveBattleState(state);
    damageBuildingAt(state, { col: 3, row: 3 }, 999, []);
    loadBattleState(state, snap);
    state.cells.forEach((cell) => {
      expect(cell).toBe(hexCell(cell.terrain, cell.level));
    });
    expect(state.cells[2 + 2 * state.width]).toBe(hexCell("lightBuilding", 1));
    expect(parseBattleState(snap)).toEqual(state);
  });
});
