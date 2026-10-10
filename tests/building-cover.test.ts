/**
 * Leg hits stopped by building partial cover damage the building (TW p.102,
 * BLD-03).
 */
import { describe, expect, it } from "vitest";
import { resolveWeaponAttack } from "../src/rules/attack";
import {
  buildUnitInit,
  partialCoverBuildingHex,
  partialCoverMod,
  requireUnit,
} from "../src/rules/game";
import { createTestBattle, scriptedRng } from "./helpers";

function setup() {
  return createTestBattle(
    [{ col: 3, row: 3, type: "lightBuilding" }],
    [
      buildUnitInit("a", "HBK-4G", 1, { col: 3, row: 2 }, "s"),
      buildUnitInit("t", "ENF-4R", 2, { col: 3, row: 4 }, "n"),
    ],
    true,
  );
}

describe("building as partial cover (BLD-03)", () => {
  it("names the building hex that provides the cover", () => {
    const state = setup();
    const a = requireUnit(state, "a");
    const t = requireUnit(state, "t");
    expect(partialCoverMod(state, a, t)).toBe(1);
    expect(partialCoverBuildingHex(state, a, t)).toEqual({ col: 3, row: 3 });
  });

  it("a leg result reports its damage as coverDamage instead of vanishing", () => {
    const target = requireUnit(setup(), "t");
    // 2+3 = 5 -> right leg; the cover takes the hit.
    const res = resolveWeaponAttack({
      gunnery: 0,
      attackerMoved: "standStill",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningTerrains: [],
      distance: 1,
      weapon: "Small Laser",
      targetDamage: target.damage,
      rng: scriptedRng(6, 6, 2, 3),
      partialCoverMod: 1,
    });
    expect(res.groups).toHaveLength(0);
    expect(res.coverDamage).toBe(3);
  });
});
