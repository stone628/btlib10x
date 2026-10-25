import { buildUnitInit as buildUnitInitDist, createBattle as createBattleDist } from "btlib10x";
import { describe, expect, it } from "vitest";
import { neighbor } from "../src/core/hex";
import type { TerrainHexDef } from "../src/core/types";
import { type HexCoord, isArm, rotateFacing } from "../src/core/types";
import { mechDefFor } from "../src/data/mech.schema";
import { isFireableWeapon, weaponDef } from "../src/data/weapon.schema";
import {
  classifyArcWithBoundary,
  classifyFiringArc,
  effectiveFacingForTwist,
  twistDelta,
} from "../src/rules/arcs";
import { expectedClusterHits } from "../src/rules/cluster";
import { canFireFromLocation } from "../src/rules/damage";
import type { FireTarget } from "../src/rules/fireability";
import { bestFireTarget, hitProbability, suggestFireTargets } from "../src/rules/fireability";
import { buildUnitInit, createBattle } from "../src/rules/game/create";
import { declareAttacks, validateAttacks, validateAttacksImpl } from "../src/rules/game/declare";
import { advancePhase } from "../src/rules/game/loop";
import { resolveAllAttacks } from "../src/rules/game/resolveAttacks";
import { rollInitiativePhase } from "../src/rules/game/turnOrder";
import type { BattleState, GameEvent, UnitInit } from "../src/rules/game/types";
import { usableWeapons } from "../web/terminal/persona.common";
import { createTestBattle } from "./helpers/battle";
import { scriptedRng, seededRng } from "./helpers/rng";

function hbkVsEnf(terrain: readonly TerrainHexDef[] = []): BattleState {
  const units: UnitInit[] = [
    buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "ne"),
    buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 4 }, "nw"),
  ];
  return createTestBattle(terrain, units, false);
}

function startAttackTurn(state: BattleState): BattleState {
  rollInitiativePhase(state, scriptedRng(3, 3, 3, 1), []);
  advancePhase(state, [], scriptedRng()); // initiative -> movement
  advancePhase(state, [], scriptedRng()); // movement -> weaponAttack (nobody moved)
  return state;
}

function blockedReasons(state: BattleState, actor: string, target: string): string[] {
  const sugg = suggestFireTargets(state, actor);
  const t = sugg.targets.find((x) => x.targetId === target);
  return t?.blocked.map((b) => b.reason) ?? [];
}

