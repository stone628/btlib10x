import { describe, expect, it } from "vitest";
import type { HexGrid } from "../src/core/terrain";
import type { HexCell, TerrainType } from "../src/core/types";
import { mechDef } from "../src/data/index";
import { weaponDefFor } from "../src/data/weapon.schema";
import { targetingComputerModifier } from "../src/rules/actuators";
import {
  buildUnitInit,
  executeMove,
  requireUnit,
  rollInitiativePhase,
  type UnitInit,
} from "../src/rules/game";
import { interveningTerrains, losClear, losWoodsPointsBetween } from "../src/rules/los";
import { createTestBattle, scriptedRng } from "./helpers";

/** 9x3 strip of clear level-0 hexes with overrides keyed "col,row". */
function strip(over: Record<string, Partial<HexCell> & { terrain?: TerrainType }>): HexGrid {
  const width = 9;
  const height = 3;
  const cells: HexCell[] = [];
  for (let i = 0; i < width * height; i++) cells.push({ terrain: "clear", level: 0 });
  for (const [key, o] of Object.entries(over)) {
    const [col, row] = key.split(",").map(Number);
    cells[col! - 1 + (row! - 1) * width] = { terrain: "clear", level: 0, ...o };
  }
  return { cells, width, height };
}

const A = { col: 2, row: 2 };
const B = { col: 6, row: 2 };

describe("LOS intervening-terrain test (TW p.100, LOS-01/02)", () => {
  it("a flat board is clear", () => {
    expect(losClear(strip({}), A, B)).toBe(true);
  });

  it("a Level 2 hill between two standing 'Mechs blocks (clause 1: top >= both)", () => {
    expect(losClear(strip({ "4,2": { level: 2 } }), A, B)).toBe(false);
  });

  it("a Level 1 hill in the middle does not block", () => {
    expect(losClear(strip({ "4,2": { level: 1 } }), A, B)).toBe(true);
  });

  it("a medium building (2 levels) between two ground 'Mechs blocks", () => {
    expect(losClear(strip({ "4,2": { terrain: "mediumBuilding" } }), A, B)).toBe(false);
  });

  it("a Level 2 hill adjacent to the target blocks (clause 3)", () => {
    expect(losClear(strip({ "5,2": { level: 2 } }), A, B)).toBe(false);
  });

  it("a prone target (LOS level 1) is hidden by a Level 1 hill next to it", () => {
    const grid = strip({ "5,2": { level: 1 } });
    expect(losClear(grid, A, B, undefined, { to: false })).toBe(true);
    expect(losClear(grid, A, B, undefined, { to: true })).toBe(false);
  });

  it("a Level 7 hill between units on Level 0 and Level 8 does not intervene", () => {
    expect(losClear(strip({ "4,2": { level: 7 }, "6,2": { level: 8 } }), A, B)).toBe(true);
  });

  it("light woods on a Level 1 hill count as one woods hex, not a wall (LOS-02)", () => {
    const grid = strip({ "4,2": { terrain: "lightWoods", level: 1 } });
    expect(losClear(grid, A, B)).toBe(true);
    expect(losWoodsPointsBetween(grid, A, B)).toBe(1);
  });

  it("woods whose canopy is below both units do not count (LOS-02)", () => {
    // Units on Level 8 hexes see over the Level 0 woods canopy (top 2).
    const grid = strip({ "2,2": { level: 8 }, "6,2": { level: 8 }, "4,2": { terrain: "lightWoods" } });
    expect(losWoodsPointsBetween(grid, A, B)).toBe(0);
    expect(interveningTerrains(grid, A, B)).not.toContain("lightWoods");
  });
});

