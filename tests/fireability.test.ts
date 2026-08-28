import { describe, expect, it } from "vitest";
import { suggestFireTargets } from "../src/rules/fireability.js";
import type { BattleState, TerrainHexDef } from "../src/rules/game.js";
import { advancePhase, createBattle, rollInitiativePhase } from "../src/rules/game.js";
import { scriptedRng } from "./helpers.js";

function hbkVsEnf(terrain: readonly TerrainHexDef[] = []): BattleState {
  return createBattle(
    [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: 0, row: 2 },
        facing: "se",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 1, row: 2 },
        facing: "nw",
      },
    ],
    { terrain },
  );
}

function startAttackTurn(state: BattleState): BattleState {
  rollInitiativePhase(state, scriptedRng(3, 3, 3, 1));
  advancePhase(state); // initiative -> movement
  advancePhase(state); // movement -> weaponAttack (nobody moved)
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
    expect(enf!.weapons.map((w) => w.weaponIndex).sort()).toEqual([0, 1, 2, 3]);
    const ac20 = enf!.weapons.find((w) => w.weaponIndex === 0)!;
    expect(ac20.weapon).toBe("Autocannon/20");
    expect(ac20.rangeBracket).toBe("short");
    expect(ac20.tn).toBe(4); // gunnery 4 + short 0
    expect(ac20.expectedDamage).toBe(20);
    expect(ac20.ammoShots).toBe(10);
    const ml = enf!.weapons.find((w) => w.weaponIndex === 1)!;
    expect(ml.expectedDamage).toBe(5);
    expect(ml.ammoShots).toBeNull();
  });

  it("marks a weapon jammed", () => {
    const orig = hbkVsEnf();
    const state = startAttackTurn(orig);
    state.units.hbk!.jammedWeapons = [0];
    const reasons = blockedReasons(state, "hbk", "enf");
    expect(reasons.filter((r) => r === "jammed")).toHaveLength(1);
    const sugg = suggestFireTargets(state, "hbk");
    const enf = sugg.targets.find((t) => t.targetId === "enf")!;
    expect(enf.weapons.map((w) => w.weaponIndex)).toEqual([1, 2, 3]);
  });

  it("marks an empty ammo bin", () => {
    const state = startAttackTurn(hbkVsEnf());
    state.units.hbk!.ammoLeft = { ...state.units.hbk!.ammoLeft, 0: 0 };
    const reasons = blockedReasons(state, "hbk", "enf");
    expect(reasons.filter((r) => r === "outOfAmmo")).toHaveLength(1);
  });

  it("marks a weapon whose location is destroyed", () => {
    const state = startAttackTurn(hbkVsEnf());
    const armor = { ...state.units.hbk!.phaseStartArmor, rightTorso: 0 };
    state.units.hbk!.phaseStartArmor = armor;
    const reasons = blockedReasons(state, "hbk", "enf");
    // AC/20 (rightTorso) and the right-arm Medium Laser both lost support.
    expect(reasons.filter((r) => r === "destroyed")).toHaveLength(2);
  });

  it("marks weapons out of range", () => {
    const state = startAttackTurn(
      createBattle(
        [
          {
            id: "hbk",
            model: "HBK-4G",
            team: 0,
            gunnery: 4,
            position: { col: 0, row: 0 },
            facing: "n",
          },
          {
            id: "enf",
            model: "ENF-4R",
            team: 1,
            gunnery: 4,
            position: { col: 0, row: -40 },
            facing: "s",
          },
        ],
        {},
      ),
    );
    const reasons = blockedReasons(state, "hbk", "enf");
    expect(reasons.every((r) => r === "outOfRange")).toBe(true);
    const sugg = suggestFireTargets(state, "hbk");
    expect(sugg.targets.find((t) => t.targetId === "enf")!.weapons).toHaveLength(0);
  });

  it("marks weapons blocked by intervening woods", () => {
    const state = startAttackTurn(
      createBattle(
        [
          {
            id: "hbk",
            model: "HBK-4G",
            team: 0,
            gunnery: 4,
            position: { col: 0, row: 0 },
            facing: "n",
          },
          {
            id: "enf",
            model: "ENF-4R",
            team: 1,
            gunnery: 4,
            position: { col: 0, row: -9 },
            facing: "s",
          },
        ],
        {
          terrain: [
            { col: 0, row: -3, type: "heavyWoods" },
            { col: 0, row: -6, type: "heavyWoods" },
          ],
        },
      ),
    );
    const reasons = blockedReasons(state, "hbk", "enf");
    expect(reasons).toContain("noLos");
    const sugg = suggestFireTargets(state, "hbk");
    expect(sugg.targets.find((t) => t.targetId === "enf")!.weapons).toHaveLength(0);
  });

  it("marks weapons that auto-miss", () => {
    const state = startAttackTurn(
      createBattle(
        [
          {
            id: "hbk",
            model: "HBK-4G",
            team: 0,
            gunnery: 4,
            position: { col: 0, row: 0 },
            facing: "n",
          },
          {
            id: "enf",
            model: "ENF-4R",
            team: 1,
            gunnery: 4,
            position: { col: 0, row: -9 },
            facing: "s",
          },
        ],
        {},
      ),
    );
    state.units.enf!.movesThisTurn = Array(30).fill("forward");
    const reasons = blockedReasons(state, "hbk", "enf");
    // long range (+4) + target moved 30 (+6) + gunnery 4 = 14 -> auto-miss.
    expect(reasons.filter((r) => r === "autoMiss").length).toBeGreaterThan(0);
    const sugg = suggestFireTargets(state, "hbk");
    expect(sugg.targets.find((t) => t.targetId === "enf")!.weapons).toHaveLength(0);
  });
});
