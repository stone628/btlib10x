import { describe, expect, it } from "vitest";
import { bearingExact, neighbor } from "../src/core/hex";
import type { Facing } from "../src/core/types";
import {
  classifyArc,
  classifyArcWithBoundary,
  classifyFiringArc,
  defenderArcChoice,
  weaponCanFireIntoArc,
} from "../src/rules/arcs";
import { losBlocked, losWoodsPoints } from "../src/rules/los";
import {
  attackerMovementModifier,
  canEndMoveInHex,
  canPassThroughHex,
  facingChangeCost,
  maxMovePoints,
} from "../src/rules/movement";

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
  it("classifies all four arcs clockwise from facing", () => {
    // 'Mech attack direction (TW p.119): 3-1-1-1 — front spans the front
    // hexside plus the two front-diagonal hexsides; each side is a single
    // rear-diagonal hexside.
    expect(classifyArc("n", "n")).toBe("front");
    expect(classifyArc("n", "ne")).toBe("front");
    expect(classifyArc("n", "se")).toBe("rightSide");
    expect(classifyArc("n", "s")).toBe("rear");
    expect(classifyArc("n", "sw")).toBe("leftSide");
    expect(classifyArc("n", "nw")).toBe("front");
    expect(classifyArc("se", "n")).toBe("leftSide");
    expect(classifyArc("se", "se")).toBe("front");
    expect(classifyArc("se", "nw")).toBe("rear");
  });
});

describe("TW p.105 firing-arc template", () => {
  // Attacker on 0509 facing north: every hex within radius 2 falls wholly
  // in one arc (the template has no boundary hexes).
  const origin = { col: 5, row: 9 };
  const expected: Record<string, "front" | "rear" | "leftSide" | "rightSide"> = {
    "5,7": "front",
    "4,7": "front",
    "6,7": "front",
    "3,8": "front",
    "5,8": "front",
    "7,8": "front",
    "4,8": "front",
    "6,8": "front",
    "3,9": "leftSide",
    "4,9": "leftSide",
    "3,10": "leftSide",
    "7,9": "rightSide",
    "6,9": "rightSide",
    "7,10": "rightSide",
    "5,10": "rear",
    "4,10": "rear",
    "6,10": "rear",
    "5,11": "rear",
  };

  it("places each hex within radius 2 of 0509 facing n in its book arc", () => {
    expect(Object.keys(expected)).toHaveLength(18);
    for (const [key, arc] of Object.entries(expected)) {
      const [col, row] = key.split(",").map(Number);
      expect(classifyFiringArc(origin, { col: col!, row: row! }, "n")).toBe(arc);
    }
  });

  it("returns null for a target in the attacker's own hex", () => {
    expect(classifyFiringArc(origin, origin, "n")).toBeNull();
  });

  it("keeps adjacent split 3-1-1-1 around every facing", () => {
    const forward: Record<Facing, Facing[]> = {
      n: ["n", "ne", "nw"],
      ne: ["ne", "n", "se"],
      se: ["se", "ne", "s"],
      s: ["s", "se", "sw"],
      sw: ["sw", "s", "nw"],
      nw: ["nw", "sw", "n"],
    };
    const facings: Facing[] = ["n", "ne", "se", "s", "sw", "nw"];
    for (const facing of facings) {
      const sides = new Set(facings);
      for (const f of forward[facing]!) sides.delete(f);
      // The three forward-adjacent hexes read front.
      for (const f of forward[facing]!) {
        expect(classifyFiringArc(origin, neighbor(origin, f), facing)).toBe("front");
      }
      // The directly rear hex reads rear.
      const rear =
        facing === "n"
          ? "s"
          : facing === "ne"
            ? "sw"
            : facing === "se"
              ? "nw"
              : facing === "s"
                ? "n"
                : facing === "sw"
                  ? "ne"
                  : "se";
      expect(classifyFiringArc(origin, neighbor(origin, rear), facing)).toBe("rear");
      sides.delete(rear);
      // The two remaining adjacent hexes read opposite sides.
      expect(sides.size).toBe(2);
      const sideArcs = new Set(
        [...sides].map((f) => classifyFiringArc(origin, neighbor(origin, f), facing)),
      );
      expect([...sideArcs].sort()).toEqual(["leftSide", "rightSide"]);
    }
  });

  it("holds the template corridors at longer range", () => {
    // Straight ahead / behind from 0509 facing n.
    expect(classifyFiringArc(origin, { col: 5, row: 5 }, "n")).toBe("front");
    expect(classifyFiringArc(origin, { col: 5, row: 13 }, "n")).toBe("rear");
    // Far flanks stay on their side.
    expect(classifyFiringArc(origin, { col: 1, row: 9 }, "n")).toBe("leftSide");
    expect(classifyFiringArc(origin, { col: 9, row: 9 }, "n")).toBe("rightSide");
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
    // Engine policy tied to TW p.119 (locked-in LOS hexside) — see
    // defenderArcChoice docstring. `front` wins; otherwise drop `rear`.
    expect(defenderArcChoice("front", null)).toBe("front");
    expect(defenderArcChoice("front", "leftSide")).toBe("front");
    expect(defenderArcChoice("leftSide", "front")).toBe("front");
    expect(defenderArcChoice("rear", "rightSide")).toBe("rightSide");
    expect(defenderArcChoice("leftSide", "rear")).toBe("leftSide");
    expect(defenderArcChoice("rear", "leftSide")).toBe("leftSide");
    expect(defenderArcChoice("rightSide", "rear")).toBe("rightSide");
  });

  it("classifies both arcs of a boundary pair", () => {
    // (2,4) -> (3,3) runs exactly along the n|ne sector edge: front on n,
    // right side on ne when facing northwest ('Mech 3-1-1-1).
    const b = bearingExact({ col: 2, row: 4 }, { col: 3, row: 3 })!;
    expect(b.boundary).not.toBeNull();
    const cls = classifyArcWithBoundary("nw", b);
    expect(cls.arc).toBe("front");
    expect(cls.altArc).toBe("rightSide");
  });
});