describe("suggestFireTargets", () => {
  it("lists every HBK-4G weapon against an adjacent in-arc target", () => {
    const state = startAttackTurn(hbkVsEnf());
    const sugg = suggestFireTargets(state, "hbk");
    const enf = sugg.targets.find((t) => t.targetId === "enf");
    expect(enf).toBeDefined();
    expect(enf!.distance).toBe(1);
    expect(enf!.weapons.map((w) => w.weaponIndex).sort()).toEqual([1, 2, 3, 4]);
    const ac20 = enf!.weapons.find((w) => w.weaponIndex === 4)!;
    expect(ac20.weapon).toBe("AC/20");
    expect(ac20.rangeBracket).toBe("short");
    expect(ac20.tn).toBe(4); // gunnery 4 + short 0
    expect(ac20.expectedDamage).toBe(20);
    expect(ac20.shots).toBe(10);
    const ml = enf!.weapons.find((w) => w.weaponIndex === 1)!;
    expect(ml.expectedDamage).toBe(5);
    expect(ml.shots).toBeNull();
  });

  it("blocks weapons whose mounting arc does not cover the target", () => {
    // hbk faces nw; enf due south sits in the left side arc: only the
    // left-arm Medium Laser (weapon 1) may fire.
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "nw"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 5 }, "nw"),
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    const sugg = suggestFireTargets(state, "hbk");
    const enf = sugg.targets.find((t) => t.targetId === "enf")!;
    expect(enf.arc).toBe("leftSide");
    expect(enf.weapons.map((w) => w.weaponIndex)).toEqual([1]);
    expect(enf.blocked.map((b) => b.reason)).toEqual(["outOfArc", "outOfArc", "outOfArc"]);
  });

  it("marks a weapon jammed", () => {
    const orig = hbkVsEnf();
    const state = startAttackTurn(orig);
    state.units.hbk!.jammedWeapons = [1];
    const reasons = blockedReasons(state, "hbk", "enf");
    expect(reasons.filter((r) => r === "jammed")).toHaveLength(1);
    const sugg = suggestFireTargets(state, "hbk");
    const enf = sugg.targets.find((t) => t.targetId === "enf")!;
    expect(enf.weapons.map((w) => w.weaponIndex)).toEqual([2, 3, 4]);
  });

  it("marks an empty ammo bin", () => {
    const state = startAttackTurn(hbkVsEnf());
    // AC/20 bins are leftTorso slots 1-2; drain both.
    state.units.hbk!.ammoBins = {
      ...state.units.hbk!.ammoBins,
      "leftTorso:1": 0,
      "leftTorso:2": 0,
    };
    const reasons = blockedReasons(state, "hbk", "enf");
    expect(reasons.filter((r) => r === "outOfAmmo")).toHaveLength(1);
  });

  it("shows the shared pool count on every mount of a pooled weapon", () => {
    const units: UnitInit[] = [
      buildUnitInit("mad", "MC-MKII-2", 1, { col: 2, row: 4 }, "ne"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 4 }, "nw"),
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    const sugg = suggestFireTargets(state, "mad");
    const enf = sugg.targets.find((t) => t.targetId === "enf")!;
    // Four CL Streak SRM 4 mounts share one 50-shot pool (only mount #3
    // declares `shots`); each mount must report the pooled count.
    const streaks = enf.weapons.filter((w) => w.weapon === "CL Streak SRM 4");
    expect(streaks.map((w) => w.weaponIndex).sort()).toEqual([3, 4, 5, 6]);
    for (const w of streaks) {
      expect(w.shots).toBe(50);
    }
    // Non-ammo weapons still show no shots column.
    const erml = enf.weapons.find((w) => w.weapon === "CL ER Medium Laser")!;
    expect(erml.shots).toBeNull();
  });

  it("blocks every mount of a pooled weapon when the shared pool is dry", () => {
    const units: UnitInit[] = [
      buildUnitInit("mad", "MC-MKII-2", 1, { col: 2, row: 4 }, "ne"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 4 }, "nw"),
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    // Streak bins: rightTorso:7, leftTorso:7 (25 each).
    state.units.mad!.ammoBins = {
      ...state.units.mad!.ammoBins,
      "rightTorso:7": 0,
      "leftTorso:7": 0,
    };
    const sugg = suggestFireTargets(state, "mad");
    const enf = sugg.targets.find((t) => t.targetId === "enf")!;
    expect(enf.weapons.filter((w) => w.weapon === "CL Streak SRM 4")).toHaveLength(0);
    const dry = enf.blocked.filter((b) => b.weapon === "CL Streak SRM 4");
    expect(dry).toHaveLength(4);
    for (const b of dry) {
      expect(b.reason).toBe("outOfAmmo");
    }
  });

  it("marks a weapon whose location is destroyed", () => {
    const state = startAttackTurn(hbkVsEnf());
    state.units.hbk!.damage = {
      ...state.units.hbk!.damage,
      internalStructure: { ...state.units.hbk!.damage.internalStructure, rightTorso: 0 },
    };
    const reasons = blockedReasons(state, "hbk", "enf");
    // AC/20 (rightTorso) and the right-arm Medium Laser both lost support.
    expect(reasons.filter((r) => r === "destroyed")).toHaveLength(2);
  });

  it("marks weapons out of range", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 41 }, "n"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 1 }, "s"),
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    const reasons = blockedReasons(state, "hbk", "enf");
    expect(reasons.every((r) => r === "outOfRange")).toBe(true);
    const sugg = suggestFireTargets(state, "hbk");
    expect(sugg.targets.find((t) => t.targetId === "enf")!.weapons).toHaveLength(0);
  });

  it("applies the minimum-range penalty inside minimum range", () => {
    const units: UnitInit[] = [
      buildUnitInit("grf", "GRF-1N", 1, { col: 2, row: 4 }, "ne"),
      buildUnitInit("hbk", "HBK-4G", 2, { col: 3, row: 4 }, "nw"),
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    const sugg = suggestFireTargets(state, "grf");
    const hbk = sugg.targets.find((t) => t.targetId === "hbk")!;
    const ppc = hbk.weapons.find((w) => w.weapon === "PPC")!;
    // PPC min 3 at range 1: penalty = 3 - 1 + 1 = 3; TN = 4 + 0 + 3.
    expect(ppc.minRangePenalty).toBe(3);
    expect(ppc.tn).toBe(7);
    const lrm = hbk.weapons.find((w) => w.weapon === "LRM 10")!;
    expect(lrm.minRangePenalty).toBe(6);
    expect(lrm.tn).toBe(10);
  });

  it("omits the minimum-range penalty at or beyond minimum range", () => {
    const units: UnitInit[] = [
      buildUnitInit("grf", "GRF-1N", 1, { col: 2, row: 4 }, "ne"),
      buildUnitInit("hbk", "HBK-4G", 2, { col: 9, row: 4 }, "nw"),
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    const sugg = suggestFireTargets(state, "grf");
    const hbk = sugg.targets.find((t) => t.targetId === "hbk")!;
    expect(hbk.distance).toBe(7); // PPC medium bracket, beyond min range 3.
    const ppc = hbk.weapons.find((w) => w.weapon === "PPC")!;
    expect(ppc.minRangePenalty).toBeUndefined();
    expect(ppc.tn).toBe(6); // gunnery 4 + medium 2
  });

  it("marks weapons blocked when the target stands in deep water (losBlockedByWater)", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "ne"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 2 }, "nw"),
    ];
    const state = startAttackTurn(
      createTestBattle([{ col: 3, row: 2, type: "water2" }], units, false),
    );
    // Same gate as declareAttacks: water2/3 blocks LOS in/out, so every
    // weapon is rejected instead of offered for a declaration that would fail.
    const reasons = blockedReasons(state, "hbk", "enf");
    expect(reasons.every((r) => r === "noLos")).toBe(true);
    const sugg = suggestFireTargets(state, "hbk");
    expect(sugg.targets.find((t) => t.targetId === "enf")!.weapons).toHaveLength(0);
  });

  it("marks weapons blocked by an intervening building", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 10 }, "n"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 2 }, "s"),
    ];
    const state = startAttackTurn(
      createTestBattle([{ col: 2, row: 7, type: "lightBuilding", level: 1 }], units, false),
    );
    const reasons = blockedReasons(state, "hbk", "enf");
    expect(reasons).toContain("noLos");
    const sugg = suggestFireTargets(state, "hbk");
    expect(sugg.targets.find((t) => t.targetId === "enf")!.weapons).toHaveLength(0);
  });

  it("marks weapons blocked by intervening woods", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 10 }, "n"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 2 }, "s"),
    ];
    const state = startAttackTurn(
      createTestBattle(
        [
          { col: 2, row: 7, type: "heavyWoods" },
          { col: 2, row: 4, type: "heavyWoods" },
        ],
        units,
        false,
      ),
    );
    const reasons = blockedReasons(state, "hbk", "enf");
    expect(reasons).toContain("noLos");
    const sugg = suggestFireTargets(state, "hbk");
    expect(sugg.targets.find((t) => t.targetId === "enf")!.weapons).toHaveLength(0);
  });

  it("marks weapons that auto-miss", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 10 }, "n"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 1 }, "s"),
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    state.units.enf!.hexesMovedThisTurn = 30;
    const reasons = blockedReasons(state, "hbk", "enf");
    // long range (+4) + target moved 30 (+6) + gunnery 4 = 14 -> auto-miss.
    expect(reasons.filter((r) => r === "autoMiss").length).toBeGreaterThan(0);
    const sugg = suggestFireTargets(state, "hbk");
    expect(sugg.targets.find((t) => t.targetId === "enf")!.weapons).toHaveLength(0);
  });

  it("sorts targets best-first so first entry holds most firepower", () => {
    const origin = { col: 5, row: 5 };
    // Insert worst-first: rear (0 weapons), right side (arm only), front (all).
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, origin, "n"),
      buildUnitInit("rear", "ENF-4R", 2, neighbor(origin, "s"), "n"),
      buildUnitInit("side", "ENF-4R", 2, neighbor(origin, "se"), "n"),
      buildUnitInit("front", "ENF-4R", 2, neighbor(origin, "n"), "n"),
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    const sugg = suggestFireTargets(state, "hbk");
    expect(sugg.targets.map((t) => t.targetId)).toEqual(["front", "side", "rear"]);
    expect(sugg.targets[0]!.weapons).toHaveLength(4);
    // Right side arc: only right-arm Medium Laser (weapon 2) bears.
    expect(sugg.targets[1]!.arc).toBe("rightSide");
    expect(sugg.targets[1]!.weapons.map((w) => w.weaponIndex)).toEqual([2]);
    expect(sugg.targets[2]!.weapons).toHaveLength(0);
    expect(bestFireTarget(sugg)?.targetId).toBe("front");
  });

  it("records per-weapon firing arc in a side arc", () => {
    // HBK at (5,5) facing n; ENF at the southeast-adjacent hex (6,5), solidly
    // in the rightSide template arc (the p.105 template has no boundary
    // hexes, so altArc stays null). No HBK weapon fires into rear, so only
    // the matching right-arm Medium Laser (weapon 2) bears.
    const origin = { col: 5, row: 5 };
    const sideHex = { col: 6, row: 5 };
    expect(classifyFiringArc(origin, sideHex, "n")).toBe("rightSide");
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, origin, "n"),
      buildUnitInit("enf", "ENF-4R", 2, sideHex, "s"),
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    const sugg = suggestFireTargets(state, "hbk");
    const enf = sugg.targets.find((t) => t.targetId === "enf")!;
    expect(enf.arc).toBe("rightSide");
    expect(enf.altArc).toBeNull();
    // Only matching side arm bears; rear impossible without rear mounts.
    expect(enf.weapons.map((w) => w.weaponIndex)).toEqual([2]);
    expect(enf.weapons[0]!.arc).toBe("rightSide");
  });
});

