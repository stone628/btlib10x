import { describe, expect, it } from "vitest";
import { bearing, hexDistance, isAdjacent, lineHexes, neighbor, sameHex } from "../src/core/hex.js";
import { cellAt, type HexGrid } from "../src/core/terrain.js";
import type { HexCell } from "../src/core/types.js";

describe("hex geometry", () => {
  it("computes odd-q neighbors on flat-top hexes", () => {
    // even columns raised (matching the renderer stagger): an even-col 'ne'
    // goes one col over and one row up.
    const evenCol = { col: 4, row: 4 };
    expect(sameHex(neighbor(evenCol, "n"), { col: 4, row: 3 })).toBe(true);
    expect(sameHex(neighbor(evenCol, "s"), { col: 4, row: 5 })).toBe(true);
    expect(sameHex(neighbor(evenCol, "ne"), { col: 5, row: 3 })).toBe(true);
    expect(sameHex(neighbor(evenCol, "se"), { col: 5, row: 4 })).toBe(true);
    expect(sameHex(neighbor(evenCol, "nw"), { col: 3, row: 3 })).toBe(true);
    expect(sameHex(neighbor(evenCol, "sw"), { col: 3, row: 4 })).toBe(true);

    // odd columns lowered: an odd-col 'ne' goes one col over at the same row.
    const oddCol = { col: 5, row: 4 };
    expect(sameHex(neighbor(oddCol, "n"), { col: 5, row: 3 })).toBe(true);
    expect(sameHex(neighbor(oddCol, "s"), { col: 5, row: 5 })).toBe(true);
    expect(sameHex(neighbor(oddCol, "ne"), { col: 6, row: 4 })).toBe(true);
    expect(sameHex(neighbor(oddCol, "se"), { col: 6, row: 5 })).toBe(true);
    expect(sameHex(neighbor(oddCol, "nw"), { col: 4, row: 4 })).toBe(true);
    expect(sameHex(neighbor(oddCol, "sw"), { col: 4, row: 5 })).toBe(true);
  });

  it("measures distance in hexes", () => {
    expect(hexDistance({ col: 3, row: 3 }, { col: 3, row: 3 })).toBe(0);
    expect(hexDistance({ col: 3, row: 3 }, { col: 4, row: 3 })).toBe(1);
    expect(hexDistance({ col: 3, row: 3 }, { col: 5, row: 5 })).toBe(3);
  });

  it("traces straight lines excluding endpoints", () => {
    // Straight lines run along columns on flat-top grids.
    const line = lineHexes({ col: 3, row: 3 }, { col: 3, row: 8 });
    expect(line).toHaveLength(4);
    expect(line[0]).toEqual({ col: 3, row: 4 });
    expect(line[3]).toEqual({ col: 3, row: 7 });
  });

  it("approximates bearing toward non-adjacent hexes consistently with adjacency", () => {
    const from = { col: 7, row: 7 };
    const north = neighbor(from, "n");
    expect(bearing(from, north)).toBe("n");
    const southwest = neighbor(from, "sw");
    expect(bearing(from, southwest)).toBe("sw");

    expect(bearing({ col: 2, row: 2 }, { col: 2, row: -2 })).toBe("n");
    expect(bearing({ col: 2, row: 2 }, { col: 2, row: 6 })).toBe("s");
    expect(bearing({ col: 2, row: 2 }, { col: 2, row: 2 })).toBeNull();
  });

  it("reports adjacency symmetrically and excludes far hexes", () => {
    const a = { col: 5, row: 5 };
    expect(isAdjacent(a, a)).toBe(true);
    for (const f of ["n", "s", "ne", "se", "nw", "sw"] as const) {
      expect(isAdjacent(a, neighbor(a, f))).toBe(true);
    }
    expect(isAdjacent(a, { col: 6, row: 7 })).toBe(false);
    expect(isAdjacent(a, { col: 2, row: 2 })).toBe(false);
  });

  it("reads a cell off a grid and defaults to clear/level 0", () => {
    const width = 5;
    const height = 5;
    const cells: HexCell[] = new Array<HexCell>(width * height).fill({
      terrain: "clear",
      level: 0,
    });
    const grid: HexGrid = { cells, width, height };
    const hex = { col: 4, row: 5 };
    expect(cellAt(grid, hex).level).toBe(0);
    expect(cellAt(grid, hex).terrain).toBe("clear");
    // col 4, row 5 maps to index (4-1)+(5-1)*5 = 23
    cells[23] = { terrain: "lightWoods", level: 2 };
    expect(cellAt(grid, hex).level).toBe(2);
    expect(cellAt(grid, hex).terrain).toBe("lightWoods");
  });
});
