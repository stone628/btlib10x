import { describe, expect, it } from "vitest";
import type { Location } from "../src/core/types";
import { mechDef, registeredMechDefs } from "../src/data/index";
import { setSlotDestroyed } from "../src/rules/critical";
import type { BattleState, UnitInit, UnitState } from "../src/rules/game";
import { buildUnitInit } from "../src/rules/game";
import {
  bvSkillMultiplier,
  crippleReasons,
  damagedFraction,
  scoreReport,
  unitScore,
} from "../src/rules/score";
import { createTestBattle, critWeapon } from "./helpers";

function duel(): BattleState {
  const units: UnitInit[] = [
    buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
    buildUnitInit("cda", "CDA-3MA", 2, { col: 5, row: 4 }, "nw"),
  ];
  return createTestBattle([], units, true);
}

function teamScore(state: BattleState, team: number): number {
  return scoreReport(state).find((t) => t.team === team)!.score;
}

/** Strip `points` of front armor from `loc`. */
function hitArmor(unit: UnitState, loc: Location, points: number): void {
  unit.damage.armor[loc] -= points;
}

function destroyLocation(unit: UnitState, loc: Location): void {
  unit.damage.armor[loc] = 0;
  unit.damage.internalStructure[loc] = 0;
}

/** Flag the first `n` slots of a named structure component. */
function critStructure(unit: UnitState, name: string, n: number): void {
  const def = mechDef(unit.model)!;
  let left = n;
  for (const loc of Object.keys(def.critSlots) as Location[]) {
    def.critSlots[loc].forEach((s, i) => {
      if (left > 0 && s.kind === "structure" && s.name === name) {
        setSlotDestroyed(unit.critSlotsDestroyed, loc, i);
        left--;
      }
    });
  }
}

describe("Battle Value in the catalog", () => {
  it("carries MUL BV onto the built MechDef", () => {
    expect(mechDef("HBK-4G")!.bv).toBe(1041);
    expect(mechDef("CDA-3MA")!.bv).toBe(1158);
    expect(mechDef("AS7-D")!.bv).toBe(1897);
  });

  it("gives every base sheet a BV", () => {
    for (const def of registeredMechDefs()) expect(Number.isInteger(def.bv)).toBe(true);
    expect(mechDef("TBR-Prime")!.bv).toBe(2737);
  });
});

describe("bvSkillMultiplier", () => {
  it("rates a regular 4/5 MechWarrior at 1.00", () => {
    expect(bvSkillMultiplier(4, 5)).toBe(1);
    expect(bvSkillMultiplier(3, 5)).toBe(1.2);
    expect(bvSkillMultiplier(2, 3)).toBe(1.68);
  });

  it("clamps skills outside 0..8", () => {
    expect(bvSkillMultiplier(-1, 9)).toBe(bvSkillMultiplier(0, 8));
  });
});

describe("scoreReport", () => {
  it("is 0 for both teams before anyone is hit", () => {
    const state = duel();
    expect(scoreReport(state).map((t) => [t.team, t.score])).toEqual([
      [1, 0],
      [2, 0],
    ]);
  });

  it("values a unit at BV × skill multiplier", () => {
    const state = duel();
    state.units.hbk!.gunnery = 3;
    expect(unitScore(state.units.hbk!).value).toBe(Math.round(1041 * 1.2));
  });

  it("counts partial damage at half the damaged fraction", () => {
    const state = duel();
    const cda = state.units.cda!;
    hitArmor(cda, "centerTorso", 10);
    const damaged = damagedFraction(cda);
    expect(damaged).toBeGreaterThan(0);
    const s = unitScore(cda);
    expect(s.crippled).toEqual([]);
    expect(s.lost).toBeCloseTo(damaged / 2);
    expect(teamScore(state, 1)).toBe(Math.round(2 * 1158 * (damaged / 2)));
    expect(teamScore(state, 2)).toBe(Math.round(-1158 * (damaged / 2)));
  });

  it("counts a crippled unit as half lost", () => {
    const state = duel();
    const cda = state.units.cda!;
    destroyLocation(cda, "leftTorso");
    expect(crippleReasons(cda)).toContain("sideTorsoDestroyed");
    expect(unitScore(cda).lost).toBe(0.5);
    expect(teamScore(state, 1)).toBe(1158);
  });

  it("counts a destroyed unit and a hull as fully lost, and own losses once", () => {
    const state = duel();
    const cda = state.units.cda!;
    cda.removed = "destroyed";
    cda.destroyed = "centerTorsoDestroyed";
    expect(teamScore(state, 1)).toBe(2 * 1158);
    expect(teamScore(state, 2)).toBe(-1158);

    const hull = duel();
    hull.units.cda!.removed = "pilotEjected";
    expect(teamScore(hull, 1)).toBe(2 * 1158);
  });

  it("does not change when a hull is later destroyed", () => {
    const state = duel();
    const cda = state.units.cda!;
    cda.removed = "pilotKilled";
    const before = teamScore(state, 1);
    cda.destroyed = "centerTorsoDestroyed";
    expect(teamScore(state, 1)).toBe(before);
  });

  it("is never more than half for armor damage alone", () => {
    const state = duel();
    const cda = state.units.cda!;
    const def = mechDef("CDA-3MA")!;
    for (const loc of Object.keys(def.armor) as Location[]) cda.damage.armor[loc] = 0;
    for (const loc of ["leftTorso", "centerTorso", "rightTorso"] as const) {
      cda.damage.armorRear[loc] = 0;
    }
    expect(unitScore(cda).lost).toBeLessThanOrEqual(0.5);
  });
});