describe("API-F01 cluster expectedDamage", () => {
  it("scores a cluster launcher by its expected hits, not the full volley", () => {
    const units: UnitInit[] = [
      buildUnitInit("as7", "AS7-D", 1, { col: 2, row: 4 }, "n"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 1 }, "s"),
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    const enf = suggestFireTargets(state, "as7").targets.find((t) => t.targetId === "enf")!;
    const lrm = enf.weapons.find((w) => w.weapon === "LRM 20")!;
    expect(lrm.expectedDamage).toBeCloseTo(expectedClusterHits(20), 10);
    expect(lrm.cluster).toEqual({ shots: 20, perMissile: 1 });
    const srm = enf.weapons.find((w) => w.weapon === "SRM 6")!;
    expect(srm.expectedDamage).toBeCloseTo(2 * expectedClusterHits(6), 10);
    expect(srm.cluster).toEqual({ shots: 6, perMissile: 2 });
  });

  it("keeps the full volley for Streak launchers (every missile hits)", () => {
    const units: UnitInit[] = [
      buildUnitInit("mad", "MC-MKII-2", 1, { col: 2, row: 4 }, "ne"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 4 }, "nw"),
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    const enf = suggestFireTargets(state, "mad").targets.find((t) => t.targetId === "enf")!;
    const streaks = enf.weapons.filter((w) => w.weapon === "CL Streak SRM 4");
    expect(streaks).toHaveLength(4);
    for (const w of streaks) {
      expect(w.expectedDamage).toBe(8);
    }
  });
});

