/**
 * One hexside chain per attacker–target pair (TW pp.99, 101; LOS-02): on a
 * hexside line the defender picks one chain, and woods and partial cover
 * both come from it. Woods on one chain never adds to cover on the other.
 */
import { describe, expect, it } from "vitest";
import type { Facing, TerrainHexDef } from "../src/core/types";
import { suggestFireTargets } from "../src/rules/fireability";
import {
  attackDirectionFor,
  buildUnitInit,
  losSideFor,
  partialCoverMod,
  requireUnit,
} from "../src/rules/game";
import { losWoodsPointsBetween } from "../src/rules/los";
import { createTestBattle } from "./helpers";

// From 3,6 to 9,6 the line runs along hexsides: side 1 passes 6,5 and 8,5,
// side -1 passes 6,6 and 8,6 (8,5 and 8,6 are both adjacent to the target).
const WOODS_SIDE_1: TerrainHexDef = { col: 6, row: 5, type: "lightWoods" };
const HILL_SIDE_1: TerrainHexDef = { col: 8, row: 5, type: "clear", level: 1 };
const HILL_SIDE_MINUS_1: TerrainHexDef = { col: 8, row: 6, type: "clear", level: 1 };

function setup(terrain: TerrainHexDef[], targetFacing: Facing = "nw") {
  return createTestBattle(
    terrain,
    [
      buildUnitInit("a", "HBK-4G", 1, { col: 3, row: 6 }, "ne"),
      buildUnitInit("t", "ENF-4R", 2, { col: 9, row: 6 }, targetFacing),
    ],
    true,
    12,
    10,
  );
}

/** Medium Laser TN at range 6 (gunnery 4 + medium range 2 = base 6). */
function laserTn(terrain: TerrainHexDef[]): number {
  const target = suggestFireTargets(setup(terrain), "a").targets.find((t) => t.targetId === "t");
  return target!.weaponsIfPropLeft.find((w) => w.weapon === "Medium Laser")!.tn;
}

describe("one hexside chain for woods and cover (TW p.101, LOS-02)", () => {
  it("woods or cover alone each add +1", () => {
    expect(laserTn([])).toBe(6);
    expect(laserTn([WOODS_SIDE_1])).toBe(7);
    expect(laserTn([HILL_SIDE_MINUS_1])).toBe(7);
  });

  it("woods and cover on the same chain both count", () => {
    expect(laserTn([WOODS_SIDE_1, HILL_SIDE_1])).toBe(8);
  });

  it("woods on one chain and cover on the other do not combine", () => {
    expect(laserTn([WOODS_SIDE_1, HILL_SIDE_MINUS_1])).toBe(7);
  });

  it("on equal totals the defender takes the chain with cover", () => {
    const state = setup([WOODS_SIDE_1, HILL_SIDE_MINUS_1]);
    const a = requireUnit(state, "a");
    const t = requireUnit(state, "t");
    const side = losSideFor(state, a, t);
    expect(side).toBe(-1);
    expect(partialCoverMod(state, a, t)).toBe(1);
    expect(losWoodsPointsBetween(state, a.position, t.position, undefined, side)).toBe(0);
  });

  it("heavier woods on one chain outweigh cover on the other", () => {
    const state = setup([{ ...WOODS_SIDE_1, type: "heavyWoods" }, HILL_SIDE_MINUS_1]);
    const a = requireUnit(state, "a");
    const t = requireUnit(state, "t");
    expect(losSideFor(state, a, t)).toBe(1);
    expect(partialCoverMod(state, a, t)).toBe(0);
    expect(laserTn([{ ...WOODS_SIDE_1, type: "heavyWoods" }, HILL_SIDE_MINUS_1])).toBe(8);
  });
});

describe("the attack direction follows the same chain (TW p.119, LOS-02)", () => {
  // The line meets the target's hex at the corner between its nw hexside
  // (side 1 enters past 8,5) and its sw hexside (side -1 enters past 8,6).
  function direction(terrain: TerrainHexDef[], facing: Facing) {
    const state = setup(terrain, facing);
    return attackDirectionFor(state, requireUnit(state, "a"), requireUnit(state, "t"));
  }

  it("with nothing to choose between the chains, the defender takes the better side", () => {
    // Facing n: nw is a front hexside, sw a left-side one.
    expect(direction([], "n")).toBe("front");
    // Facing ne: nw is left side, sw is rear.
    expect(direction([], "ne")).toBe("leftSide");
  });

  it("taking the chain with cover also takes its attack direction", () => {
    // Cover on side -1 makes the sw hexside the one struck.
    expect(direction([HILL_SIDE_MINUS_1], "n")).toBe("leftSide");
    expect(direction([WOODS_SIDE_1, HILL_SIDE_MINUS_1], "n")).toBe("leftSide");
    expect(direction([{ ...WOODS_SIDE_1, type: "heavyWoods" }, HILL_SIDE_MINUS_1], "n")).toBe(
      "front",
    );
  });

  it("to-hit decides the chain even when its direction is worse for the defender", () => {
    expect(direction([HILL_SIDE_MINUS_1], "ne")).toBe("rear");
  });
});
