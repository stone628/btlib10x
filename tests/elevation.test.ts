import { describe, expect, it } from "vitest";
import type { HexGrid } from "../src/core/terrain.js";
import type { HexCell } from "../src/core/types.js";
import { losClear, losWoodsPointsBetween } from "../src/rules/los.js";
import { type ReachabilityOptions, reachableLandings } from "../src/rules/movement.js";

/**
 * Worked example: a hilly duel between two bipedal 'Mechs.
 *
 *   hbk (HBK-4G) at (4, 2) level 0, facing ne (toward (5,2)).
 *   enf (ENF-4R) at (6, 2) level 0, facing nw (toward (5,2)).
 *   (5, 2) is a level-1 ridge sitting between them.
 *   All other hexes are level 0.
 *
 * Coordinate convention: 1-based, even-q (even columns sit half a hex lower
 * than odd columns). Under that layout 'ne' from an even column steps one
 * col over at the same row, so the ridge at (5, 2) is the forward hex.
 */

/** Build a 6x3 grid with the given per-hex "col,row" level overrides (others 0). */
function gridWithLevels(levels: Record<string, number>): HexGrid {
  const width = 6;
  const height = 3;
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

const elevation = gridWithLevels({ "5,2": 1 });
const clear = gridWithLevels({});
const team = 0;
const noOcc = () => undefined;

const reachOptions = (grid: HexGrid): ReachabilityOptions => ({
  mode: "walk",
  walking: 4,
  running: 6,
  jumping: 4,
  grid,
  prone: false,
  team,
  occupantTeam: noOcc,
});

describe("elevation worked example: ridge duel", () => {
  it("ground step into a level-1 hex costs 2 MP (1 base + 1 climb)", () => {
    // Two-MP walk budget is enough to climb into a level-1 hex (1 base + 1 climb).
    // From (4,2) facing "ne" (col 4 even) leads to (5,2) on the ridge.
    const landings = reachableLandings({ col: 4, row: 2 }, "ne", {
      ...reachOptions(elevation),
      mode: "walk",
      walking: 2,
      running: 3,
      jumping: 0,
      prone: false,
    });
    expect(landings.find((l) => l.hex.col === 5 && l.hex.row === 2)).toBeDefined();
  });

  it("ground step onto a level-2 hex in one move is allowed, +3 rejected", () => {
    // TW: a forward step may change up to 2 levels per hex. Level-2 hex costs
    // 1 base + 2 climb = 3 MP (walk budget 4); a level-3 hex is beyond the cap.
    const level2 = gridWithLevels({ "5,2": 2 });
    const landings = reachableLandings({ col: 4, row: 2 }, "ne", {
      ...reachOptions(level2),
    });
    expect(landings.find((l) => l.hex.col === 5 && l.hex.row === 2)).toBeDefined();
    const level3 = gridWithLevels({ "5,2": 3 });
    const landings3 = reachableLandings({ col: 4, row: 2 }, "ne", {
      ...reachOptions(level3),
    });
    expect(landings3.find((l) => l.hex.col === 5 && l.hex.row === 2)).toBeUndefined();
  });

  it("jump to the level-1 hex costs 1 MP regardless of elevation", () => {
    const landings = reachableLandings({ col: 4, row: 2 }, "ne", {
      ...reachOptions(elevation),
      mode: "jump",
    });
    const ridge = landings.find((l) => l.hex.col === 5 && l.hex.row === 2);
    expect(ridge).toBeDefined();
  });

  it("LOS from level-0 to level-0 across a tall ridge is blocked", () => {
    // Eye-level ray sits at LOS level 2; the ridge needs to top out strictly
    // above 2 to block (default L1 ridge tops at L1 — below the ray).
    const tall = gridWithLevels({ "5,2": 3 });
    expect(losClear(tall, { col: 4, row: 2 }, { col: 6, row: 2 })).toBe(false);
  });

  it("LOS from the level-1 ridge down to the level-0 target is clear", () => {
    expect(losWoodsPointsBetween(clear, { col: 5, row: 2 }, { col: 6, row: 2 })).toBe(0);
    expect(losClear(elevation, { col: 5, row: 2 }, { col: 6, row: 2 })).toBe(true);
  });
});