describe("hitProbability", () => {
  it("is P(2D6 >= tn) with automatic hit at 2 or less and miss over 12 (TW p. 106)", () => {
    expect(hitProbability(2)).toBe(1);
    expect(hitProbability(-1)).toBe(1);
    expect(hitProbability(7)).toBeCloseTo(21 / 36, 10);
    expect(hitProbability(8)).toBeCloseTo(15 / 36, 10);
    expect(hitProbability(12)).toBeCloseTo(1 / 36, 10);
    expect(hitProbability(13)).toBe(0);
  });
});

describe("torso", () => {
  function startAttackTurn(state: BattleState): BattleState {
    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
    advancePhase(state, [], scriptedRng());
    return state;
  }

  function hbkFacingAt(targetBearing: "se" | "nw"): {
    units: UnitInit[];
    facing: "n" | "ne";
    enemy: { col: number; row: number };
  } {
    if (targetBearing === "se") {
      return {
        units: [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "n"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 5 }, "sw"),
        ],
        facing: "n",
        enemy: { col: 3, row: 5 },
      };
    }
    return {
      units: [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "ne"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 1, row: 4 }, "sw"),
      ],
      facing: "ne",
      enemy: { col: 1, row: 4 },
    };
  }

  describe("twistDelta + effectiveFacingForTwist", () => {
    it("maps left to -1, right to +1, front to 0", () => {
      expect(twistDelta("leftSide")).toBe(-1);
      expect(twistDelta("rightSide")).toBe(1);
      expect(twistDelta("front")).toBe(0);
    });

    it("rotates facing by twist delta (or no-op for front)", () => {
      expect(effectiveFacingForTwist("n", "leftSide")).toBe("nw");
      expect(effectiveFacingForTwist("n", "rightSide")).toBe("ne");
      expect(effectiveFacingForTwist("n", "front")).toBe("n");
      expect(effectiveFacingForTwist("ne", "leftSide")).toBe("n");
      expect(effectiveFacingForTwist("ne", "rightSide")).toBe("se");
    });

    it("matches rotateFacing for non-zero deltas", () => {
      for (const f of ["n", "ne", "se", "s", "sw", "nw"] as const) {
        expect(effectiveFacingForTwist(f, "leftSide")).toBe(rotateFacing(f, -1));
        expect(effectiveFacingForTwist(f, "rightSide")).toBe(rotateFacing(f, 1));
      }
    });
  });

  describe("classifyArcWithBoundary on a twisted facing", () => {
    it("moves a front-diagonal bearing into the front arc under a right twist", () => {
      // Under 'Mech attack direction (TW p.119, 3-1-1-1) ne from n is already
      // front; use the true right-side bearing (se) so the twist has
      // something to move.
      const b = classifyArcWithBoundary("n", { facing: "se", boundary: null });
      expect(b.arc).toBe("rightSide");
      const twisted = classifyArcWithBoundary(effectiveFacingForTwist("n", "rightSide"), {
        facing: "se",
        boundary: null,
      });
      expect(twisted.arc).toBe("front");
    });

    it("moves a front-diagonal bearing into the front arc under a left twist", () => {
      // Likewise nw from ne is the true left-side bearing (offset 4).
      const b = classifyArcWithBoundary("ne", { facing: "nw", boundary: null });
      expect(b.arc).toBe("leftSide");
      const twisted = classifyArcWithBoundary(effectiveFacingForTwist("ne", "leftSide"), {
        facing: "nw",
        boundary: null,
      });
      expect(twisted.arc).toBe("front");
    });
  });

  describe("suggestFireTargets with torso twist", () => {
    it("without twist only the right-arm weapon fires into the body's right side", () => {
      const { units, facing } = hbkFacingAt("se");
      expect(facing).toBe("n");
      const state = startAttackTurn(createTestBattle([], units, false));
      const sugg = suggestFireTargets(state, "hbk");
      const enf = sugg.targets.find((t) => t.targetId === "enf")!;
      expect(enf.arc).toBe("rightSide");
      expect(enf.weapons.map((w) => w.weaponIndex).sort()).toEqual([2]);
    });

    it("with twist=right all four weapons fire (twisted front arc)", () => {
      const { units } = hbkFacingAt("se");
      const state = startAttackTurn(createTestBattle([], units, false));
      const sugg = suggestFireTargets(state, "hbk", "rightSide");
      const enf = sugg.targets.find((t) => t.targetId === "enf")!;
      expect(enf.arc).toBe("front");
      expect(enf.weapons.map((w) => w.weaponIndex).sort()).toEqual([1, 2, 3, 4]);
    });

    it("with twist=left on a left-bearing target lets every weapon fire", () => {
      const { units, facing } = hbkFacingAt("nw");
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
  });

  describe("declareAttacks with torso twist", () => {
    it("accepts a leftArm weapon when twist shifts the bearing into the front arc", () => {
      const { units } = hbkFacingAt("se");
      const state = startAttackTurn(createTestBattle([], units, false));
      expect(() =>
        declareAttacks(
          state,
          "hbk",
          [{ weaponIndex: 1, targetId: "enf" }],
          [],
          [],
          scriptedRng(4),
          {
            twist: "rightSide",
          },
        ),
      ).not.toThrow();
    });

    it("rejects the same weapon without twist (target outside its firing arc)", () => {
      const { units } = hbkFacingAt("se");
      const state = startAttackTurn(createTestBattle([], units, false));
      expect(() =>
        declareAttacks(
          state,
          "hbk",
          [{ weaponIndex: 1, targetId: "enf" }],
          [],
          [],
          scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
        ),
      ).toThrow(/firing arc/);
    });

    it("rejects the rightArm weapon when twist=right turns the target to the rear", () => {
      // hbk faces ne with the target in its leftSide arc; twisting right
      // (effective se) swings the side target behind the torso (rear arc),
      // so the right-arm ML no longer bears.
      const { units, facing } = hbkFacingAt("nw");
      expect(facing).toBe("ne");
      const state = startAttackTurn(createTestBattle([], units, false));
      expect(() =>
        declareAttacks(
          state,
          "hbk",
          [{ weaponIndex: 2, targetId: "enf" }],
          [],
          [],
          scriptedRng(4),
          {
            twist: "rightSide",
          },
        ),
      ).toThrow(/firing arc/);
    });
  });
});

