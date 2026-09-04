import { describe, expect, it } from "vitest";
import type { HexGrid } from "../src/core/terrain.js";
import type { HexCell } from "../src/core/types.js";
import { getWeaponDefFor } from "../src/data/weapon.schema.js";
import { losClear, losWoodsPointsBetween } from "../src/rules/los.js";
import { type ReachabilityOptions, reachableLandings } from "../src/rules/movement.js";
import { computeToHit } from "../src/rules/tohit.js";

/**
 * Worked example: a hilly duel between two bipedal 'Mechs.
 *
 *   hbk (HBK-4G) at (4, 2) level 0, facing se (toward (5,2)).
 *   enf (ENF-4R) at (6, 2) level 0, facing sw (toward (5,2)).
 *   (5, 2) is a level-1 ridge sitting between them.
 *   All other hexes are level 0.
 *
 * Coordinate convention: 1-based.
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
  team,
  occupantTeam: noOcc,
});

describe("elevation worked example: ridge duel", () => {
  it("ground step into a level-1 hex costs 2 MP (1 base + 1 climb)", () => {
    // Two-MP walk budget is enough to climb into a level-1 hex (1 base + 1 climb).
    // From (4,2) facing "se" (col 4 even) leads to (5,2) on the ridge.
    const landings = reachableLandings({ col: 4, row: 2 }, "se", {
      ...reachOptions(elevation),
      mode: "walk",
      walking: 2,
      running: 3,
      jumping: 0,
    });
    expect(landings.find((l) => l.hex.col === 5 && l.hex.row === 2)).toBeDefined();
  });

  it("ground step onto a level-2 hex in one move is not allowed", () => {
    const level2 = gridWithLevels({ "5,2": 2 });
    const landings = reachableLandings({ col: 4, row: 2 }, "se", {
      ...reachOptions(level2),
    });
    expect(landings.find((l) => l.hex.col === 5 && l.hex.row === 2)).toBeUndefined();
  });

  it("jump to the level-1 hex costs 1 MP regardless of elevation", () => {
    const landings = reachableLandings({ col: 4, row: 2 }, "se", {
      ...reachOptions(elevation),
      mode: "jump",
    });
    const ridge = landings.find((l) => l.hex.col === 5 && l.hex.row === 2);
    expect(ridge).toBeDefined();
  });

  it("LOS from level-0 to level-0 across a level-1 ridge is blocked", () => {
    expect(losClear(elevation, { col: 4, row: 2 }, { col: 6, row: 2 })).toBe(false);
  });

  it("LOS from the level-1 ridge down to the level-0 target is clear", () => {
    expect(losWoodsPointsBetween(clear, { col: 5, row: 2 }, { col: 6, row: 2 })).toBe(0);
    expect(losClear(elevation, { col: 5, row: 2 }, { col: 6, row: 2 })).toBe(true);
  });

  it("to-hit bonus when firing down from a level-1 ridge to a level-0 target", () => {
    // attacker at (5,2) level 1, target at (6,2) level 0. heightDiff = 1.
    const bd = computeToHit({
      gunnery: 4,
      attackerMovement: "standStill",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 1,
      weapon: getWeaponDefFor({ weapon: "Medium Laser" }),
      attackerLevel: 1,
      targetLevel: 0,
    });
    expect(bd.heightDiff).toBe(1);
    expect(bd.heightMod).toBe(-1);
    expect(bd.total).toBe(3);
  });

  it("to-hit penalty when firing up from level 0 to a level-1 target", () => {
    // attacker at (4,2) level 0, target at (5,2) level 1. heightDiff = -1.
    const bd = computeToHit({
      gunnery: 4,
      attackerMovement: "standStill",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 1,
      weapon: getWeaponDefFor({ weapon: "Medium Laser" }),
      attackerLevel: 0,
      targetLevel: 1,
    });
    expect(bd.heightDiff).toBe(-1);
    expect(bd.heightMod).toBe(1);
    expect(bd.total).toBe(5);
  });
});