describe("crippleReasons", () => {
  it("flags engine and gyro hits", () => {
    const two = duel().units.hbk!;
    critStructure(two, "engine", 2);
    expect(crippleReasons(two)).toContain("engineHits");
    const mixed = duel().units.hbk!;
    critStructure(mixed, "engine", 1);
    critStructure(mixed, "gyro", 1);
    expect(crippleReasons(mixed)).toContain("gyroAndEngineHits");
    const one = duel().units.hbk!;
    critStructure(one, "engine", 1);
    expect(crippleReasons(one)).toEqual([]);
  });

  it("flags lost sensors and four pilot hits", () => {
    const blind = duel().units.hbk!;
    critStructure(blind, "sensors", 2);
    expect(crippleReasons(blind)).toContain("sensorsLost");
    const hurt = duel().units.hbk!;
    hurt.pilotHits = 4;
    expect(crippleReasons(hurt)).toEqual(["pilotHits"]);
    hurt.pilotHits = 3;
    expect(crippleReasons(hurt)).toEqual([]);
  });

  it("flags structure damage in three limbs", () => {
    const u = duel().units.hbk!;
    for (const loc of ["leftArm", "rightArm"] as const) u.damage.internalStructure[loc] -= 1;
    expect(crippleReasons(u)).toEqual([]);
    u.damage.internalStructure.leftLeg -= 1;
    expect(crippleReasons(u)).toContain("limbStructureDamage");
  });

  it("counts torso structure damage only once its front armor is gone", () => {
    const u = duel().units.hbk!;
    u.damage.internalStructure.centerTorso -= 1;
    u.damage.internalStructure.rightTorso -= 1;
    expect(crippleReasons(u)).toEqual([]);
    u.damage.armor.centerTorso = 0;
    u.damage.armor.rightTorso = 0;
    expect(crippleReasons(u)).toContain("torsoStructureDamage");
  });

  it("flags a unit whose weapons are all destroyed", () => {
    const u = duel().units.hbk!;
    const def = mechDef("HBK-4G")!;
    const keys = Object.keys(def.weapons).map(Number);
    for (const k of keys.slice(1)) critWeapon(u, k);
    expect(crippleReasons(u)).toEqual([]);
    critWeapon(u, keys[0]!);
    expect(crippleReasons(u)).toEqual(["allWeaponsLost"]);
  });

  it("flags a gun with no ammo left as lost", () => {
    const u = duel().units.hbk!;
    const def = mechDef("HBK-4G")!;
    for (const [k, m] of Object.entries(def.weapons)) {
      if (m.weapon !== "AC/20") critWeapon(u, Number(k));
    }
    expect(crippleReasons(u)).toEqual([]);
    for (const id of Object.keys(u.ammoBins)) u.ammoBins[id as keyof typeof u.ammoBins] = 0;
    expect(crippleReasons(u)).toEqual(["allWeaponsLost"]);
  });
});