describe("leg-weapon", () => {
  /**
   * Leg-mounted weapons need only their leg: a destroyed side torso takes the
   * arm on that side (TW p.122) but not the leg, so the leg mount still fires.
   * Crusader CRD-3R carries an SRM 6 in each leg.
   */

  const CRD = "CRD-3R";
  const RA_MEDIUM_LASER = 2;
  const RL_SRM6 = 6;

  /** CRD-3R at (5,5) facing north and a target two hexes ahead, in the attack phase. */
  function crusaderBattle(targetHex: HexCoord = { col: 5, row: 3 }): BattleState {
    const battle = createBattle(
      { name: "leg", width: 20, height: 20, terrain: [], legends: [] },
      [
        buildUnitInit("a", CRD, 1, { col: 5, row: 5 }, "n"),
        buildUnitInit("t", "HBK-4G", 2, targetHex, "s"),
      ],
      { critsDisabled: true },
    );
    battle.phase = "attack";
    battle.initiativeWinnerTeam = 2;
    battle.actorQueue = ["a", "t"];
    battle.actedThisPhase = [];
    return battle;
  }

  function withRightTorsoGone(): BattleState {
    const battle = crusaderBattle();
    const damage = battle.units.a!.damage;
    damage.internalStructure.rightTorso = 0;
    damage.internalStructure.rightArm = 0;
    return battle;
  }

  describe("leg-mounted weapons with the side torso destroyed", () => {
    it("canFireFromLocation: the leg stays usable, the arm does not", () => {
      const damage = withRightTorsoGone().units.a!.damage;
      expect(canFireFromLocation(damage, "rightLeg")).toBe(true);
      expect(canFireFromLocation(damage, "rightArm")).toBe(false);
      damage.internalStructure.rightLeg = 0;
      expect(canFireFromLocation(damage, "rightLeg")).toBe(false);
    });

    it("an arm still needs its side torso even with arm structure left", () => {
      const damage = crusaderBattle().units.a!.damage;
      damage.internalStructure.rightTorso = 0;
      expect(canFireFromLocation(damage, "rightArm")).toBe(false);
    });

    it("validateAttacksImpl accepts the leg SRM and rejects the arm laser", () => {
      const battle = withRightTorsoGone();
      expect(() =>
        validateAttacksImpl(battle, "a", [{ weaponIndex: RL_SRM6, targetId: "t" }]),
      ).not.toThrow();
      expect(() =>
        validateAttacksImpl(battle, "a", [{ weaponIndex: RA_MEDIUM_LASER, targetId: "t" }]),
      ).toThrow(/destroyed or its support torso is gone/);
    });

    // With the arm gone a prone 'Mech cannot prop up to fire at all, so the
    // leg mount stays silenced while prone.
    it("the leg SRM still cannot fire while prone", () => {
      const battle = withRightTorsoGone();
      battle.units.a!.prone = true;
      expect(() =>
        validateAttacksImpl(battle, "a", [{ weaponIndex: RL_SRM6, targetId: "t" }]),
      ).toThrow(/cannot fire while prone/);
    });

    it("suggestFireTargets lists the leg SRM and blocks the arm laser as destroyed", () => {
      const target = suggestFireTargets(withRightTorsoGone(), "a").targets.find(
        (t) => t.targetId === "t",
      )!;
      expect(target.weapons.some((w) => w.weaponIndex === RL_SRM6)).toBe(true);
      expect(target.blocked).toContainEqual(
        expect.objectContaining({ weaponIndex: RA_MEDIUM_LASER, reason: "destroyed" }),
      );
    });
  });

  /**
   * Leg mounts fire along the feet, never the twisted torso (TW p.105,
   * Rotating the Firing Arcs). With the CRD-3R facing north at (5,5) and the
   * torso twisted right, (3,3) is front for the feet but left side for the
   * torso, and (8,5) is right side for the feet but front for the torso.
   * `suggestFireTargets` must classify the leg SRM the way declaration does.
   */
  describe("leg-mounted weapons with the torso twisted (API-F04)", () => {
    const TWIST = "rightSide" as const;

    function candidate(battle: BattleState) {
      const target = suggestFireTargets(battle, "a", TWIST).targets.find(
        (t) => t.targetId === "t",
      )!;
      return {
        offered: target.weapons.find((w) => w.weaponIndex === RL_SRM6),
        blocked: target.blocked.find((b) => b.weaponIndex === RL_SRM6),
      };
    }

    it("offers the leg SRM at a target in the feet's front arc, off the twisted torso", () => {
      const battle = crusaderBattle({ col: 3, row: 3 });
      const { offered, blocked } = candidate(battle);
      expect(blocked).toBeUndefined();
      expect(offered?.arc).toBe("front");
      expect(() =>
        validateAttacksImpl(battle, "a", [{ weaponIndex: RL_SRM6, targetId: "t" }], [], {
          twist: TWIST,
        }),
      ).not.toThrow();
    });

    it("blocks the leg SRM at a target in the twisted torso's front but off the feet", () => {
      const battle = crusaderBattle({ col: 8, row: 5 });
      const { offered, blocked } = candidate(battle);
      expect(offered).toBeUndefined();
      expect(blocked?.reason).toBe("outOfArc");
      expect(() =>
        validateAttacksImpl(battle, "a", [{ weaponIndex: RL_SRM6, targetId: "t" }], [], {
          twist: TWIST,
        }),
      ).toThrow(/cannot fire into the rightSide arc/);
    });

    it("arm mounts still follow the twist", () => {
      const front = suggestFireTargets(crusaderBattle({ col: 8, row: 5 }), "a", TWIST).targets[0]!;
      expect(front.weapons.find((w) => w.weaponIndex === RA_MEDIUM_LASER)?.arc).toBe("front");
      const side = suggestFireTargets(crusaderBattle({ col: 3, row: 3 }), "a", TWIST).targets[0]!;
      expect(side.blocked).toContainEqual(
        expect.objectContaining({ weaponIndex: RA_MEDIUM_LASER, reason: "outOfArc" }),
      );
    });
  });

  /**
   * TW p.105: leg-mounted weapons may not fire through a hex that gives the
   * firing 'Mech partial cover (TW p.102 conditions, mirrored to the shooter;
   * Depth 1 water around the shooter counts). CRD-3R at (5,5) facing north,
   * target three hexes ahead at (5,2).
   */
  describe("leg-mounted weapons through the shooter's own partial cover (FIRE-02)", () => {
    function battleOn(terrain: readonly TerrainHexDef[], targetLevel = 0): BattleState {
      const target: TerrainHexDef[] =
        targetLevel > 0 ? [{ col: 5, row: 2, type: "clear", level: targetLevel }] : [];
      const battle = createBattle(
        { name: "leg", width: 20, height: 20, terrain: [...terrain, ...target], legends: [] },
        [
          buildUnitInit("a", CRD, 1, { col: 5, row: 5 }, "n"),
          buildUnitInit("t", "HBK-4G", 2, { col: 5, row: 2 }, "s"),
        ],
        { critsDisabled: true },
      );
      battle.phase = "attack";
      battle.initiativeWinnerTeam = 2;
      battle.actorQueue = ["a", "t"];
      battle.actedThisPhase = [];
      return battle;
    }

    function legState(battle: BattleState) {
      const target = suggestFireTargets(battle, "a").targets.find((t) => t.targetId === "t")!;
      return {
        offered: target.weapons.some((w) => w.weaponIndex === RL_SRM6),
        blocked: target.blocked.find((b) => b.weaponIndex === RL_SRM6)?.reason,
        armOffered: target.weapons.some((w) => w.weaponIndex === RA_MEDIUM_LASER),
      };
    }

    const declareLeg = (battle: BattleState) => () =>
      validateAttacksImpl(battle, "a", [{ weaponIndex: RL_SRM6, targetId: "t" }]);

    it("open ground: the leg SRM fires", () => {
      const battle = battleOn([]);
      expect(legState(battle)).toEqual({ offered: true, blocked: undefined, armOffered: true });
      expect(declareLeg(battle)).not.toThrow();
    });

    it("a one-level hill adjacent to the shooter, between it and the target, blocks it", () => {
      const battle = battleOn([{ col: 5, row: 4, type: "clear", level: 1 }]);
      expect(legState(battle)).toEqual({ offered: false, blocked: "legCover", armOffered: true });
      expect(declareLeg(battle)).toThrow(/leg-mounted weapons may not fire through a hex/);
    });

    it("an adjacent building one level below the shooter's hex still blocks it (+2)", () => {
      const battle = battleOn([
        { col: 5, row: 5, type: "clear", level: 1 },
        { col: 5, row: 4, type: "lightBuilding", level: 0 },
      ]);
      expect(legState(battle).blocked).toBe("legCover");
    });

    it("the shooter standing in Depth 1 water cannot fire it", () => {
      const battle = battleOn([{ col: 5, row: 5, type: "water1" }]);
      expect(legState(battle)).toMatchObject({ offered: false, blocked: "legCover" });
      expect(declareLeg(battle)).toThrow(/leg-mounted weapons may not fire through a hex/);
    });

    it("no cover when the target stands higher (fired at uphill)", () => {
      const battle = battleOn([{ col: 5, row: 4, type: "clear", level: 1 }], 2);
      expect(legState(battle)).toMatchObject({ offered: true, blocked: undefined });
      expect(declareLeg(battle)).not.toThrow();
    });

    it("a hill behind the shooter gives no cover toward the target", () => {
      const battle = battleOn([{ col: 5, row: 6, type: "clear", level: 1 }]);
      expect(legState(battle)).toMatchObject({ offered: true, blocked: undefined });
      expect(declareLeg(battle)).not.toThrow();
    });
  });
});

