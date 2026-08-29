import { describe, expect, it } from "vitest";
import { levelAt } from "../src/core/terrain.js";
import { getWeapon } from "../src/data/weapons.js";
import { losClear, losWoodsPointsBetween } from "../src/rules/los.js";
import { reachableLandings } from "../src/rules/movement.js";
import { computeToHit } from "../src/rules/tohit.js";

/**
 * Worked example: a hilly duel between two bipedal 'Mechs.
 *
 *   hbk (HBK-4G) at (2, 0) level 0, facing se (toward (3,0)).
 *   enf (ENF-4R) at (4, 0) level 0, facing nw (toward (3,0)).
 *   (3, 0) is a level-1 ridge sitting between them.
 *   All other hexes are level 0.
 *
 * Rules under test:
 *   1. Ground move:  +1 MP per level climbed, max +1 per step.
 *   2. Jump:         ignores elevation; 1 MP per step.
 *   3. LOS:          a real-valued ray between attacker/target LOS levels
 *                    (hex + 1). An intervening hex blocks iff its own LOS
 *                    level exceeds the ray.
 *   4. To-hit:       -heightDiff TN adjustment (attacker higher = easier).
 */

const elevation: Record<string, number> = { "3,0": 1 };
const clear = {};
const team = 0;
const noOcc = () => undefined;

describe("elevation worked example: ridge duel", () => {
  it("ground step into a level-1 hex costs 2 MP (1 base + 1 climb)", () => {
    // Two-MP walk budget is enough to climb into a level-1 hex (1 base + 1 climb).
    // From (2,0) facing "ne" leads to (3,0).
    const landings = reachableLandings({ col: 2, row: 0 }, "ne", {
      mode: "walk",
      walking: 2,
      running: 3,
      jumping: 0,
      terrain: clear,
      elevation,
      team,
      occupantTeam: noOcc,
      width: 6,
      height: 2,
    });
    expect(landings.find((l) => l.hex.col === 3 && l.hex.row === 0)).toBeDefined();
  });

  it("ground step onto a level-2 hex in one move is not allowed", () => {
    const level2: Record<string, number> = { "3,0": 2 };
    const landings = reachableLandings({ col: 2, row: 0 }, "ne", {
      mode: "walk",
      walking: 4,
      running: 6,
      jumping: 0,
      terrain: clear,
      elevation: level2,
      team,
      occupantTeam: noOcc,
      width: 6,
      height: 2,
    });
    expect(landings.find((l) => l.hex.col === 3 && l.hex.row === 0)).toBeUndefined();
  });

  it("jump to the level-1 hex costs 1 MP regardless of elevation", () => {
    const landings = reachableLandings({ col: 2, row: 0 }, "ne", {
      mode: "jump",
      walking: 4,
      running: 6,
      jumping: 4,
      terrain: clear,
      elevation,
      team,
      occupantTeam: noOcc,
      width: 6,
      height: 2,
    });
    const ridge = landings.find((l) => l.hex.col === 3 && l.hex.row === 0);
    expect(ridge).toBeDefined();
  });

  it("LOS from level-0 to level-0 across a level-1 ridge is blocked", () => {
    expect(losClear(elevation, clear, { col: 2, row: 0 }, { col: 4, row: 0 })).toBe(false);
  });

  it("LOS from the level-1 ridge down to the level-0 target is clear", () => {
    // The attacker is on the ridge; the only intervening hexes would be the
    // attacker's own hex, which is excluded. With no intervening terrain at
    // all, the LOS check is trivially clear.
    expect(losWoodsPointsBetween(clear, { col: 3, row: 0 }, { col: 4, row: 0 })).toBe(0);
    expect(losClear(elevation, clear, { col: 3, row: 0 }, { col: 4, row: 0 })).toBe(true);
  });

  it("to-hit bonus when firing down from a level-1 ridge to a level-0 target", () => {
    // Medium laser, 1 hex (short), no other modifiers. With attackerLevel=1,
    // targetLevel=0: heightDiff = 1, heightMod = -1, total = gunnery - 1.
    const bd = computeToHit({
      gunnery: 4,
      attackerMovement: "standStill",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 1,
      weapon: getWeapon("Medium Laser"),
      attackerLevel: levelAt(elevation, { col: 3, row: 0 }),
      targetLevel: levelAt(elevation, { col: 4, row: 0 }),
    });
    expect(bd.heightDiff).toBe(1);
    expect(bd.heightMod).toBe(-1);
    expect(bd.total).toBe(3); // gunnery 4 - heightMod 1
  });

  it("to-hit penalty when firing up from level 0 to a level-1 target", () => {
    const bd = computeToHit({
      gunnery: 4,
      attackerMovement: "standStill",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 1,
      weapon: getWeapon("Medium Laser"),
      attackerLevel: levelAt(elevation, { col: 2, row: 0 }),
      targetLevel: levelAt(elevation, { col: 3, row: 0 }),
    });
    expect(bd.heightDiff).toBe(-1);
    expect(bd.heightMod).toBe(1);
    expect(bd.total).toBe(5);
  });
});
