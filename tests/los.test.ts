import { describe, expect, it } from "vitest";
import type { HexGrid } from "../src/core/terrain";
import type { Facing, HexCell, TerrainHexDef, TerrainType } from "../src/core/types";
import { mechDef } from "../src/data/index";
import { weaponDefFor } from "../src/data/weapon.schema";
import { targetingComputerModifier } from "../src/rules/actuators";
import { emptyCritTable, setSlotDestroyed } from "../src/rules/critical";
import { suggestFireTargets } from "../src/rules/fireability";
import {
  attackDirectionFor,
  buildUnitInit,
  executeMove,
  losSideFor,
  partialCoverMod,
  requireUnit,
  rollInitiativePhase,
  type UnitInit,
} from "../src/rules/game";
import {
  interveningTerrains,
  losBlockedByBuilding,
  losBlockedByElevation,
  losClear,
  losWoodsPointsBetween,
} from "../src/rules/los";
import { type ReachabilityOptions, reachableLandings } from "../src/rules/movement";
import { createTestBattle, scriptedRng } from "./helpers";

/** Build a 5x5 grid with the given per-hex "col,row" elevation overrides (others 0). */
function gridWithElevation(levels: Record<string, number>): HexGrid {
  const width = 5;
  const height = 5;
  const cells: HexCell[] = new Array<HexCell>(width * height).fill({
    terrain: "clear",
    level: 0,
  });
  for (const [key, level] of Object.entries(levels)) {
    const [col, row] = key.split(",").map(Number);
    cells[col! - 1 + (row! - 1) * width] = { terrain: "clear", level };
  }
  return { cells, width, height };
}

/** 5x5 grid with `lightBuilding` terrain on the given hexes (elevations otherwise 0). */
function gridWithBuildings(buildings: string[], levels: Record<string, number> = {}): HexGrid {
  const width = 5;
  const height = 5;
  const cells: HexCell[] = new Array<HexCell>(width * height).fill({
    terrain: "clear",
    level: 0,
  });
  for (const [key, level] of Object.entries(levels)) {
    const [col, row] = key.split(",").map(Number);
    cells[col! - 1 + (row! - 1) * width] = { terrain: "clear", level };
  }
  for (const key of buildings) {
    const [col, row] = key.split(",").map(Number);
    const level = levels[key] ?? 0;
    cells[col! - 1 + (row! - 1) * width] = { terrain: "lightBuilding", level };
  }
  return { cells, width, height };
}