describe("equipment-fire", () => {
  const createBattle = createBattleDist;
  // Every chassis in the catalog that mounts a TAG, with the TAG's weapon index.
  // TAG (TW pp.142-143) designates rather than damages and awaits the equipment
  // pipeline (docs/VISION.md §4): it must never reach weapon-attack resolution,
  // where a hit used to push a 0-damage group into `applyDamage` and throw.
  const TAG_MOUNTS = [
    { model: "SL-1G", tag: 4 },
    { model: "SL-1H", tag: 4 },
    { model: "FFL-3A", tag: 9 },
    { model: "SPT-N2", tag: 1 },
  ] as const;

  const ATTACKER = { col: 4, row: 6 };
  const TARGET = { col: 4, row: 3 };

  function setup(model: string) {
    const state = createTestBattle(
      [],
      [buildUnitInit("a", model, 1, ATTACKER, "n"), buildUnitInit("t", "ENF-4R", 2, TARGET, "s")],
      true,
    );
    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
    advancePhase(state, [], scriptedRng());
    return state;
  }

  describe("equipment is not a fireable weapon", () => {
    it("treats every EQUIPMENT row as non-fireable and every other row as fireable", () => {
      for (const name of ["TAG", "CL TAG", "CL Narc Missile Beacon", "CL ECM Suite", "Hatchet"]) {
        expect(isFireableWeapon(weaponDef(name)!)).toBe(false);
      }
      for (const name of ["Medium Laser", "AC/20", "LRM 20", "CL Plasma Cannon"]) {
        expect(isFireableWeapon(weaponDef(name)!)).toBe(true);
      }
    });

    for (const { model, tag } of TAG_MOUNTS) {
      describe(model, () => {
        it("mounts the TAG at the expected index", () => {
          expect(mechDefFor(setup(model).units.a!).weapons[tag]!.weapon).toBe("TAG");
        });

        it("refuses a TAG declaration", () => {
          const decl = [{ weaponIndex: tag, targetId: "t" }];
          expect(() => validateAttacksImpl(setup(model), "a", decl)).toThrow(
            /TAG on a is equipment, not a fireable weapon/,
          );
          const state = setup(model);
          expect(() => declareAttacks(state, "a", decl, [], [], seededRng(1))).toThrow(
            /not a fireable weapon/,
          );
          expect(state.units.a!.declaredWeaponAttacks).toEqual([]);
        });

        it("leaves the TAG out of fire suggestions, fireable and blocked alike", () => {
          for (const target of suggestFireTargets(setup(model), "a").targets) {
            const listed = [
              ...target.weaponsIfPropLeft,
              ...target.weaponsIfPropRight,
              ...target.blocked,
            ];
            expect(listed.map((w) => w.weaponIndex)).not.toContain(tag);
          }
        });

        it("leaves the TAG out of the shell's usable weapons", () => {
          const state = createBattle({ name: "t", width: 9, height: 9, terrain: [], legends: [] }, [
            buildUnitInitDist("a", model, 1, ATTACKER, "n"),
            buildUnitInitDist("t", "ENF-4R", 2, TARGET, "s"),
          ]);
          const usable = usableWeapons(state.units.a!);
          expect(usable.length).toBeGreaterThan(0);
          expect(usable.map((w) => w.index)).not.toContain(tag);
        });

        it("still resolves every suggested weapon without throwing", () => {
          const state = setup(model);
          const target = suggestFireTargets(state, "a").targets.find((t) => t.targetId === "t")!;
          const decls = target.weaponsIfPropLeft.map((w) => ({
            weaponIndex: w.weaponIndex,
            targetId: "t",
          }));
          expect(decls.length).toBeGreaterThan(0);
          const events: GameEvent[] = [];
          declareAttacks(state, "a", decls, [], events, seededRng(2));
          expect(() =>
            resolveAllAttacks(state, scriptedRng(...Array(64).fill(6)), events),
          ).not.toThrow();
        });
      });
    }
  });
});

