import { describe, expect, it } from "vitest";
import { neighbor } from "../src/core/hex";
import type { HexGrid } from "../src/core/terrain";
import {
  FACINGS,
  type Facing,
  type HexCell,
  type HexCoord,
  type MoveMode,
  oppositeFacing,
  rotateFacing,
} from "../src/core/types";
import type { MovePathStep } from "../src/rules/movement";
import { pathMp, reachableLandings } from "../src/rules/movement";

// Start in the middle of a large board so the search radius is not clipped.
const start = { col: 12, row: 12 };
const startFacing: Facing = "n";
const noOccupants = () => undefined;
const team = 1;
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
  prone = false,
) {
  return reachableLandings(at, facing, {
    mode,
    walking,
    running,
    jumping,
    prone,
    grid: grid(width, height, levels),
    team,
    occupantTeam,
  });
}

function lookup(
  rs: ReturnType<typeof reach>,
  hex: { col: number; row: number },
  facing: Facing,
): readonly MovePathStep[] | undefined {
  return rs.find((l) => l.hex.col === hex.col && l.hex.row === hex.row && l.facing === facing)
    ?.path;
}

function fragments(path: readonly MovePathStep[] | undefined): string[] {
  return path ? path.map((s) => s.fragment) : [];
}

describe("reachableLandings", () => {
  it("returns nothing for standstill", () => {
    expect(reach("standStill", 4, 6, 0)).toEqual([]);
  });

  it("includes the starting hex with the initial facing and an empty path", () => {
    const rs = reach("walk", 4, 6, 0);
    expect(fragments(lookup(rs, start, "n"))).toEqual([]);
  });

  it("lists the start hex with every facing reachable by turns alone", () => {
    const rs = reach("walk", 4, 6, 0);
    const others: Facing[] = ["ne", "se", "s", "sw", "nw"];
    for (const f of others) {
      const p = lookup(rs, start, f);
      expect(p).toBeDefined();
      expect(p!.length).toBeGreaterThan(0);
      expect(p!.every((s) => s.fragment === "R" || s.fragment === "L")).toBe(true);
    }
  });

  it("walks one MP forward or backward and keeps the original facing", () => {
    const rs = reach("walk", 1, 1, 0);
    expect(fragments(lookup(rs, { col: 12, row: 11 }, "n"))).toEqual(["F"]);
    expect(fragments(lookup(rs, { col: 12, row: 13 }, "n"))).toEqual(["B"]);
  });

  it("turns right to step diagonally forward within a two-MP walk", () => {
    const rs = reach("walk", 2, 2, 0);
    expect(fragments(lookup(rs, { col: 13, row: 12 }, "ne"))).toEqual(["R", "F"]);
  });

  it("jump reaches the forward neighbor with J, side neighbors via free R/L + J, backward via B", () => {
    const rs = reach("jump", 6, 8, 1);
    expect(fragments(lookup(rs, { col: 12, row: 11 }, "n"))).toEqual(["J"]);
    expect(fragments(lookup(rs, { col: 12, row: 13 }, "n"))).toEqual(["B"]);
    expect(fragments(lookup(rs, { col: 13, row: 12 }, "ne"))).toEqual(["R", "J"]);
    expect(fragments(lookup(rs, { col: 11, row: 12 }, "nw"))).toEqual(["L", "J"]);
  });

  it("jump landing facing is free: every facing at the same cost", () => {
    const rs = reach("jump", 6, 8, 1);
    const hex = { col: 12, row: 11 };
    for (const f of ["n", "ne", "se", "s", "sw", "nw"] as const) {
      expect(lookup(rs, hex, f)).toBeDefined();
    }
  });

  it("jump never lists the starting hex: in-place reorientation is not a jump (TW p.53)", () => {
    const rs = reach("jump", 6, 8, 3);
    expect(rs.filter((l) => l.hex.col === start.col && l.hex.row === start.row)).toEqual([]);
    // Ground modes still offer in-place turns at the starting hex.
    const walk = reach("walk", 6, 8, 3);
    expect(fragments(lookup(walk, start, "ne"))).toEqual(["R"]);
  });

  it("passes through a friendly-occupied hex but does not land on it", () => {
    const occupantTeam = (hex: { col: number; row: number }): number | undefined =>
      hex.col === 12 && hex.row === 11 ? 1 : undefined;
    const rs = reach("walk", 2, 2, 0, "n", occupantTeam);
    expect(lookup(rs, { col: 12, row: 11 }, "n")).toBeUndefined();
    expect(lookup(rs, { col: 12, row: 10 }, "n")).toBeDefined();
  });

  it("run with a one-MP budget only reaches the forward hex", () => {
    const rs = reach("run", 4, 1, 0);
    expect(fragments(lookup(rs, { col: 12, row: 11 }, "n"))).toEqual(["U"]);
    expect(lookup(rs, { col: 12, row: 13 }, "n")).toBeUndefined();
  });

  it("clips reachable hexes to the board width and height", () => {
    const rs = reachableLandings({ col: 13, row: 13 }, "n", {
      mode: "walk",
      walking: 4,
      running: 6,
      jumping: 0,
      prone: false,
      grid: grid(13, 13),
      team: 1,
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
    const rs = reach("walk", 2, 3, 0, "n", noOccupants, 21, 21, start, { "12,11": 1 });
    expect(fragments(lookup(rs, { col: 12, row: 11 }, "n"))).toEqual(["F"]);
  });

  it("allows a +2 level ground step and rejects a +3", () => {
    const rs = reach("walk", 3, 4, 0, "n", noOccupants, 21, 21, start, { "12,11": 2 });
    expect(fragments(lookup(rs, { col: 12, row: 11 }, "n"))).toEqual(["F"]);
    const rs3 = reach("walk", 4, 6, 0, "n", noOccupants, 21, 21, start, { "12,11": 3 });
    expect(lookup(rs3, { col: 12, row: 11 }, "n")).toBeUndefined();
  });

  it("charges +1 MP per level descended", () => {
    const desc = { "12,12": 1 };
    expect(
      lookup(
        reach("walk", 1, 1, 0, "n", noOccupants, 21, 21, start, desc),
        { col: 12, row: 11 },
        "n",
      ),
    ).toBeUndefined();
    expect(
      fragments(
        lookup(
          reach("walk", 2, 2, 0, "n", noOccupants, 21, 21, start, desc),
          { col: 12, row: 11 },
          "n",
        ),
      ),
    ).toEqual(["F"]);
  });

  it("rejects a forward step dropping more than 2 levels", () => {
    const rs = reach("walk", 4, 6, 0, "n", noOccupants, 21, 21, start, { "12,12": 3 });
    expect(lookup(rs, { col: 12, row: 11 }, "n")).toBeUndefined();
  });

  it("rejects a backward step that changes level", () => {
    const up = reach("walk", 4, 6, 0, "n", noOccupants, 21, 21, start, { "12,13": 1 });
    expect(lookup(up, { col: 12, row: 13 }, "n")).toBeUndefined();
    const down = reach("walk", 4, 6, 0, "n", noOccupants, 21, 21, start, { "12,12": 1 });
    expect(lookup(down, { col: 12, row: 13 }, "n")).toBeUndefined();
  });

  it("jump ignores elevation and can change level freely", () => {
    const rs = reach("jump", 6, 8, 1, "n", noOccupants, 21, 21, start, { "10,9": 3 });
    expect(fragments(lookup(rs, { col: 12, row: 11 }, "n"))).toEqual(["J"]);
  });

  it("prone turn allows only in-place turns, no hex enters", () => {
    const rs = reach("walk", 4, 6, 0, "n", noOccupants, 21, 21, start, {}, true);
    expect(fragments(lookup(rs, { col: 12, row: 12 }, "ne"))).toEqual(["R"]);
    expect(fragments(lookup(rs, { col: 12, row: 12 }, "nw"))).toEqual(["L"]);
    expect(lookup(rs, { col: 12, row: 11 }, "n")).toBeUndefined();
    expect(lookup(rs, { col: 12, row: 13 }, "n")).toBeUndefined();
  });

  it("prone turn allows multiple turns within budget", () => {
    const rs = reach("walk", 3, 4, 0, "n", noOccupants, 21, 21, start, {}, true);
    // Two right turns (2 MP) to face se, staying in place.
    expect(fragments(lookup(rs, { col: 12, row: 12 }, "se"))).toEqual(["R", "R"]);
  });

  it("run uses U fragments, no backward", () => {
    const rs = reach("run", 4, 2, 0, "n", noOccupants, 21, 21, start, {});
    expect(fragments(lookup(rs, { col: 12, row: 11 }, "n"))).toEqual(["U"]);
    expect(lookup(rs, { col: 12, row: 13 }, "n")).toBeUndefined();
    // Two hexes forward
    expect(fragments(lookup(rs, { col: 12, row: 10 }, "n"))).toEqual(["U", "U"]);
  });

  it("run turns cost 1 MP", () => {
    const rs = reach("run", 3, 2, 0, "n", noOccupants, 21, 21, start, {});
    expect(fragments(lookup(rs, { col: 13, row: 12 }, "ne"))).toEqual(["R", "U"]);
  });

  it("standup seeds all six start-hex facings with empty paths (TW p.50)", () => {
    const rs = reachableLandings(start, "n", {
      mode: "walk",
      walking: 1,
      running: 1,
      jumping: 0,
      prone: false,
      grid: grid(boardWidth, boardHeight),
      team,
      occupantTeam: noOccupants,
      standup: true,
    });
    for (const f of ["n", "ne", "se", "s", "sw", "nw"] as const) {
      const p = lookup(rs, start, f);
      expect(p).toBeDefined();
      expect(p).toEqual([]);
    }
  });

  it("standup free picks cost nothing against a tight budget", () => {
    // 1 MP walk budget after stand; user picks facing se (free pick) and
    // then B-steps backward from the start hex... but backward from start
    // IS a hex enter, so it should NOT be reachable without forward
    // movement first. Verify the 180°-turn pick is reachable for free even
    // when turn cost would have eaten the entire budget.
    const rs = reachableLandings(start, "n", {
      mode: "walk",
      walking: 0,
      running: 0,
      jumping: 0,
      prone: false,
      grid: grid(boardWidth, boardHeight),
      team,
      occupantTeam: noOccupants,
      standup: true,
    });
    for (const f of ["n", "ne", "se", "s", "sw", "nw"] as const) {
      expect(lookup(rs, start, f)).toEqual([]);
    }
  });

  it("standup leaves non-start paths replayable from startFacing", () => {
    // Paths that leave in a free facing open with 0-MP turns, so every one
    // of them still replays from startFacing.
    const rs = reachableLandings(start, "n", {
      mode: "walk",
      walking: 3,
      running: 4,
      jumping: 0,
      prone: false,
      grid: grid(boardWidth, boardHeight),
      team,
      occupantTeam: noOccupants,
      standup: true,
    });
    // The forward hex from startFacing=n is (col:12, row:11), path [F].
    expect(fragments(lookup(rs, { col: 12, row: 11 }, "n"))).toEqual(["F"]);
    // The free pick at start hex facing se stays empty-path, cost 0.
    expect(lookup(rs, start, "se")).toEqual([]);
    for (const l of rs) {
      // A start-hex free pick keeps its empty path; its facing travels
      // separately (placeLanding -> moveFinalFacing).
      if (l.path.length === 0) {
        expect(l.hex).toEqual(start);
        continue;
      }
      let hex: HexCoord = start;
      let facing: Facing = "n";
      for (const step of l.path) {
        if (step.fragment === "R" || step.fragment === "L") {
          facing = rotateFacing(facing, step.fragment === "R" ? 1 : -1);
        } else {
          hex = neighbor(hex, step.fragment === "B" ? oppositeFacing(facing) : facing);
        }
      }
      expect({ hex, facing }).toEqual({ hex: l.hex, facing: l.facing });
    }
  });

  it("standup leaves the start hex in any facing for free (MOV-07, TW p.50)", () => {
    // HBK-4G walk 4, prone facing n: the stand leaves 2 MP. Searching from
    // every facing gives 54 landings; from n alone it gave 14.
    const rs = reachableLandings(start, "n", {
      mode: "walk",
      walking: 2,
      running: 3,
      jumping: 0,
      prone: false,
      grid: grid(boardWidth, boardHeight),
      team,
      occupantTeam: noOccupants,
      standup: true,
    });
    expect(rs).toHaveLength(54);
    // The hex behind, facing away: three free turns, then one forward step.
    const behind = lookup(rs, { col: 12, row: 13 }, "s");
    expect(fragments(behind)).toEqual(["R", "R", "R", "F"]);
    expect(pathMp(behind!)).toBe(1);
    expect(fragments(lookup(rs, { col: 12, row: 14 }, "s"))).toEqual(["R", "R", "R", "F", "F"]);
    for (const l of rs) {
      expect(pathMp(l.path)).toBeLessThanOrEqual(2);
      // Only the leading free turn costs nothing.
      const firstPaid = l.path.findIndex((step) => step.baseMp > 0);
      const free = firstPaid < 0 ? l.path : l.path.slice(0, firstPaid);
      expect(free.every((step) => step.fragment === "R" || step.fragment === "L")).toBe(true);
    }
  });

  it("standup charge paths from the start hex open with the free turn", () => {
    const enemyAt = (hex: { col: number; row: number }) =>
      hex.col === 12 && hex.row === 13 ? team + 1 : undefined;
    const rs = reachableLandings(start, "n", {
      mode: "walk",
      walking: 2,
      running: 3,
      jumping: 0,
      prone: false,
      grid: grid(boardWidth, boardHeight),
      team,
      occupantTeam: enemyAt,
      meleeOk: () => true,
      standup: true,
    });
    const charge = rs.find(
      (l) => l.melee?.kind === "charge" && l.melee.stopsAt.col === 12 && l.melee.stopsAt.row === 12,
    );
    expect(fragments(charge?.path)).toEqual(["R", "R", "R", "F"]);
  });

  it("sorts landings by numeric col, row, facing — not locale collation", () => {
    // String collation puts "10,x" before "9,x" ("1" < "9") and Thai
    // collation even reorders "1,10" after "10,10"; numeric order must hold
    // in every locale.
    const rs = reach("walk", 6, 8, 0);
    expect(rs.length).toBeGreaterThan(0);
    const rank = (hex: { col: number; row: number }, facing: Facing): number =>
      hex.col * 1_000_000 + hex.row * 10 + FACINGS.indexOf(facing);
    for (let i = 1; i < rs.length; i++) {
      expect(rank(rs[i]!.hex, rs[i]!.facing)).toBeGreaterThanOrEqual(
        rank(rs[i - 1]!.hex, rs[i - 1]!.facing),
      );
    }
    const cols = rs.map((l) => l.hex.col);
    expect(Math.max(...cols)).toBeGreaterThanOrEqual(10);
    expect(Math.min(...cols)).toBeLessThan(10);
    const lastCol9 = cols.lastIndexOf(9);
    const firstCol10 = cols.indexOf(10);
    expect(lastCol9).toBeGreaterThanOrEqual(0);
    expect(firstCol10).toBeGreaterThanOrEqual(0);
    expect(lastCol9).toBeLessThan(firstCol10);
  });
});
