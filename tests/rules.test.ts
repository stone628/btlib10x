import { describe, expect, it } from "vitest";
import { bearingExact } from "../src/core/hex.js";
import {
  classifyArc,
  classifyArcWithBoundary,
  defenderArcChoice,
  isInFrontArc,
  weaponCanFireIntoArc,
} from "../src/rules/arcs.js";
import { losBlocked, losWoodsPoints } from "../src/rules/los.js";
import {
  attackerMovementModifier,
  canEndMoveInHex,
  canPassThroughHex,
  facingChangeCost,
  maxMovePoints,
} from "../src/rules/movement.js";

describe("movement rules", () => {
  it("computes MP budgets per movement mode", () => {
    expect(maxMovePoints("standStill", 4, 6, 0)).toBe(0);
    expect(maxMovePoints("walk", 4, 6, 0)).toBe(4);
    expect(maxMovePoints("run", 4, 6, 0)).toBe(6);
    expect(maxMovePoints("jump", 5, 8, 5)).toBe(5);
  });

  it("charges terrain and facing costs", () => {
    expect(facingChangeCost(3)).toBe(3);
    // Heavy woods hex: base 1 + 2 = 3 MP (Total Warfare p.52 example says 4 with a
    // one-hexside turn included).
    expect(facingChangeCost(1) + 3).toBe(4);
  });

  it("applies attacker movement modifiers (walk +1, run +2, jump +3)", () => {
    expect(attackerMovementModifier("standStill")).toBe(0);
    expect(attackerMovementModifier("walk")).toBe(1);
    expect(attackerMovementModifier("run")).toBe(2);
    expect(attackerMovementModifier("jump")).toBe(3);
  });

  it("enforces stacking pass-through vs ending rules", () => {
    expect(canPassThroughHex(undefined, 1)).toBe(true);
    expect(canPassThroughHex(1, 1)).toBe(true);
    expect(canPassThroughHex(2, 1)).toBe(false);
    expect(canEndMoveInHex(undefined, 1)).toBe(true);
    expect(canEndMoveInHex(1, 1)).toBe(false);
    expect(canEndMoveInHex(2, 1)).toBe(false);
  });
});

describe("line of sight", () => {
  it("blocks at three or more woods points", () => {
    expect(losWoodsPoints(["lightWoods", "lightWoods"])).toBe(2);
    expect(losBlocked(losWoodsPoints(["lightWoods", "lightWoods"]))).toBe(false);
    expect(losBlocked(losWoodsPoints(["lightWoods", "lightWoods", "lightWoods"]))).toBe(true);
    expect(losBlocked(losWoodsPoints(["heavyWoods"]))).toBe(false);
    expect(losBlocked(losWoodsPoints(["heavyWoods", "heavyWoods"]))).toBe(true);
    expect(losBlocked(losWoodsPoints(["heavyWoods", "lightWoods"]))).toBe(true);
  });
});

describe("firing arcs", () => {
  it("treats the three front hexsides as the front arc", () => {
    expect(isInFrontArc("n", "n")).toBe(true);
    expect(isInFrontArc("n", "ne")).toBe(true);
    expect(isInFrontArc("n", "nw")).toBe(true);
    expect(isInFrontArc("n", "se")).toBe(false);
    expect(isInFrontArc("n", "s")).toBe(false);
    expect(isInFrontArc("n", "sw")).toBe(false);
    expect(isInFrontArc("s", "s")).toBe(true);
    expect(isInFrontArc("s", "se")).toBe(true);
    expect(isInFrontArc("s", "sw")).toBe(true);
    expect(isInFrontArc("s", "ne")).toBe(false);
  });

  it("classifies all four arcs clockwise from facing", () => {
    expect(classifyArc("n", "n")).toBe("front");
    expect(classifyArc("n", "ne")).toBe("rightSide");
    expect(classifyArc("n", "se")).toBe("rightSide");
    expect(classifyArc("n", "s")).toBe("rear");
    expect(classifyArc("n", "sw")).toBe("leftSide");
    expect(classifyArc("n", "nw")).toBe("leftSide");
    expect(classifyArc("se", "n")).toBe("leftSide");
    expect(classifyArc("se", "se")).toBe("front");
    expect(classifyArc("se", "nw")).toBe("rear");
  });
});

describe("per-weapon firing arcs (TW p.105)", () => {
  it("restricts head/leg/front-torso weapons to the front arc", () => {
    for (const loc of [
      "head",
      "centerTorso",
      "rightTorso",
      "leftTorso",
      "rightLeg",
      "leftLeg",
    ] as const) {
      expect(weaponCanFireIntoArc(loc, false, "front")).toBe(true);
      expect(weaponCanFireIntoArc(loc, false, "rear")).toBe(false);
      expect(weaponCanFireIntoArc(loc, false, "leftSide")).toBe(false);
      expect(weaponCanFireIntoArc(loc, false, "rightSide")).toBe(false);
    }
  });

  it("lets arm weapons cover the front and their own side arc", () => {
    expect(weaponCanFireIntoArc("rightArm", false, "front")).toBe(true);
    expect(weaponCanFireIntoArc("rightArm", false, "rightSide")).toBe(true);
    expect(weaponCanFireIntoArc("rightArm", false, "leftSide")).toBe(false);
    expect(weaponCanFireIntoArc("rightArm", false, "rear")).toBe(false);
    expect(weaponCanFireIntoArc("leftArm", false, "front")).toBe(true);
    expect(weaponCanFireIntoArc("leftArm", false, "leftSide")).toBe(true);
    expect(weaponCanFireIntoArc("leftArm", false, "rightSide")).toBe(false);
    expect(weaponCanFireIntoArc("leftArm", false, "rear")).toBe(false);
  });

  it("fires rear-facing torso weapons into the rear arc only", () => {
    expect(weaponCanFireIntoArc("centerTorso", true, "rear")).toBe(true);
    expect(weaponCanFireIntoArc("centerTorso", true, "front")).toBe(false);
    expect(weaponCanFireIntoArc("centerTorso", true, "leftSide")).toBe(false);
    expect(weaponCanFireIntoArc("rightTorso", true, "rear")).toBe(true);
    expect(weaponCanFireIntoArc("leftTorso", true, "front")).toBe(false);
  });

  it("resolves boundary-line ambiguity to the defender's dominant choice", () => {
    expect(defenderArcChoice("front", null)).toBe("front");
    expect(defenderArcChoice("front", "leftSide")).toBe("front");
    expect(defenderArcChoice("leftSide", "front")).toBe("front");
    expect(defenderArcChoice("rear", "rightSide")).toBe("rightSide");
    expect(defenderArcChoice("leftSide", "rear")).toBe("leftSide");
  });

  it("classifies both arcs of a boundary pair", () => {
    // (2,4) -> (3,3) runs exactly along the n|ne sector edge: right side on
    // both candidates when facing northwest.
    const b = bearingExact({ col: 2, row: 4 }, { col: 3, row: 3 })!;
    expect(b.boundary).not.toBeNull();
    const cls = classifyArcWithBoundary("nw", b);
    expect(cls.arc).toBe("rightSide");
    expect(cls.altArc).toBe("rightSide");
  });
});
