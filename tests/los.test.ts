import { describe, expect, it } from "vitest";
import type { HexGrid } from "../src/core/terrain.js";
import type { HexCell } from "../src/core/types.js";
import { losBlockedByElevation, losClear } from "../src/rules/los.js";

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

describe("losBlockedByElevation", () => {
  it("a level-0 attacker can see a level-0 target across a clear valley", () => {
    const grid = gridWithElevation({});
    expect(losBlockedByElevation(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
  });

  it("a level-1 ridge blocks LOS between two level-0 'Mechs two hexes apart", () => {
    // Ridge at (3,2); attacker at (2,2); target at (4,2). The ray sits at
    // LOS level 1 (hex level + 1, since both endpoints are level 0); the
    // ridge's top is at level 2, which meets/exceeds the ray → blocks.
    const grid = gridWithElevation({ "3,2": 1 });
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

describe("losClear", () => {
  it("passes when both woods and elevation are clear", () => {
    expect(losClear(gridWithElevation({}), { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
  });

  it("fails when elevation blocks even with no woods", () => {
    const grid = gridWithElevation({ "3,2": 1 });
    expect(losClear(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
  });
});
