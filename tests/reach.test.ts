import { describe, expect, it } from "vitest";
import type { HexGrid } from "../src/core/terrain.js";
import type { Facing, HexCell, MoveMode } from "../src/core/types.js";
import type { MoveFragment } from "../src/rules/movement.js";
import { reachableLandings } from "../src/rules/movement.js";

// Start in the middle of a large board so the search radius is not clipped.
const start = { col: 12, row: 12 };
const startFacing: Facing = "n";
const noOccupants = () => undefined;
const team = 0;
const boardWidth = 21;
const boardHeight = 21;

/** Build a clear-terrain grid of the given size with per-hex "col,row" level overrides. */
function grid(width: number, height: number, levels: Record<string, number> = {}): HexGrid {
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

function reach(
  mode: MoveMode,
  walking: number,
  running: number,
  jumping: number,
  facing: Facing = startFacing,
  occupantTeam: (hex: { col: number; row: number }) => number | undefined = noOccupants,
  width: number = boardWidth,
  height: number = boardHeight,
  at: { col: number; row: number } = start,
  levels: Record<string, number> = {},
) {
  return reachableLandings(at, facing, {
    mode,
    walking,
    running,
    jumping,
    grid: grid(width, height, levels),
    team,
    occupantTeam,
  });
}

function lookup(
  rs: ReturnType<typeof reach>,
  hex: { col: number; row: number },
  facing: Facing,
): readonly MoveFragment[] | undefined {
  return rs.find((l) => l.hex.col === hex.col && l.hex.row === hex.row && l.facing === facing)
    ?.path;
}

describe("reachableLandings", () => {
  it("returns nothing for standstill", () => {
    expect(reach("standStill", 4, 6, 0)).toEqual([]);
  });

  it("includes the starting hex with the initial facing and an empty path", () => {
    const rs = reach("walk", 4, 6, 0);
    expect(lookup(rs, start, "n")).toEqual([]);
  });

  it("lists the start hex with every facing reachable by turns alone", () => {
    // Walk budget 4: the max single rotation is 3 hexsides, so all 6 facings
    // are reachable from the start purely by turning (no F/B). The initial
    // facing has an empty path (no movement); the other five have R/L-only
    // paths.
    const rs = reach("walk", 4, 6, 0);
    const others: Facing[] = ["ne", "se", "s", "sw", "nw"];
    for (const f of others) {
      const p = lookup(rs, start, f);
      expect(p).toBeDefined();
      expect(p!.length).toBeGreaterThan(0);
      expect(p!.every((x) => x === "R" || x === "L")).toBe(true);
    }
  });

  it("walks one MP forward or backward and keeps the original facing", () => {
    const rs = reach("walk", 1, 1, 0);
    expect(lookup(rs, { col: 12, row: 11 }, "n")).toEqual(["F"]);
    expect(lookup(rs, { col: 12, row: 13 }, "n")).toEqual(["B"]);
  });

  it("turns right to step diagonally forward within a two-MP walk", () => {
    // Two MP: turn right to ne (R, 1 MP) then forward to (13,12) (F, 1 MP).
    // (12,12) is an even column, so 'ne' steps one col over at the same row.
    const rs = reach("walk", 2, 2, 0);
    expect(lookup(rs, { col: 13, row: 12 }, "ne")).toEqual(["R", "F"]);
  });

  it("jump reaches the forward neighbor with F, side neighbors via free R/L + F", () => {
    const rs = reach("jump", 6, 8, 1);
    // Forward neighbor (current facing n): one F, no reorientation needed.
    expect(lookup(rs, { col: 12, row: 11 }, "n")).toEqual(["F"]);
    // Backward neighbor: B.
    expect(lookup(rs, { col: 12, row: 13 }, "n")).toEqual(["B"]);
    // Side neighbor ne: free turn R then F (the actual 1-MP jump step).
    // (12,12) is an even column, so 'ne' steps one col over at the same row.
    expect(lookup(rs, { col: 13, row: 12 }, "ne")).toEqual(["R", "F"]);
    // Side neighbor nw: free turn L then F — 'nw' steps one col over at the
    // same row.
    expect(lookup(rs, { col: 11, row: 12 }, "nw")).toEqual(["L", "F"]);
  });

  it("jump landing facing is free: every facing at the same cost", () => {
    // From the start, a single 1-MP jump step lands on (10,9); the final
    // facing is chosen freely, so all 6 facings at that hex cost exactly 1.
    const rs = reach("jump", 6, 8, 1);
    const hex = { col: 12, row: 11 };
    for (const f of ["n", "ne", "se", "s", "sw", "nw"] as const) {
      expect(lookup(rs, hex, f)).toBeDefined();
    }
  });

  it("passes through a friendly-occupied hex but does not land on it", () => {
    // Start (12, 12) facing "n" → forward neighbor is (12, 11). Put a
    // friendly unit at (12, 11) so the forward hex is passable but
    // not landable.
    const occupantTeam = (hex: { col: number; row: number }): number | undefined =>
      hex.col === 12 && hex.row === 11 ? 0 : undefined;
    const rs = reach("walk", 2, 2, 0, "n", occupantTeam);
    // The friendly-occupied hex is passable but never a landing.
    expect(lookup(rs, { col: 12, row: 11 }, "n")).toBeUndefined();
    // The hex beyond it remains reachable.
    expect(lookup(rs, { col: 12, row: 10 }, "n")).toBeDefined();
  });

  it("run with a one-MP budget only reaches the forward hex", () => {
    const rs = reach("run", 4, 1, 0);
    expect(lookup(rs, { col: 12, row: 11 }, "n")).toEqual(["F"]);
    // Backward is forbidden for run.
    expect(lookup(rs, { col: 12, row: 13 }, "n")).toBeUndefined();
  });

  it("clips reachable hexes to the board width and height", () => {
    // 13x13 board; start on the bottom-right edge (bottom-right in 1-based
    // coordinates is (13,13)).
    const rs = reachableLandings({ col: 13, row: 13 }, "n", {
      mode: "walk",
      walking: 4,
      running: 6,
      jumping: 0,
      grid: grid(13, 13),
      team: 0,
      occupantTeam: noOccupants,
    });
    expect(rs.length).toBeGreaterThan(0);
    for (const l of rs) {
      expect(l.hex.col).toBeGreaterThanOrEqual(1);
      expect(l.hex.row).toBeGreaterThanOrEqual(1);
      expect(l.hex.col).toBeLessThanOrEqual(13);
      expect(l.hex.row).toBeLessThanOrEqual(13);
    }
  });

  it("charges +1 MP per level climbed for ground moves", () => {
    // A two-MP walk onto a level-1 hex costs 2 (base 1 + climb 1).
    const rs = reach("walk", 2, 3, 0, "n", noOccupants, 21, 21, start, { "12,11": 1 });
    expect(lookup(rs, { col: 12, row: 11 }, "n")).toEqual(["F"]);
  });

  it("allows a +2 level ground step and rejects a +3", () => {
    // TW: a forward step may change up to 2 levels per hex.
    // Start at (12, 12) facing "n" → (12, 11). Put level 2 at (12, 11):
    // 1 base + 2 climb = 3 MP.
    const rs = reach("walk", 3, 4, 0, "n", noOccupants, 21, 21, start, { "12,11": 2 });
    expect(lookup(rs, { col: 12, row: 11 }, "n")).toEqual(["F"]);
    // A 3-level climb costs 4 MP but exceeds the per-hex cap.
    const rs3 = reach("walk", 4, 6, 0, "n", noOccupants, 21, 21, start, { "12,11": 3 });
    expect(lookup(rs3, { col: 12, row: 11 }, "n")).toBeUndefined();
  });

  it("charges +1 MP per level descended", () => {
    // Starting from a level-1 hex, walking forward onto a level-0 hex costs
    // 2 MP (1 base + 1 descent); a 1-MP walk cannot reach it.
    const desc = { "12,12": 1 };
    expect(
      lookup(
        reach("walk", 1, 1, 0, "n", noOccupants, 21, 21, start, desc),
        { col: 12, row: 11 },
        "n",
      ),
    ).toBeUndefined();
    expect(
      lookup(
        reach("walk", 2, 2, 0, "n", noOccupants, 21, 21, start, desc),
        { col: 12, row: 11 },
        "n",
      ),
    ).toEqual(["F"]);
  });

  it("rejects a forward step dropping more than 2 levels", () => {
    // TW caps forward level change at 2 per hex, up or down.
    const rs = reach("walk", 4, 6, 0, "n", noOccupants, 21, 21, start, { "12,12": 3 });
    expect(lookup(rs, { col: 12, row: 11 }, "n")).toBeUndefined();
  });

  it("rejects a backward step that changes level", () => {
    // TW: 'Mechs moving backward may not change levels.
    const up = reach("walk", 4, 6, 0, "n", noOccupants, 21, 21, start, { "12,13": 1 });
    expect(lookup(up, { col: 12, row: 13 }, "n")).toBeUndefined();
    const down = reach("walk", 4, 6, 0, "n", noOccupants, 21, 21, start, { "12,12": 1 });
    expect(lookup(down, { col: 12, row: 13 }, "n")).toBeUndefined();
  });

  it("jump ignores elevation and can change level freely", () => {
    // A single jump to a level-3 hex is reachable in 1 MP, even though no
    // ground step of 3 levels would be allowed.
    const rs = reach("jump", 6, 8, 1, "n", noOccupants, 21, 21, start, { "10,9": 3 });
    expect(lookup(rs, { col: 12, row: 11 }, "n")).toEqual(["F"]);
  });
});