describe("losBlockedByElevation", () => {
  it("a level-0 attacker can see a level-0 target across a clear valley", () => {
    const grid = gridWithElevation({});
    expect(losBlockedByElevation(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
  });

  it("a tall ridge blocks LOS between two level-0 'Mechs two hexes apart", () => {
    // Ridge at (3,2) level 3; attacker at (2,2) L0; target at (4,2) L0.
    // Eye-level ray sits at LOS level 2; the ridge's top is at level 3,
    // which strictly exceeds the ray → blocks.
    const grid = gridWithElevation({ "3,2": 3 });
    expect(losBlockedByElevation(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
  });

  it("a level-2 attacker can see a level-0 target over a level-1 ridge", () => {
    // Attacker at (2,2) L2, ridge at (3,2) L1, target at (4,2) L0. Ray goes
    // from LOS level 3 down to LOS level 1, so at the ridge's center it sits
    // at 2; ridge top is at 2, which does not strictly exceed the ray → clear.
    const grid = gridWithElevation({ "2,2": 2, "3,2": 1, "4,2": 0 });
    expect(losBlockedByElevation(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
  });

  it("a tall intervening peak blocks LOS even from a higher attacker", () => {
    // Attacker at (2,2) L1, peak at (3,2) L5, target at (4,2) L0.
    // Ray from LOS 2 to LOS 1 is essentially flat; peak top is L6, well
    // above the ray → blocks.
    const grid = gridWithElevation({ "2,2": 1, "3,2": 5, "4,2": 0 });
    expect(losBlockedByElevation(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
  });
});

describe("losBlockedByBuilding", () => {
  it("an intervening tall building blocks LOS between two level-0 'Mechs", () => {
    // Building at (3,2) level 1 between attacker (2,2) L0 and target (4,2) L0;
    // default 2-level building top sits at level 3, the eye-level ray at 2 →
    // blocked. (Default L0 building tops at L2 equal to the eye-level ray and
    // does not strictly exceed it — the codebase's ray abstraction requires
    // the building top to clear the eye-level ray.)
    const grid = gridWithBuildings(["3,2"], { "3,2": 1 });
    expect(losBlockedByBuilding(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
    expect(losClear(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
  });

  it("a building adjacent to a lower target blocks even a level-2 attacker (TW p.100 clause 3)", () => {
    // Attacker (2,2) L2 (LOS 3), building (3,2) top L2, target (4,2) L0.
    // The building is adjacent to the target and its top (2) is at least the
    // target's LOS level (2), so it intervenes even though the attacker is higher.
    const grid = gridWithBuildings(["3,2"], { "2,2": 2 });
    expect(losBlockedByBuilding(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
    expect(losClear(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
  });

  it("the building hex a unit occupies is not intervening", () => {
    // Attacker inside the building at (2,2); only clear (3,2) lies between it
    // and the target (4,2) → fire out of the building stays legal.
    const grid = gridWithBuildings(["2,2"]);
    expect(losBlockedByBuilding(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
    expect(losClear(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
  });
});

describe("losClear", () => {
  it("passes when both woods and elevation are clear", () => {
    expect(losClear(gridWithElevation({}), { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
  });

  it("fails when elevation blocks even with no woods", () => {
    // Tall ridge at (3,2) level 3; eye-level ray at 2 is strictly exceeded.
    const grid = gridWithElevation({ "3,2": 3 });
    expect(losClear(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
  });
});

describe("los-terrain", () => {
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
      expect(losClear(grid, A, B, { to: false })).toBe(true);
      expect(losClear(grid, A, B, { to: true })).toBe(false);
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
      const grid = strip({
        "2,2": { level: 8 },
        "6,2": { level: 8 },
        "4,2": { terrain: "lightWoods" },
      });
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
    const flags = () => emptyCritTable(def);

    it("gives -1 to energy weapons and nothing to missiles", () => {
      expect(
        targetingComputerModifier(def, damage, flags(), weaponDefFor({ weapon: "CL ER PPC" })),
      ).toBe(-1);
      expect(
        targetingComputerModifier(def, damage, flags(), weaponDefFor({ weapon: "CL LRM 10" })),
      ).toBe(0);
    });

    it("is lost when a targeting computer slot is destroyed", () => {
      const f = flags();
      const i = def.critSlots.rightTorso.findIndex(
        (s) => s.kind === "structure" && s.type === "targetingComputer",
      );
      setSlotDestroyed(f, "rightTorso", i);
      expect(targetingComputerModifier(def, damage, f, weaponDefFor({ weapon: "CL ER PPC" }))).toBe(
        0,
      );
    });

    it("is absent on a 'Mech without one", () => {
      const hbk = mechDef("HBK-4G")!;
      const f = emptyCritTable(hbk);
      const dmg = {
        armor: { ...hbk.armor },
        armorRear: { ...hbk.armorRear },
        internalStructure: { ...hbk.internalStructure },
      };
      expect(
        targetingComputerModifier(hbk, dmg, f as never, weaponDefFor({ weapon: "Medium Laser" })),
      ).toBe(0);
    });
  });

  describe("target movement counts hexes since the last reversal (TW p.107, TOH-02)", () => {
    it("two back then two forward counts two", () => {
      const units: UnitInit[] = [
        buildUnitInit("t", "HBK-4G", 1, { col: 4, row: 4 }, "n"),
        buildUnitInit("e", "ENF-4R", 2, { col: 9, row: 9 }, "s"),
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
        { rng: scriptedRng() },
      );
      expect(requireUnit(state, "t").hexesMovedThisTurn).toBe(2);
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
});

describe("los-hexside-chain", () => {
  /**
   * One hexside chain per attacker–target pair (TW pp.99, 101; LOS-02): on a
   * hexside line the defender picks one chain, and woods and partial cover
   * both come from it. Woods on one chain never adds to cover on the other.
   */

  // From 3,6 to 9,6 the line runs along hexsides: side 1 passes 6,5 and 8,5,
  // side -1 passes 6,6 and 8,6 (8,5 and 8,6 are both adjacent to the target).
  const WOODS_SIDE_1: TerrainHexDef = { col: 6, row: 5, type: "lightWoods" };
  const HILL_SIDE_1: TerrainHexDef = { col: 8, row: 5, type: "clear", level: 1 };
  const HILL_SIDE_MINUS_1: TerrainHexDef = { col: 8, row: 6, type: "clear", level: 1 };

  function setup(terrain: TerrainHexDef[], targetFacing: Facing = "nw") {
    return createTestBattle(
      terrain,
      [
        buildUnitInit("a", "HBK-4G", 1, { col: 3, row: 6 }, "ne"),
        buildUnitInit("t", "ENF-4R", 2, { col: 9, row: 6 }, targetFacing),
      ],
      true,
      12,
      10,
    );
  }

  /** Medium Laser TN at range 6 (gunnery 4 + medium range 2 = base 6). */
  function laserTn(terrain: TerrainHexDef[]): number {
    const target = suggestFireTargets(setup(terrain), "a").targets.find((t) => t.targetId === "t");
    return target!.weaponsIfPropLeft.find((w) => w.weapon === "Medium Laser")!.tn;
  }

  describe("one hexside chain for woods and cover (TW p.101, LOS-02)", () => {
    it("woods or cover alone each add +1", () => {
      expect(laserTn([])).toBe(6);
      expect(laserTn([WOODS_SIDE_1])).toBe(7);
      expect(laserTn([HILL_SIDE_MINUS_1])).toBe(7);
    });

    it("woods and cover on the same chain both count", () => {
      expect(laserTn([WOODS_SIDE_1, HILL_SIDE_1])).toBe(8);
    });

    it("woods on one chain and cover on the other do not combine", () => {
      expect(laserTn([WOODS_SIDE_1, HILL_SIDE_MINUS_1])).toBe(7);
    });

    it("on equal totals the defender takes the chain with cover", () => {
      const state = setup([WOODS_SIDE_1, HILL_SIDE_MINUS_1]);
      const a = requireUnit(state, "a");
      const t = requireUnit(state, "t");
      const side = losSideFor(state, a, t);
      expect(side).toBe(-1);
      expect(partialCoverMod(state, a, t)).toBe(1);
      expect(losWoodsPointsBetween(state, a.position, t.position, undefined, side)).toBe(0);
    });

    it("heavier woods on one chain outweigh cover on the other", () => {
      const state = setup([{ ...WOODS_SIDE_1, type: "heavyWoods" }, HILL_SIDE_MINUS_1]);
      const a = requireUnit(state, "a");
      const t = requireUnit(state, "t");
      expect(losSideFor(state, a, t)).toBe(1);
      expect(partialCoverMod(state, a, t)).toBe(0);
      expect(laserTn([{ ...WOODS_SIDE_1, type: "heavyWoods" }, HILL_SIDE_MINUS_1])).toBe(8);
    });
  });

  describe("the attack direction follows the same chain (TW p.119, LOS-02)", () => {
    // The line meets the target's hex at the corner between its nw hexside
    // (side 1 enters past 8,5) and its sw hexside (side -1 enters past 8,6).
    function direction(terrain: TerrainHexDef[], facing: Facing) {
      const state = setup(terrain, facing);
      return attackDirectionFor(state, requireUnit(state, "a"), requireUnit(state, "t"));
    }

    it("with nothing to choose between the chains, the defender takes the better side", () => {
      // Facing n: nw is a front hexside, sw a left-side one.
      expect(direction([], "n")).toBe("front");
      // Facing ne: nw is left side, sw is rear.
      expect(direction([], "ne")).toBe("leftSide");
    });

    it("taking the chain with cover also takes its attack direction", () => {
      // Cover on side -1 makes the sw hexside the one struck.
      expect(direction([HILL_SIDE_MINUS_1], "n")).toBe("leftSide");
      expect(direction([WOODS_SIDE_1, HILL_SIDE_MINUS_1], "n")).toBe("leftSide");
      expect(direction([{ ...WOODS_SIDE_1, type: "heavyWoods" }, HILL_SIDE_MINUS_1], "n")).toBe(
        "front",
      );
    });

    it("to-hit decides the chain even when its direction is worse for the defender", () => {
      expect(direction([HILL_SIDE_MINUS_1], "ne")).toBe("rear");
    });
  });
});

describe("elevation", () => {
  /**
   * Worked example: a hilly duel between two bipedal 'Mechs.
   *
   *   hbk (HBK-4G) at (4, 2) level 0, facing ne (toward (5,2)).
   *   enf (ENF-4R) at (6, 2) level 0, facing nw (toward (5,2)).
   *   (5, 2) is a level-1 ridge sitting between them.
   *   All other hexes are level 0.
   *
   * Coordinate convention: 1-based, even-q (even columns sit half a hex lower
   * than odd columns). Under that layout 'ne' from an even column steps one
   * col over at the same row, so the ridge at (5, 2) is the forward hex.
   */

  /** Build a 6x3 grid with the given per-hex "col,row" level overrides (others 0). */
  function gridWithLevels(levels: Record<string, number>): HexGrid {
    const width = 6;
    const height = 3;
    const cells: HexCell[] = new Array<HexCell>(width * height).fill({
      terrain: "clear",
      level: 0,
    });
    for (const [key, level] of Object.entries(levels)) {
      const [col, row] = key.split(",").map(Number);
      cells[col! - 1 + (row! - 1) * width] = { terrain: "clear", level };
    }
    return { cells, width, height };
  }

  const elevation = gridWithLevels({ "5,2": 1 });
  const clear = gridWithLevels({});
  const team = 1;
  const noOcc = () => undefined;

  const reachOptions = (grid: HexGrid): ReachabilityOptions => ({
    mode: "walk",
    walking: 4,
    running: 6,
    jumping: 4,
    grid,
    prone: false,
    team,
    occupantTeam: noOcc,
  });

  describe("elevation worked example: ridge duel", () => {
    it("ground step into a level-1 hex costs 2 MP (1 base + 1 climb)", () => {
      // Two-MP walk budget is enough to climb into a level-1 hex (1 base + 1 climb).
      // From (4,2) facing "ne" (col 4 even) leads to (5,2) on the ridge.
      const landings = reachableLandings({ col: 4, row: 2 }, "ne", {
        ...reachOptions(elevation),
        mode: "walk",
        walking: 2,
        running: 3,
        jumping: 0,
        prone: false,
      });
      expect(landings.find((l) => l.hex.col === 5 && l.hex.row === 2)).toBeDefined();
    });

    it("ground step onto a level-2 hex in one move is allowed, +3 rejected", () => {
      // TW: a forward step may change up to 2 levels per hex. Level-2 hex costs
      // 1 base + 2 climb = 3 MP (walk budget 4); a level-3 hex is beyond the cap.
      const level2 = gridWithLevels({ "5,2": 2 });
      const landings = reachableLandings({ col: 4, row: 2 }, "ne", {
        ...reachOptions(level2),
      });
      expect(landings.find((l) => l.hex.col === 5 && l.hex.row === 2)).toBeDefined();
      const level3 = gridWithLevels({ "5,2": 3 });
      const landings3 = reachableLandings({ col: 4, row: 2 }, "ne", {
        ...reachOptions(level3),
      });
      expect(landings3.find((l) => l.hex.col === 5 && l.hex.row === 2)).toBeUndefined();
    });

    it("jump to the level-1 hex costs 1 MP regardless of elevation", () => {
      const landings = reachableLandings({ col: 4, row: 2 }, "ne", {
        ...reachOptions(elevation),
        mode: "jump",
      });
      const ridge = landings.find((l) => l.hex.col === 5 && l.hex.row === 2);
      expect(ridge).toBeDefined();
    });

    it("LOS from level-0 to level-0 across a tall ridge is blocked", () => {
      // Eye-level ray sits at LOS level 2; the ridge needs to top out strictly
      // above 2 to block (default L1 ridge tops at L1 — below the ray).
      const tall = gridWithLevels({ "5,2": 3 });
      expect(losClear(tall, { col: 4, row: 2 }, { col: 6, row: 2 })).toBe(false);
    });

    it("LOS from the level-1 ridge down to the level-0 target is clear", () => {
      expect(losWoodsPointsBetween(clear, { col: 5, row: 2 }, { col: 6, row: 2 })).toBe(0);
      expect(losClear(elevation, { col: 5, row: 2 }, { col: 6, row: 2 })).toBe(true);
    });
  });
});
