import { describe, expect, it } from "vitest";
import { isInFrontArc } from "../src/rules/arcs.js";
import { losBlocked, losWoodsPoints } from "../src/rules/los.js";
import {
  attackerMovementModifier,
  canEndMoveInHex,
  canPassThroughHex,
  facingChangeCost,
  hexesSinceLastReversal,
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
    // Heavy woods hex: base 1 + 2 = 3 MP (Total Warfare p.12 example says 4 with a
    // one-hexside turn included).
    expect(facingChangeCost(1) + 3).toBe(4);
  });

  it("applies attacker movement modifiers (walk +1, run +2, jump +3)", () => {
    expect(attackerMovementModifier("standStill")).toBe(0);
    expect(attackerMovementModifier("walk")).toBe(1);
    expect(attackerMovementModifier("run")).toBe(2);
    expect(attackerMovementModifier("jump")).toBe(3);
  });

  it("counts only hexes since the last direction reversal", () => {
    const moves = ["backward", "backward", "backward", "forward", "forward"] as const;
    expect(hexesSinceLastReversal([...moves])).toBe(2);
    expect(hexesSinceLastReversal(["forward", "forward"])).toBe(2);
    expect(hexesSinceLastReversal([])).toBe(0);
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
});
