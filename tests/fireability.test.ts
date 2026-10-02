import { describe, expect, it } from "vitest";
import { neighbor } from "../src/core/hex";
import { classifyFiringArc } from "../src/rules/arcs";
import { bestFireTarget, suggestFireTargets } from "../src/rules/fireability";
import type { BattleState, TerrainHexDef, UnitInit } from "../src/rules/game";
import { advancePhase, rollInitiativePhase } from "../src/rules/game";
import { createTestBattle, scriptedRng } from "./helpers";

function hbkVsEnf(terrain: readonly TerrainHexDef[] = []): BattleState {
  const units: UnitInit[] = [
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
      position: { col: 3, row: 4 },
      facing: "nw",
    },
  ];
  return createTestBattle(terrain, units, false);
}

function startAttackTurn(state: BattleState): BattleState {
  rollInitiativePhase(state, scriptedRng(3, 3, 3, 1), []);
  advancePhase(state, []); // initiative -> movement
  advancePhase(state, []); // movement -> weaponAttack (nobody moved)
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
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 4 },
        facing: "nw",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 5 },
        facing: "nw",
      },
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
      "leftTorso:1": {
        id: "leftTorso:1",
        location: "leftTorso",
        slotIndex: 1,
        weaponIndex: 4,
        weapon: "AC/20",
        shots: 0,
      },
      "leftTorso:2": {
        id: "leftTorso:2",
        location: "leftTorso",
        slotIndex: 2,
        weaponIndex: 4,
        weapon: "AC/20",
        shots: 0,
      },
    };
    const reasons = blockedReasons(state, "hbk", "enf");
    expect(reasons.filter((r) => r === "outOfAmmo")).toHaveLength(1);
  });

  it("shows the shared pool count on every mount of a pooled weapon", () => {
    const units: UnitInit[] = [
      {
        id: "mad",
        model: "MC-MKII-2",
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
        position: { col: 3, row: 4 },
        facing: "nw",
      },
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
      {
        id: "mad",
        model: "MC-MKII-2",
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
        position: { col: 3, row: 4 },
        facing: "nw",
      },
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    // Streak bins: rightTorso:7, leftTorso:7 (25 each).
    state.units.mad!.ammoBins = {
      ...state.units.mad!.ammoBins,
      "rightTorso:7": {
        id: "rightTorso:7",
        location: "rightTorso",
        slotIndex: 7,
        weaponIndex: 3,
        weapon: "CL Streak SRM 4",
        shots: 0,
      },
      "leftTorso:7": {
        id: "leftTorso:7",
        location: "leftTorso",
        slotIndex: 7,
        weaponIndex: 3,
        weapon: "CL Streak SRM 4",
        shots: 0,
      },
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
    const damage = {
      ...state.units.hbk!.baseDamage,
      internalStructure: { ...state.units.hbk!.baseDamage.internalStructure, rightTorso: 0 },
    };
    state.units.hbk!.baseDamage = damage;
    const reasons = blockedReasons(state, "hbk", "enf");
    // AC/20 (rightTorso) and the right-arm Medium Laser both lost support.
    expect(reasons.filter((r) => r === "destroyed")).toHaveLength(2);
  });

  it("marks weapons out of range", () => {
    const units: UnitInit[] = [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 2 },
        facing: "n",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: -38 },
        facing: "s",
      },
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    const reasons = blockedReasons(state, "hbk", "enf");
    expect(reasons.every((r) => r === "outOfRange")).toBe(true);
    const sugg = suggestFireTargets(state, "hbk");
    expect(sugg.targets.find((t) => t.targetId === "enf")!.weapons).toHaveLength(0);
  });

  it("applies the minimum-range penalty inside minimum range", () => {
    const units: UnitInit[] = [
      {
        id: "grf",
        model: "GRF-1N",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 4 },
        facing: "ne",
      },
      {
        id: "hbk",
        model: "HBK-4G",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 3, row: 4 },
        facing: "nw",
      },
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
      {
        id: "grf",
        model: "GRF-1N",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 4 },
        facing: "ne",
      },
      {
        id: "hbk",
        model: "HBK-4G",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 9, row: 4 },
        facing: "nw",
      },
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
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 2 },
        facing: "ne",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 3, row: 2 },
        facing: "nw",
      },
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
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 10 },
        facing: "n",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 2 },
        facing: "s",
      },
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
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 10 },
        facing: "n",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 2 },
        facing: "s",
      },
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
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 2 },
        facing: "n",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: -7 },
        facing: "s",
      },
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    state.units.enf!.movesThisTurn = Array(30).fill("forward");
    const reasons = blockedReasons(state, "hbk", "enf");
    // long range (+4) + target moved 30 (+6) + gunnery 4 = 14 -> auto-miss.
    expect(reasons.filter((r) => r === "autoMiss").length).toBeGreaterThan(0);
    const sugg = suggestFireTargets(state, "hbk");
    expect(sugg.targets.find((t) => t.targetId === "enf")!.weapons).toHaveLength(0);
  });

  it("counts reversed hexes toward the target movement modifier", () => {
    const units: UnitInit[] = [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 2 },
        facing: "n",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: -7 },
        facing: "s",
      },
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    state.units.enf!.movesThisTurn = [...Array(18).fill("forward"), ...Array(12).fill("backward")];
    const reasons = blockedReasons(state, "hbk", "enf");
    // 30 hexes total -> target +6, long range +4, gunnery 4 = 14 -> auto-miss.
    expect(reasons.filter((r) => r === "autoMiss").length).toBeGreaterThan(0);
  });

  it("sorts targets best-first so first entry holds most firepower", () => {
    const origin = { col: 5, row: 5 };
    // Insert worst-first: rear (0 weapons), right side (arm only), front (all).
    const units: UnitInit[] = [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: origin,
        facing: "n",
      },
      {
        id: "rear",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: neighbor(origin, "s"),
        facing: "n",
      },
      {
        id: "side",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: neighbor(origin, "se"),
        facing: "n",
      },
      {
        id: "front",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: neighbor(origin, "n"),
        facing: "n",
      },
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
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: origin,
        facing: "n",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: sideHex,
        facing: "s",
      },
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
