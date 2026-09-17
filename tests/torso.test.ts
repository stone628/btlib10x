import { describe, expect, it } from "vitest";
import { rotateFacing } from "../src/core/types.js";
import { classifyArcWithBoundary, effectiveFacingForTwist, twistDelta } from "../src/rules/arcs.js";
import { suggestFireTargets } from "../src/rules/fireability.js";
import type { BattleState, UnitInit } from "../src/rules/game.js";
import { advancePhase, declareAttacks, rollInitiativePhase } from "../src/rules/game.js";
import { createTestBattle, scriptedRng } from "./helpers.js";

function startAttackTurn(state: BattleState): BattleState {
  rollInitiativePhase(state, scriptedRng(1, 1, 4, 4));
  advancePhase(state);
  return state;
}

function hbkFacingAt(targetBearing: "ne" | "n"): {
  units: UnitInit[];
  facing: "n" | "ne";
  enemy: { col: number; row: number };
} {
  if (targetBearing === "ne") {
    return {
      units: [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          piloting: 5,
          position: { col: 2, row: 4 },
          facing: "n",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          piloting: 5,
          position: { col: 3, row: 4 },
          facing: "sw",
        },
      ],
      facing: "n",
      enemy: { col: 3, row: 4 },
    };
  }
  return {
    units: [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 4 },
        facing: "ne",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 3 },
        facing: "sw",
      },
    ],
    facing: "ne",
    enemy: { col: 2, row: 3 },
  };
}

describe("twistDelta + effectiveFacingForTwist", () => {
  it("maps left to -1, right to +1, front/rear to 0", () => {
    expect(twistDelta("leftSide")).toBe(-1);
    expect(twistDelta("rightSide")).toBe(1);
    expect(twistDelta("front")).toBe(0);
    expect(twistDelta("rear")).toBe(0);
  });

  it("rotates facing by twist delta (or no-op for front)", () => {
    expect(effectiveFacingForTwist("n", "leftSide")).toBe("nw");
    expect(effectiveFacingForTwist("n", "rightSide")).toBe("ne");
    expect(effectiveFacingForTwist("n", "front")).toBe("n");
    expect(effectiveFacingForTwist("ne", "leftSide")).toBe("n");
    expect(effectiveFacingForTwist("ne", "rightSide")).toBe("se");
  });

  it("treats null/undefined as untwisted", () => {
    expect(effectiveFacingForTwist("se", null)).toBe("se");
    expect(effectiveFacingForTwist("se", undefined)).toBe("se");
  });

  it("matches rotateFacing for non-zero deltas", () => {
    for (const f of ["n", "ne", "se", "s", "sw", "nw"] as const) {
      expect(effectiveFacingForTwist(f, "leftSide")).toBe(rotateFacing(f, -1));
      expect(effectiveFacingForTwist(f, "rightSide")).toBe(rotateFacing(f, 1));
    }
  });
});

describe("classifyArcWithBoundary on a twisted facing", () => {
  it("moves a right-side bearing into the front arc under a right twist", () => {
    const b = classifyArcWithBoundary("n", { facing: "ne", boundary: null });
    expect(b.arc).toBe("rightSide");
    const twisted = classifyArcWithBoundary(effectiveFacingForTwist("n", "rightSide"), {
      facing: "ne",
      boundary: null,
    });
    expect(twisted.arc).toBe("front");
  });

  it("moves a left-side bearing into the front arc under a left twist", () => {
    const b = classifyArcWithBoundary("ne", { facing: "n", boundary: null });
    expect(b.arc).toBe("leftSide");
    const twisted = classifyArcWithBoundary(effectiveFacingForTwist("ne", "leftSide"), {
      facing: "n",
      boundary: null,
    });
    expect(twisted.arc).toBe("front");
  });
});

describe("suggestFireTargets with torso twist", () => {
  it("without twist only the right-arm weapon fires into the body's right side", () => {
    const { units, facing } = hbkFacingAt("ne");
    expect(facing).toBe("n");
    const state = startAttackTurn(createTestBattle([], units, false));
    const sugg = suggestFireTargets(state, "hbk");
    const enf = sugg.targets.find((t) => t.targetId === "enf")!;
    expect(enf.arc).toBe("rightSide");
    expect(enf.weapons.map((w) => w.weaponIndex).sort()).toEqual([2]);
  });

  it("with twist=right all four weapons fire (twisted front arc)", () => {
    const { units } = hbkFacingAt("ne");
    const state = startAttackTurn(createTestBattle([], units, false));
    const sugg = suggestFireTargets(state, "hbk", "rightSide");
    const enf = sugg.targets.find((t) => t.targetId === "enf")!;
    expect(enf.arc).toBe("front");
    expect(enf.weapons.map((w) => w.weaponIndex).sort()).toEqual([1, 2, 3, 4]);
  });

  it("with twist=left on a left-bearing target lets every weapon fire", () => {
    const { units, facing } = hbkFacingAt("n");
    expect(facing).toBe("ne");
    const state = startAttackTurn(createTestBattle([], units, false));
    const baseSugg = suggestFireTargets(state, "hbk");
    const baseEnf = baseSugg.targets.find((t) => t.targetId === "enf")!;
    expect(baseEnf.arc).toBe("leftSide");
    expect(baseEnf.weapons.map((w) => w.weaponIndex).sort()).toEqual([1]);

    const twistedSugg = suggestFireTargets(state, "hbk", "leftSide");
    const twistedEnf = twistedSugg.targets.find((t) => t.targetId === "enf")!;
    expect(twistedEnf.arc).toBe("front");
    expect(twistedEnf.weapons.map((w) => w.weaponIndex).sort()).toEqual([1, 2, 3, 4]);
  });

  it("omitting twist matches the untwisted call (back-compat)", () => {
    const { units } = hbkFacingAt("ne");
    const state = startAttackTurn(createTestBattle([], units, false));
    const base = suggestFireTargets(state, "hbk");
    const backCompat = suggestFireTargets(state, "hbk");
    expect(backCompat.targets[0]?.weapons.map((w) => w.weaponIndex)).toEqual(
      base.targets[0]?.weapons.map((w) => w.weaponIndex),
    );
  });
});

describe("declareAttacks with torso twist", () => {
  it("accepts a leftArm weapon when twist shifts the bearing into the front arc", () => {
    const { units } = hbkFacingAt("ne");
    const state = startAttackTurn(createTestBattle([], units, false));
    expect(() =>
      declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], scriptedRng(4), {
        twist: "rightSide",
      }),
    ).not.toThrow();
  });

  it("rejects the same weapon without twist (target outside its firing arc)", () => {
    const { units } = hbkFacingAt("ne");
    const state = startAttackTurn(createTestBattle([], units, false));
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }])).toThrow(
      /firing arc/,
    );
  });

  it("rejects the rightArm weapon when twist=right leaves the target in the left side", () => {
    const { units, facing } = hbkFacingAt("n");
    expect(facing).toBe("ne");
    const state = startAttackTurn(createTestBattle([], units, false));
    expect(() =>
      declareAttacks(state, "hbk", [{ weaponIndex: 2, targetId: "enf" }], scriptedRng(4), {
        twist: "rightSide",
      }),
    ).toThrow(/firing arc/);
  });

  it("omitting opts keeps untwisted behavior", () => {
    const { units } = hbkFacingAt("ne");
    const state = startAttackTurn(createTestBattle([], units, false));
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 2, targetId: "enf" }])).not.toThrow();
  });
});