describe("suggest-club", () => {
  /**
   * API-F02: a held club occupies both hands (TW p.146), so
   * `suggestFireTargets` blocks arm mounts with `clubHeld` exactly when
   * `validateAttacks` would refuse them, and `dropClub` lifts the block the
   * same way on both.
   */

  function faceToFace(): BattleState {
    const battle = createBattle({ name: "club", width: 12, height: 12, terrain: [], legends: [] }, [
      buildUnitInit("a", "HBK-4G", 1, { col: 5, row: 5 }, "n"),
      buildUnitInit("t", "HBK-4G", 2, { col: 5, row: 3 }, "s"),
    ]);
    battle.phase = "attack";
    battle.initiativeWinnerTeam = 2;
    battle.actorQueue = ["a", "t"];
    battle.actedThisPhase = [];
    return battle;
  }

  function holdClub(battle: BattleState): void {
    battle.units.a!.club = { kind: "limb", limb: "rightArm", model: "HBK-4G", ownerId: "x" };
  }

  function target(battle: BattleState, dropClub?: boolean): FireTarget {
    const t = suggestFireTargets(battle, "a", "front", dropClub).targets[0];
    expect(t?.targetId).toBe("t");
    return t!;
  }

  function armIndices(battle: BattleState): number[] {
    const def = mechDefFor(battle.units.a!);
    return Object.entries(def.weapons)
      .filter(([, m]) => isArm(m.location))
      .map(([k]) => Number(k));
  }

  describe("suggestFireTargets with a held club (API-F02)", () => {
    it("lists arm weapons when no club is held, with or without dropClub", () => {
      const battle = faceToFace();
      const arms = armIndices(battle);
      expect(arms.length).toBeGreaterThan(0);
      for (const drop of [undefined, true]) {
        const offered = target(battle, drop).weapons.map((w) => w.weaponIndex);
        for (const i of arms) expect(offered).toContain(i);
      }
    });

    it("blocks arm mounts with clubHeld while a club is held", () => {
      const battle = faceToFace();
      holdClub(battle);
      const t = target(battle);
      const arms = armIndices(battle);
      for (const list of [t.weaponsIfPropLeft, t.weaponsIfPropRight]) {
        expect(list.some((w) => isArm(w.location))).toBe(false);
        expect(list.length).toBeGreaterThan(0);
      }
      for (const list of [t.blockedIfPropLeft, t.blockedIfPropRight]) {
        const held = list.filter((b) => b.reason === "clubHeld").map((b) => b.weaponIndex);
        expect(held.sort()).toEqual([...arms].sort());
      }
    });

    it("every suggested volley is accepted by validateAttacks, with and without the drop", () => {
      const battle = faceToFace();
      holdClub(battle);
      for (const dropClub of [false, true]) {
        const t = target(battle, dropClub);
        const decls = t.weapons.map((w) => ({ targetId: t.targetId, weaponIndex: w.weaponIndex }));
        expect(() => validateAttacks(battle, "a", decls, [], { dropClub })).not.toThrow();
      }
      // The drop frees the hands: the arm weapons come back.
      const dropped = target(battle, true).weapons.map((w) => w.weaponIndex);
      for (const i of armIndices(battle)) expect(dropped).toContain(i);
    });
  });
});
