import { describe, expect, it } from "vitest";
import type { HexGrid } from "../src/core/terrain";
import type { HexCell } from "../src/core/types";
import {
  applyBuildingDamage,
  buildingTypeOf,
  createBuildingState,
  isBuildingTerrain,
  isCollapsed,
} from "../src/rules/building";
import {
  advancePhase,
  type BattleState,
  damageBuildingAt,
  declareAttacks,
  type GameEvent,
  resolveAllAttacks,
  rollInitiativePhase,
  type TerrainHexDef,
  type UnitInit,
  type UnitState,
} from "../src/rules/game";
import { losBlockedByWater } from "../src/rules/los";
import { createTestBattle, scriptedRng } from "./helpers";

describe("buildingTypeOf", () => {
  it("maps each building terrain to its sub-type", () => {
    expect(buildingTypeOf("lightBuilding")).toBe("light");
    expect(buildingTypeOf("mediumBuilding")).toBe("medium");
    expect(buildingTypeOf("heavyBuilding")).toBe("heavy");
    expect(buildingTypeOf("hardenedBuilding")).toBe("hardened");
  });

  it("returns undefined for non-building terrain", () => {
    expect(buildingTypeOf("clear")).toBeUndefined();
    expect(buildingTypeOf("lightWoods")).toBeUndefined();
    expect(buildingTypeOf("water1")).toBeUndefined();
  });
});

describe("isBuildingTerrain", () => {
  it("recognizes building and non-building terrain", () => {
    expect(isBuildingTerrain("lightBuilding")).toBe(true);
    expect(isBuildingTerrain("hardenedBuilding")).toBe(true);
    expect(isBuildingTerrain("clear")).toBe(false);
    expect(isBuildingTerrain("rough")).toBe(false);
  });
});

describe("building damage and collapse", () => {
  it("applies damage to the structural factor", () => {
    const b = createBuildingState("light"); // CF 15
    expect(applyBuildingDamage(b, 5).cf).toBe(10);
  });

  it("clamps CF at 0 (collapse) and reports collapsed", () => {
    const b = createBuildingState("light");
    const collapsed = applyBuildingDamage(b, 20);
    expect(collapsed.cf).toBe(0);
    expect(isCollapsed(collapsed)).toBe(true);
  });

  it("hardened buildings start at the highest CF", () => {
    expect(createBuildingState("hardened").cf).toBe(150);
  });
});

function gridWithTerrain(entries: readonly [string, number, number][]): HexGrid {
  const width = 5;
  const height = 5;
  const cells: HexCell[] = new Array<HexCell>(width * height).fill({
    terrain: "clear",
    level: 0,
  });
  for (const [type, col, row] of entries) {
    cells[col - 1 + (row - 1) * width] = { terrain: type as HexCell["terrain"], level: 0 };
  }
  return { cells, width, height };
}

