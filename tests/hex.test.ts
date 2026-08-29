import { describe, expect, it } from "vitest";
import { bearing, hexDistance, isAdjacent, lineHexes, neighbor, sameHex } from "../src/core/hex.js";
import { DEFAULT_LEVEL, levelAt } from "../src/core/terrain.js";

describe("hex geometry", () => {
  it("computes odd-q neighbors on flat-top hexes", () => {
    const evenCol = { col: 2, row: 3 };
    expect(sameHex(neighbor(evenCol, "n"), { col: 2, row: 2 })).toBe(true);
    expect(sameHex(neighbor(evenCol, "s"), { col: 2, row: 4 })).toBe(true);
    expect(sameHex(neighbor(evenCol, "ne"), { col: 3, row: 3 })).toBe(true);
    expect(sameHex(neighbor(evenCol, "se"), { col: 3, row: 4 })).toBe(true);
    expect(sameHex(neighbor(evenCol, "nw"), { col: 1, row: 3 })).toBe(true);
    expect(sameHex(neighbor(evenCol, "sw"), { col: 1, row: 4 })).toBe(true);

    const oddCol = { col: 3, row: 3 };
    expect(sameHex(neighbor(oddCol, "n"), { col: 3, row: 2 })).toBe(true);
    expect(sameHex(neighbor(oddCol, "s"), { col: 3, row: 4 })).toBe(true);
    expect(sameHex(neighbor(oddCol, "ne"), { col: 4, row: 2 })).toBe(true);
    expect(sameHex(neighbor(oddCol, "se"), { col: 4, row: 3 })).toBe(true);
    expect(sameHex(neighbor(oddCol, "nw"), { col: 2, row: 2 })).toBe(true);
    expect(sameHex(neighbor(oddCol, "sw"), { col: 2, row: 3 })).toBe(true);
  });

  it("measures distance in hexes", () => {
    expect(hexDistance({ col: 1, row: 1 }, { col: 1, row: 1 })).toBe(0);
    expect(hexDistance({ col: 1, row: 1 }, { col: 2, row: 1 })).toBe(1);
    expect(hexDistance({ col: 1, row: 1 }, { col: 3, row: 3 })).toBe(3);
  });

  it("traces straight lines excluding endpoints", () => {
    // Straight lines run along columns on flat-top grids.
    const line = lineHexes({ col: 1, row: 1 }, { col: 1, row: 6 });
    expect(line).toHaveLength(4);
    expect(line[0]).toEqual({ col: 1, row: 2 });
    expect(line[3]).toEqual({ col: 1, row: 5 });
  });

  it("approximates bearing toward non-adjacent hexes consistently with adjacency", () => {
    const from = { col: 5, row: 5 };
    const north = neighbor(from, "n");
    expect(bearing(from, north)).toBe("n");
    const southwest = neighbor(from, "sw");
    expect(bearing(from, southwest)).toBe("sw");

    expect(bearing({ col: 0, row: 0 }, { col: 0, row: -4 })).toBe("n");
    expect(bearing({ col: 0, row: 0 }, { col: 0, row: 4 })).toBe("s");
    expect(bearing({ col: 0, row: 0 }, { col: 0, row: 0 })).toBeNull();
  });

  it("reports adjacency symmetrically and excludes far hexes", () => {
    const a = { col: 3, row: 3 };
    expect(isAdjacent(a, a)).toBe(true);
    for (const f of ["n", "s", "ne", "se", "nw", "sw"] as const) {
      expect(isAdjacent(a, neighbor(a, f))).toBe(true);
    }
    expect(isAdjacent(a, { col: 4, row: 5 })).toBe(false);
    expect(isAdjacent(a, { col: 0, row: 0 })).toBe(false);
  });

  it("reads elevation off a per-hex map and defaults to 0", () => {
    const hex = { col: 2, row: 3 };
    expect(levelAt({}, hex)).toBe(DEFAULT_LEVEL);
    expect(levelAt({ "2,3": 2 }, hex)).toBe(2);
  });
});