describe("targeting computer (TW p.143, TOH-01)", () => {
  const def = mechDef("WHK-Prime")!;
  const damage = {
    armor: { ...def.armor },
    armorRear: { ...def.armorRear },
    internalStructure: { ...def.internalStructure },
  };
  const flags = () => {
    const out: Record<string, boolean[]> = {};
    for (const [loc, slots] of Object.entries(def.critSlots)) out[loc] = slots.map(() => false);
    return out as Record<keyof typeof def.critSlots, boolean[]>;
  };

  it("gives -1 to energy weapons and nothing to missiles", () => {
    expect(targetingComputerModifier(def, damage, flags(), weaponDefFor({ weapon: "CL ER PPC" }))).toBe(-1);
    expect(targetingComputerModifier(def, damage, flags(), weaponDefFor({ weapon: "CL LRM 10" }))).toBe(0);
  });

  it("is lost when a targeting computer slot is destroyed", () => {
    const f = flags();
    const i = def.critSlots.rightTorso.findIndex(
      (s) => s.kind === "structure" && s.name === "targetingComputer",
    );
    f.rightTorso[i] = true;
    expect(targetingComputerModifier(def, damage, f, weaponDefFor({ weapon: "CL ER PPC" }))).toBe(0);
  });

  it("is absent on a 'Mech without one", () => {
    const hbk = mechDef("HBK-4G")!;
    const f: Record<string, boolean[]> = {};
    for (const [loc, slots] of Object.entries(hbk.critSlots)) f[loc] = slots.map(() => false);
    const dmg = { armor: { ...hbk.armor }, armorRear: { ...hbk.armorRear }, internalStructure: { ...hbk.internalStructure } };
    expect(
      targetingComputerModifier(hbk, dmg, f as never, weaponDefFor({ weapon: "Medium Laser" })),
    ).toBe(0);
  });
});

describe("target movement counts hexes since the last reversal (TW p.107, TOH-02)", () => {
  it("two back then two forward counts two", () => {
    const units: UnitInit[] = [
      buildUnitInit("t", "HBK-4G", 0, { col: 4, row: 4 }, "n"),
      buildUnitInit("e", "ENF-4R", 1, { col: 9, row: 9 }, "s"),
    ];
    const state = createTestBattle([], units, true, 10, 10);
    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
    executeMove(
      state,
      "t",
      "walk",
      [
        { kind: "enter", to: { col: 4, row: 5 } },
        { kind: "enter", to: { col: 4, row: 6 } },
        { kind: "enter", to: { col: 4, row: 5 } },
        { kind: "enter", to: { col: 4, row: 4 } },
      ],
      [],
    );
    expect(requireUnit(state, "t").movesThisTurn).toEqual(["forward", "forward"]);
  });
});

describe("hexside LOS gives the defender the side (TW p.99, LOS-03)", () => {
  // From 2,4 to 4,4 the line runs exactly between 3,4 and 3,5.
  const from = { col: 2, row: 4 };
  const to = { col: 4, row: 4 };
  const wide = (over: Record<string, Partial<HexCell> & { terrain?: TerrainType }>): HexGrid => {
    const width = 6;
    const height = 6;
    const cells: HexCell[] = [];
    for (let i = 0; i < width * height; i++) cells.push({ terrain: "clear", level: 0 });
    for (const [key, o] of Object.entries(over)) {
      const [col, row] = key.split(",").map(Number);
      cells[col! - 1 + (row! - 1) * width] = { terrain: "clear", level: 0, ...o };
    }
    return { cells, width, height };
  };

  it("woods on either candidate hex count, whichever side they sit on", () => {
    const a = losWoodsPointsBetween(wide({ "3,4": { terrain: "heavyWoods" } }), from, to);
    const b = losWoodsPointsBetween(wide({ "3,5": { terrain: "heavyWoods" } }), from, to);
    expect(a).toBe(2);
    expect(b).toBe(2);
  });

  it("intervening terrains report the worse side for the attacker", () => {
    expect(interveningTerrains(wide({ "3,5": { terrain: "heavyWoods" } }), from, to)).toEqual([
      "heavyWoods",
    ]);
  });

  it("a blocking hill on either candidate hex blocks the line", () => {
    expect(losClear(wide({ "3,5": { level: 3 } }), from, to)).toBe(false);
    expect(losClear(wide({ "3,4": { level: 3 } }), from, to)).toBe(false);
  });
});