describe("water LOS blocking", () => {
  it("water2 blocks LOS in and out", () => {
    const grid = gridWithTerrain([["water2", 2, 2]]);
    expect(losBlockedByWater(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
    expect(losBlockedByWater(grid, { col: 4, row: 2 }, { col: 2, row: 2 })).toBe(true);
  });

  it("water3 blocks LOS in and out", () => {
    const grid = gridWithTerrain([["water3", 2, 2]]);
    expect(losBlockedByWater(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(true);
  });

  it("water1 and clear do not block LOS in/out", () => {
    const grid = gridWithTerrain([["water1", 2, 2]]);
    expect(losBlockedByWater(grid, { col: 2, row: 2 }, { col: 4, row: 2 })).toBe(false);
    expect(losBlockedByWater(grid, { col: 4, row: 2 }, { col: 2, row: 2 })).toBe(false);
  });
});

function battleWithBuilding(): BattleState {
  const units: UnitInit[] = [
    {
      id: "a",
      model: "HBK-4G",
      team: 0,
      gunnery: 4,
      piloting: 5,
      position: { col: 2, row: 3 },
      facing: "se",
    },
    {
      id: "b",
      model: "ENF-4R",
      team: 1,
      gunnery: 4,
      piloting: 5,
      position: { col: 2, row: 1 },
      facing: "sw",
    },
  ];
  const terrain: readonly TerrainHexDef[] = [{ col: 3, row: 3, type: "lightBuilding" }];
  return createTestBattle(terrain, units, true);
}

describe("battle building integration", () => {
  it("initializes building state from terrain", () => {
    const battle = battleWithBuilding();
    expect(battle.buildings["3,3"]).toEqual({ cf: 15, type: "light" });
  });

  it("damaging a building below its CF does not collapse it", () => {
    const battle = battleWithBuilding();
    const events: GameEvent[] = [];
    const result = damageBuildingAt(battle, { col: 3, row: 3 }, 5, events);
    expect(result?.collapsed).toBe(false);
    expect(result?.cf).toBe(10);
    expect(battle.buildings["3,3"]?.cf).toBe(10);
    expect(events).toContainEqual({
      kind: "buildingDamaged",
      col: 3,
      row: 3,
      damage: 5,
      cf: 10,
    });
  });

  it("reduces a building to rubble when its CF reaches zero", () => {
    const battle = battleWithBuilding();
    const events: GameEvent[] = [];
    const result = damageBuildingAt(battle, { col: 3, row: 3 }, 15, events);
    expect(result?.collapsed).toBe(true);
    expect(result?.preCf).toBe(15);
    expect(events).toEqual([{ kind: "buildingCollapsed", col: 3, row: 3 }]);
    expect(battle.buildings["3,3"]).toBeUndefined();
    // width = max(3,3)+1 = 4, so index of (3,3) is (3-1)+(3-1)*4 = 10.
    expect(battle.cells[10]!.terrain).toBe("rubble");
    expect(events.some((e) => e.kind === "buildingCollapsed")).toBe(true);
  });

  it("ignores damage to non-building hexes", () => {
    const battle = battleWithBuilding();
    expect(damageBuildingAt(battle, { col: 2, row: 3 }, 100, [])).toBeNull();
  });

  it("collapsing a building damages occupants (TW: ceil(CF/10) to one location)", () => {
    const battle: BattleState = createTestBattle(
      [{ col: 3, row: 3, type: "lightBuilding" }],
      [
        {
          id: "a",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          piloting: 5,
          position: { col: 2, row: 3 },
          facing: "ne",
        },
        {
          id: "b",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          piloting: 5,
          position: { col: 3, row: 3 },
          facing: "sw",
        },
      ],
      true,
    );
    // RNG: initiative 2D6 x2 teams; AC/20 to-hit then location; collapse location;
    // 20+ damage PSR (needs 6: 3+3 succeeds, no fall).
    const rng = scriptedRng(1, 2, 3, 3, 3, 3, 3, 4, 3, 3, 3, 3);
    const totalBefore = poolTotal(battle.units.b!);
    // Target b stands in partial cover, so leg location rolls strike the cover
    // instead — location 7 (center torso) keeps the 20-damage group live.
    rollInitiativePhase(battle, rng, []);
    advancePhase(battle, []);
    declareAttacks(battle, "a", [{ weaponIndex: 4, targetId: "b" }], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(battle, rng, events);

    expect(battle.buildings["3,3"]).toBeUndefined();
    expect(battle.cells[10]!.terrain).toBe("rubble");
    expect(events).toContainEqual({ kind: "buildingCollapsed", col: 3, row: 3 });
    expect(events).toContainEqual({
      kind: "collapseDamage",
      unitId: "b",
      col: 3,
      row: 3,
      location: "rightTorso",
      damage: 2,
    });
    expect(poolTotal(battle.units.b!)).toBe(totalBefore - 22);
  });
});

function poolTotal(unit: UnitState): number {
  let total = 0;
  for (const pool of Object.values(unit.damage.armor)) total += pool;
  for (const pool of Object.values(unit.damage.armorRear)) total += pool;
  for (const pool of Object.values(unit.damage.internalStructure)) total += pool;
  return total;
}
