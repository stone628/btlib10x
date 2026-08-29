import { describe, expect, it } from "vitest";
import type { Facing, MoveMode } from "../src/core/types.js";
import type { MoveFragment } from "../src/rules/movement.js";
import { reachableLandings } from "../src/rules/movement.js";

const clear = {};
// Start in the middle of a large board so the search radius is not clipped.
const start = { col: 10, row: 10 };
const startFacing: Facing = "n";
const noOccupants = () => undefined;
const team = 0;
const boardWidth = 21;
const boardHeight = 21;

function reach(
  mode: MoveMode,
  walking: number,
  running: number,
  jumping: number,
  facing: Facing = startFacing,
  terrain: Record<string, never> = clear,
  occupantTeam: (hex: { col: number; row: number }) => number | undefined = noOccupants,
  width: number = boardWidth,
  height: number = boardHeight,
  at: { col: number; row: number } = start,
) {
  return reachableLandings(at, facing, {
    mode,
    walking,
    running,
    jumping,
    terrain,
    team,
    occupantTeam,
    width,
    height,
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
    expect(lookup(rs, { col: 10, row: 9 }, "n")).toEqual(["F"]);
    expect(lookup(rs, { col: 10, row: 11 }, "n")).toEqual(["B"]);
  });

  it("turns right to step diagonally forward within a two-MP walk", () => {
    // Two MP: turn right to ne (R, 1 MP) then forward to (11,10) (F, 1 MP).
    const rs = reach("walk", 2, 2, 0);
    expect(lookup(rs, { col: 11, row: 10 }, "ne")).toEqual(["R", "F"]);
  });

  it("jump reaches the forward neighbor with F, side neighbors via free R/L + F", () => {
    const rs = reach("jump", 6, 8, 1);
    // Forward neighbor (current facing n): one F, no reorientation needed.
    expect(lookup(rs, { col: 10, row: 9 }, "n")).toEqual(["F"]);
    // Backward neighbor: B.
    expect(lookup(rs, { col: 10, row: 11 }, "n")).toEqual(["B"]);
    // Side neighbor ne: free turn R then F (the actual 1-MP jump step).
    expect(lookup(rs, { col: 11, row: 10 }, "ne")).toEqual(["R", "F"]);
    // Side neighbor nw: free turn L then F.
    expect(lookup(rs, { col: 9, row: 10 }, "nw")).toEqual(["L", "F"]);
  });

  it("jump landing facing is free: every facing at the same cost", () => {
    // From the start, a single 1-MP jump step lands on (10,9); the final
    // facing is chosen freely, so all 6 facings at that hex cost exactly 1.
    const rs = reach("jump", 6, 8, 1);
    const hex = { col: 10, row: 9 };
    for (const f of ["n", "ne", "se", "s", "sw", "nw"] as const) {
      expect(lookup(rs, hex, f)).toBeDefined();
    }
  });

  it("passes through a friendly-occupied hex but does not land on it", () => {
    const occupantTeam = (hex: { col: number; row: number }): number | undefined =>
      hex.col === 10 && hex.row === 11 ? 0 : undefined;
    const rs = reach("walk", 2, 2, 0, "n", clear, occupantTeam);
    // The friendly-occupied hex is passable but never a landing.
    expect(lookup(rs, { col: 10, row: 11 }, "n")).toBeUndefined();
    // The hex beyond it remains reachable.
    expect(lookup(rs, { col: 10, row: 12 }, "n")).toBeDefined();
  });

  it("run with a one-MP budget only reaches the forward hex", () => {
    const rs = reach("run", 4, 1, 0);
    expect(lookup(rs, { col: 10, row: 9 }, "n")).toEqual(["F"]);
    // Backward is forbidden for run.
    expect(lookup(rs, { col: 10, row: 11 }, "n")).toBeUndefined();
  });

  it("clips reachable hexes to the board width and height", () => {
    // 13x13 board; start on the bottom-right edge.
    const rs = reachableLandings({ col: 12, row: 12 }, "n", {
      mode: "walk",
      walking: 4,
      running: 6,
      jumping: 0,
      terrain: clear,
      team: 0,
      occupantTeam: noOccupants,
      width: 13,
      height: 13,
    });
    for (const l of rs) {
      expect(l.hex.col).toBeGreaterThanOrEqual(0);
      expect(l.hex.row).toBeGreaterThanOrEqual(0);
      expect(l.hex.col).toBeLessThan(13);
      expect(l.hex.row).toBeLessThan(13);
    }
  });
});
