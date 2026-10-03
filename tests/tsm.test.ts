/**
 * Triple-Strength Myomer tests (TW p.143, physical weapons TW p.146).
 * TSM activates the turn after a turn ending at heat 9+: +2 Walking MP
 * (running recomputed, jump unaffected) and doubled punch/kick/club and
 * physical-weapon damage. Wire key `y`: 1 = Standard, 2 = TSM.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type BattleState,
  createBattle,
  type HexCoord,
  isTsmActive,
  mechDefFor,
  type Rng,
  TSM_ACTIVATION_HEAT,
  type UnitInit,
} from "../src";
import type { Location } from "../src/core/types";
import { loadCatalog } from "../src/data/catalog";
import { decodeMechLine, encodeMechDef } from "../src/data/mech.codec";
import { effectiveMovement, TSM_WALK_BONUS } from "../src/rules/critical";
import type { UnitDamageState } from "../src/rules/damage";
import { physicalDamage, resolvePhysicalAttack } from "../src/rules/physical";

function freshFlags(def = mechDefFor({ model: "CN9-YLW2" })): Record<Location, boolean[]> {
  const out = {} as Record<Location, boolean[]>;
  for (const loc of Object.keys(def.critSlots) as Location[]) {
    out[loc] = new Array(def.critSlots[loc].length).fill(false);
  }
  return out;
}

function freshDamage(model: "CN9-YLW2" | "HBK-4G"): UnitDamageState {
  const def = mechDefFor({ model });
  return {
    armor: { ...def.armor },
    armorRear: { ...def.armorRear },
    internalStructure: { ...def.internalStructure },
  };
}

function makeUnitInit(
  id: string,
  team: number,
  hex: HexCoord,
  model: string,
  facing: "n" | "ne" | "se" | "s" | "sw" | "nw" = "n",
): UnitInit {
  return { id, model, team, position: hex, facing, gunnery: 4, piloting: 5 };
}

function makeBattle(attacker: UnitInit, target: UnitInit): BattleState {
  return createBattle(
    { name: "test", width: 20, height: 20, terrain: [], legends: [] },
    [attacker, target],
    { critsDisabled: true },
  );
}

function tsmBattle(heat: number): BattleState {
  const battle = makeBattle(
    makeUnitInit("a", 1, { col: 5, row: 5 }, "CN9-YLW2", "ne"),
    makeUnitInit("t", 2, { col: 6, row: 5 }, "HBK-4G", "sw"),
  );
  battle.units.a!.heat = heat;
  return battle;
}

const HIGH_RNG: Rng = { d6: () => 6, snapshot: () => "", load: () => {} };

describe("isTsmActive", () => {
  it("activates at heat 9+, never for Standard myomer", () => {
    expect(TSM_ACTIVATION_HEAT).toBe(9);
    const tsm = mechDefFor({ model: "CN9-YLW2" });
    const std = mechDefFor({ model: "HBK-4G" });
    expect(tsm.myomer).toBe("Triple Strength Myomer");
    expect(std.myomer).toBe("Standard");
    expect(isTsmActive(tsm, 8)).toBe(false);
    expect(isTsmActive(tsm, 9)).toBe(true);
    expect(isTsmActive(tsm, 30)).toBe(true);
    expect(isTsmActive(std, 9)).toBe(false);
    expect(isTsmActive(std, 30)).toBe(false);
  });
});

describe("TSM movement bonus", () => {
  it("adds +2 walking and recomputes running, leaving jump alone", () => {
    const def = mechDefFor({ model: "CN9-YLW2" });
    expect(def.walking).toBe(4);
    const damage = freshDamage("CN9-YLW2");
    const off = effectiveMovement(def, damage, freshFlags(def), false);
    expect(off).toEqual({ walking: 4, running: 6, jumping: 0 });
    const on = effectiveMovement(def, damage, freshFlags(def), true);
    expect(on.walking).toBe(4 + TSM_WALK_BONUS);
    expect(on.running).toBe(Math.ceil((4 + TSM_WALK_BONUS) * 1.5));
    expect(on.jumping).toBe(0);
  });
});

describe("TSM physical damage doubling", () => {
  it("doubles punch/kick/club at heat 9+, not below", () => {
    // CN9-YLW2 = 50t: punch 5, kick 10, club 10.
    const cold = tsmBattle(8);
    expect(physicalDamage("punch", cold.units.a!, "rightArm")).toBe(5);
    expect(physicalDamage("kick", cold.units.a!, "rightLeg")).toBe(10);
    expect(physicalDamage("club", cold.units.a!, undefined)).toBe(10);
    const hot = tsmBattle(9);
    expect(physicalDamage("punch", hot.units.a!, "rightArm")).toBe(10);
    expect(physicalDamage("kick", hot.units.a!, "rightLeg")).toBe(20);
    expect(physicalDamage("club", hot.units.a!, undefined)).toBe(20);
  });

  it("doubles hatchet strikes while active", () => {
    // Hatchet: ceil(50/5) = 10, TSM = 20.
    const cold = tsmBattle(0);
    expect(physicalDamage("strike", cold.units.a!, "leftArm", "Hatchet")).toBe(10);
    const hot = tsmBattle(12);
    expect(physicalDamage("strike", hot.units.a!, "leftArm", "Hatchet")).toBe(20);
  });

  it("leaves Standard 'Mechs undoubled at high heat", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "HBK-4G", "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "HBK-4G", "sw"),
    );
    battle.units.a!.heat = 20;
    expect(physicalDamage("punch", battle.units.a!, "rightArm")).toBe(5);
    expect(physicalDamage("kick", battle.units.a!, "rightLeg")).toBe(10);
  });

  it("resolves doubled damage through a full attack", () => {
    const battle = tsmBattle(9);
    const resolution = resolvePhysicalAttack(
      battle,
      "a",
      { type: "punch", targetId: "t", limb: "rightArm" },
      HIGH_RNG,
    );
    expect(resolution.hit).toBe(true);
    expect(resolution.damageToTarget[0]!.damage).toBe(10);
  });
});

describe("myomer wire key y", () => {
  const id = { model: "X", name: "Y", techBase: "Inner Sphere", tonnage: 50 };
  const mechDir = new URL("../data/mechs/", import.meta.url);
  const stdRaw = JSON.parse(readFileSync(new URL("hbk-4g.json", mechDir), "utf8")) as Parameters<
    typeof encodeMechDef
  >[0];
  const tsmRaw = JSON.parse(readFileSync(new URL("cn9-ylw2.json", mechDir), "utf8")) as Parameters<
    typeof encodeMechDef
  >[0];

  // Load catalog to get the string table for encoding/decoding
  const catalogText = readFileSync(new URL("../data/btlib10x.jsonl", import.meta.url), "utf8");
  const catalog = loadCatalog(catalogText);
  const strings = catalog.strings;

  it("round-trips Standard as 1 and TSM as 2", () => {
    expect(stdRaw.myomer).toBe("Standard");
    expect(tsmRaw.myomer).toBe("Triple Strength Myomer");
    expect((JSON.parse(encodeMechDef(stdRaw, [])) as { y: number }).y).toBe(1);
    expect((JSON.parse(encodeMechDef(tsmRaw, [])) as { y: number }).y).toBe(2);
    expect(decodeMechLine(encodeMechDef(stdRaw, []), id, strings).myomer).toBe("Standard");
    expect(decodeMechLine(encodeMechDef(tsmRaw, []), id, strings).myomer).toBe(
      "Triple Strength Myomer",
    );
  });

  it("defaults a missing y to Standard and rejects unknown ids", () => {
    const wire = JSON.parse(encodeMechDef(stdRaw, [])) as Record<string, unknown>;
    delete wire.y;
    expect(decodeMechLine(JSON.stringify(wire), id, strings).myomer).toBe("Standard");
    expect(() => decodeMechLine(JSON.stringify({ ...wire, y: 3 }), id, strings)).toThrow(/myomer/);
  });
});

describe("CN9-YLW2 sheet", () => {
  it("imports with TSM, a synthesized Hatchet mount, and 6 tsm slots", () => {
    const def = mechDefFor({ model: "CN9-YLW2" });
    expect(def.name).toBe("Centurion");
    expect(def.tonnage).toBe(50);
    expect(def.myomer).toBe("Triple Strength Myomer");
    const mounts = Object.values(def.weapons);
    expect(mounts).toContainEqual({ weapon: "Hatchet", location: "leftArm" });
    expect(mounts).toContainEqual({ weapon: "Gauss Rifle", location: "rightArm", shots: 16 });
    let tsm = 0;
    for (const loc of Object.keys(def.critSlots) as Location[]) {
      for (const slot of def.critSlots[loc]) {
        if (slot.kind === "soak" && slot.name === "tsm") tsm += 1;
      }
    }
    expect(tsm).toBe(6);
  });
});
