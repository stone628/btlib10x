import { describe, expect, it } from "vitest";
import type { HexGrid } from "../src/core/terrain.js";
import type { HexCell } from "../src/core/types.js";
import {
  applyBuildingDamage,
  buildingTypeOf,
  createBuildingState,
  isBuildingTerrain,
  isCollapsed,
} from "../src/rules/building.js";
import {
  type BattleState,
  damageBuildingAt,
  type TerrainHexDef,
  type UnitInit,
} from "../src/rules/game.js";
import { losBlockedByWater } from "../src/rules/los.js";
import { createTestBattle } from "./helpers.js";

describe("buildingTypeOf", () => {
  it("maps each building terrain to its sub-type", () => {
    expect(buildingTypeOf("lightBuilding")).toBe("light");
    expect(buildingTypeOf("mediumBuilding")).toBe("medium");
    expect(buildingTypeOf("heavyBuilding")).toBe("heavy");
    expect(buildingTypeOf("hardenedBuilding")).toBe("hardened");
  });

  it("returns undefined for non-building terrain", () => {
    expect(buildingTypeOf("clear")).toBeUndefined();
    expect(buildingTypeOf("lightWoods")).toBeUndefined();
    expect(buildingTypeOf("water1")).toBeUndefined();
  });
});

describe("isBuildingTerrain", () => {
  it("recognizes building and non-building terrain", () => {
    expect(isBuildingTerrain("lightBuilding")).toBe(true);
    expect(isBuildingTerrain("hardenedBuilding")).toBe(true);
    expect(isBuildingTerrain("clear")).toBe(false);
    expect(isBuildingTerrain("rough")).toBe(false);
  });
});

describe("building damage and collapse", () => {
  it("applies damage to the structural factor", () => {
    const b = createBuildingState("light"); // CF 15
    expect(applyBuildingDamage(b, 5).cf).toBe(10);
  });

  it("clamps CF at 0 (collapse) and reports collapsed", () => {
    const b = createBuildingState("light");
    const collapsed = applyBuildingDamage(b, 20);
    expect(collapsed.cf).toBe(0);
    expect(isCollapsed(collapsed)).toBe(true);
  });

  it("hardened buildings start at the highest CF", () => {
    expect(createBuildingState("hardened").cf).toBe(150);
  });
});

function gridWithTerrain(entries: readonly [string, number, number][]): HexGrid {
  const width = 5;
  const height = 5;
  const cells: HexCell[] = new Array<HexCell>(width * height).fill({
    terrain: "clear",
    level: 0,
  });
  for (const [type, col, row] of entries) {
    cells[col - 1 + (row - 1) * width] = { terrain: type as HexCell["terrain"], level: 0 };
  }
  return { cells, width, height };
}

describe("water LOS blocking", () => {
  it("water2 blocks LOS in and out", () => {
    const grid = gridWithTerrain([["water2", 2, 2]]);
    expect(losBlockedByWater(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
    expect(losBlockedByWater(grid, { col: 4, row: 2 }, { col: 2, row: 2 })).toBe(true);
  });

  it("water3 blocks LOS in and out", () => {
    const grid = gridWithTerrain([["water3", 2, 2]]);
    expect(losBlockedByWater(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
  });

  it("water1 and clear do not block LOS in/out", () => {
    const grid = gridWithTerrain([["water1", 2, 2]]);
    expect(losBlockedByWater(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
    expect(losBlockedByWater(grid, { col: 4, row: 2 }, { col: 2, row: 2 })).toBe(false);
  });
});

function battleWithBuilding(): BattleState {
  const units: UnitInit[] = [
    {
      id: "a",
      model: "HBK-4G",
      team: 0,
      gunnery: 4,
      position: { col: 2, row: 3 },
      facing: "se",
    },
    {
      id: "b",
      model: "ENF-4R",
      team: 1,
      gunnery: 4,
      position: { col: 2, row: 1 },
      facing: "sw",
    },
  ];
  const terrain: readonly TerrainHexDef[] = [{ col: 3, row: 3, type: "lightBuilding" }];
  return createTestBattle(terrain, units, true);
}

describe("battle building integration", () => {
  it("initializes building state from terrain", () => {
    const battle = battleWithBuilding();
    expect(battle.buildings["3,3"]).toEqual({ cf: 15, type: "light" });
  });

  it("damaging a building below its CF does not collapse it", () => {
    const battle = battleWithBuilding();
    const result = damageBuildingAt(battle, { col: 3, row: 3 }, 5);
    expect(result).toBeNull();
    expect(battle.buildings["3,3"]?.cf).toBe(10);
  });

  it("reduces a building to rubble when its CF reaches zero", () => {
    const battle = battleWithBuilding();
    const result = damageBuildingAt(battle, { col: 3, row: 3 }, 15);
    expect(result).toEqual({ kind: "buildingCollapsed", col: 3, row: 3 });
    expect(battle.buildings["3,3"]).toBeUndefined();
    // width = max(3,3)+1 = 4, so index of (3,3) is (3-1)+(3-1)*4 = 10.
    expect(battle.cells[10]!.terrain).toBe("rubble");
    expect(battle.events.some((e) => e.kind === "buildingCollapsed")).toBe(true);
  });

  it("ignores damage to non-building hexes", () => {
    const battle = battleWithBuilding();
    expect(damageBuildingAt(battle, { col: 2, row: 3 }, 100)).toBeNull();
  });
});
