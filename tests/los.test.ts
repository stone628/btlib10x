import { describe, expect, it } from "vitest";
import type { HexGrid } from "../src/core/terrain";
import type { HexCell } from "../src/core/types";
import { losBlockedByBuilding, losBlockedByElevation, losClear } from "../src/rules/los";

/** Build a 5x5 grid with the given per-hex "col,row" elevation overrides (others 0). */
function gridWithElevation(levels: Record<string, number>): HexGrid {
  const width = 5;
  const height = 5;
  const cells: HexCell[] = new Array<HexCell>(width * height).fill({
    terrain: "clear",
    level: 0,
  });
  for (const [key, level] of Object.entries(levels)) {
    const [col, row] = key.split(",").map(Number);
    cells[col! - 1 + (row! - 1) * width] = { terrain: "clear", level };
  }
  return { cells, width, height };
}

/** 5x5 grid with `lightBuilding` terrain on the given hexes (elevations otherwise 0). */
function gridWithBuildings(buildings: string[], levels: Record<string, number> = {}): HexGrid {
  const width = 5;
  const height = 5;
  const cells: HexCell[] = new Array<HexCell>(width * height).fill({
    terrain: "clear",
    level: 0,
  });
  for (const [key, level] of Object.entries(levels)) {
    const [col, row] = key.split(",").map(Number);
    cells[col! - 1 + (row! - 1) * width] = { terrain: "clear", level };
  }
  for (const key of buildings) {
    const [col, row] = key.split(",").map(Number);
    const level = levels[key] ?? 0;
    cells[col! - 1 + (row! - 1) * width] = { terrain: "lightBuilding", level };
  }
  return { cells, width, height };
}

describe("losBlockedByElevation", () => {
  it("a level-0 attacker can see a level-0 target across a clear valley", () => {
    const grid = gridWithElevation({});
    expect(losBlockedByElevation(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
  });

  it("a tall ridge blocks LOS between two level-0 'Mechs two hexes apart", () => {
    // Ridge at (3,2) level 3; attacker at (2,2) L0; target at (4,2) L0.
    // Eye-level ray sits at LOS level 2; the ridge's top is at level 3,
    // which strictly exceeds the ray → blocks.
    const grid = gridWithElevation({ "3,2": 3 });
    expect(losBlockedByElevation(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
  });

  it("a level-2 attacker can see a level-0 target over a level-1 ridge", () => {
    // Attacker at (2,2) L2, ridge at (3,2) L1, target at (4,2) L0. Ray goes
    // from LOS level 3 down to LOS level 1, so at the ridge's center it sits
    // at 2; ridge top is at 2, which does not strictly exceed the ray → clear.
    const grid = gridWithElevation({ "2,2": 2, "3,2": 1, "4,2": 0 });
    expect(losBlockedByElevation(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
  });

  it("a tall intervening peak blocks LOS even from a higher attacker", () => {
    // Attacker at (2,2) L1, peak at (3,2) L5, target at (4,2) L0.
    // Ray from LOS 2 to LOS 1 is essentially flat; peak top is L6, well
    // above the ray → blocks.
    const grid = gridWithElevation({ "2,2": 1, "3,2": 5, "4,2": 0 });
    expect(losBlockedByElevation(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
  });
});

describe("losBlockedByBuilding", () => {
  it("an intervening tall building blocks LOS between two level-0 'Mechs", () => {
    // Building at (3,2) level 1 between attacker (2,2) L0 and target (4,2) L0;
    // default 2-level building top sits at level 3, the eye-level ray at 2 →
    // blocked. (Default L0 building tops at L2 equal to the eye-level ray and
    // does not strictly exceed it — the codebase's ray abstraction requires
    // the building top to clear the eye-level ray.)
    const grid = gridWithBuildings(["3,2"], { "3,2": 1 });
    expect(losBlockedByBuilding(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
    expect(losClear(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
  });

  it("elevation folds building blocking into the ray: a level-2 attacker sees over", () => {
    // Attacker (2,2) L2 (LOS 3), building (3,2) top L2, target (4,2) L0.
    // Ray at the building's center is 2, which does not strictly exceed → clear.
    const grid = gridWithBuildings(["3,2"], { "2,2": 2 });
    expect(losBlockedByBuilding(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
    expect(losBlockedByElevation(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
    expect(losClear(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
  });

  it("the building hex a unit occupies is not intervening", () => {
    // Attacker inside the building at (2,2); only clear (3,2) lies between it
    // and the target (4,2) → fire out of the building stays legal.
    const grid = gridWithBuildings(["2,2"]);
    expect(losBlockedByBuilding(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
    expect(losClear(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
  });
});

describe("losClear", () => {
  it("passes when both woods and elevation are clear", () => {
    expect(losClear(gridWithElevation({}), { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
  });

  it("fails when elevation blocks even with no woods", () => {
    // Tall ridge at (3,2) level 3; eye-level ray at 2 is strictly exceeded.
    const grid = gridWithElevation({ "3,2": 3 });
    expect(losClear(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
  });
});
