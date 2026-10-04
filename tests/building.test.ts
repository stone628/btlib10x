import { describe, expect, it } from "vitest";
import type { HexGrid } from "../src/core/terrain";
import type { HexCell } from "../src/core/types";
import {
  applyBuildingDamage,
  buildingTypeOf,
  createBuildingState,
  isCollapsed,
} from "../src/rules/building";
import {
  advancePhase,
  type BattleState,
  collapseDamageTotal,
  damageBuildingAt,
  declareAttacks,
  type GameEvent,
  resolveAllAttacks,
  rollInitiativePhase,
  type TerrainHexDef,
  type UnitInit,
  type UnitState,
} from "../src/rules/game";
import { punchHitLocation } from "../src/rules/hitlocation";
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

  it("hardened buildings start at the unspecified-building default CF", () => {
    expect(createBuildingState("hardened").cf).toBe(120);
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

  it("charges the phase-start toll per grouping, not full damage (TW p.171)", () => {
    // Medium building CF 40: an AC/20 single-group hit costs the hex
    // ceil(40/10) = 4, once. The unit inside still takes its full 20.
    const battle: BattleState = createTestBattle(
      [{ col: 3, row: 3, type: "mediumBuilding" }],
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
    // RNG: initiative 2D6 x2 teams; AC/20 to-hit then location (7 = center
    // torso, live group under partial cover); 20+ damage PSR (6 succeeds).
    const rng = scriptedRng(1, 2, 3, 3, 3, 3, 3, 4, 3, 3);
    const totalBefore = poolTotal(battle.units.b!);
    rollInitiativePhase(battle, rng, []);
    advancePhase(battle, []);
    declareAttacks(battle, "a", [{ weaponIndex: 4, targetId: "b" }], [], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(battle, rng, events);

    expect(battle.buildings["3,3"]?.cf).toBe(36);
    expect(events).toContainEqual({
      kind: "buildingDamaged",
      col: 3,
      row: 3,
      damage: 4,
      cf: 36,
    });
    expect(events.some((e) => e.kind === "buildingCollapsed")).toBe(false);
    expect(poolTotal(battle.units.b!)).toBe(totalBefore - 20);
  });

  it("freezes the toll at phase-start CF and defers reduction (TW p.171)", () => {
    // Light building CF 15: two AC/20 hits in one phase — one per occupant —
    // each cost ceil(15/10) = 2, total 4, leaving CF 11 standing.
    // Full-damage arithmetic (20 + 20) would collapse it twice over.
    // (Two targets: same-target volleys share one phase-start snapshot.)
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
          id: "c",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          piloting: 5,
          position: { col: 4, row: 3 },
          facing: "nw",
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
        {
          id: "d",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          piloting: 5,
          position: { col: 3, row: 3 },
          facing: "ne",
        },
      ],
      true,
    );
    // RNG: initiative; a to-hit + location; c to-hit + location; one 20+
    // damage PSR per target; padding for pilot/consciousness rolls.
    const rng = scriptedRng(1, 2, 3, 3, 3, 3, 3, 4, 3, 3, 3, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3);
    const bBefore = poolTotal(battle.units.b!);
    const dBefore = poolTotal(battle.units.d!);
    rollInitiativePhase(battle, rng, []);
    advancePhase(battle, []);
    // Activation alternates teams (loser first): a, b, c, d. Idle occupants
    // pass like the web layer (`passedAttacks`).
    declareAttacks(battle, "a", [{ weaponIndex: 4, targetId: "b" }], [], []);
    battle.units.b!.passedAttacks = true;
    declareAttacks(battle, "c", [{ weaponIndex: 4, targetId: "d" }], [], []);
    battle.units.d!.passedAttacks = true;
    const events: GameEvent[] = [];
    resolveAllAttacks(battle, rng, events);

    expect(battle.buildings["3,3"]?.cf).toBe(11);
    expect(events).toContainEqual({
      kind: "buildingDamaged",
      col: 3,
      row: 3,
      damage: 4,
      cf: 11,
    });
    expect(events.some((e) => e.kind === "buildingCollapsed")).toBe(false);
    expect(poolTotal(battle.units.b!)).toBe(bBefore - 20);
    expect(poolTotal(battle.units.d!)).toBe(dBefore - 20);
  });

  it("collapses on tolls with punch-table groupings (TW pp.176-177)", () => {
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
    // CF 1: a single AC/20 grouping tolls 1 and collapses the hex.
    // Collapse total = ceil(1/10 x 3) = 1, one punch-table group.
    battle.buildings["3,3"] = { cf: 1, type: "light" };
    // RNG: initiative; to-hit; location 7 (center torso); punch 2
    // (leftTorso); 20+ damage PSR; padding.
    const rng = scriptedRng(1, 2, 3, 3, 3, 3, 3, 4, 2, 3, 3, 3, 3, 3, 3);
    const totalBefore = poolTotal(battle.units.b!);
    rollInitiativePhase(battle, rng, []);
    advancePhase(battle, []);
    declareAttacks(battle, "a", [{ weaponIndex: 4, targetId: "b" }], [], []);
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
      location: "leftTorso",
      damage: 1,
    });
    expect(poolTotal(battle.units.b!)).toBe(totalBefore - 21);
  });

  it("adds standard falling damage above Level 0 (TW p.177)", () => {
    const battle: BattleState = createTestBattle(
      [{ col: 3, row: 3, type: "lightBuilding", level: 2 }],
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
    battle.buildings["3,3"] = { cf: 1, type: "light" };
    // RNG: initiative; to-hit 6 (TN 5 with partial cover); location 7;
    // punch 2 (leftTorso); fall direction 1 (front); three falling groups
    // (50t x 3 levels = 15) on 6 (rightTorso); padding for seatbelt/PSRs.
    const rng = scriptedRng(
      1,
      2,
      3,
      3,
      3,
      3,
      3,
      4,
      2,
      1,
      3,
      3,
      3,
      3,
      3,
      3,
      3,
      3,
      3,
      3,
      3,
      3,
      3,
      3,
      3,
      3,
      3,
      3,
    );
    const totalBefore = poolTotal(battle.units.b!);
    rollInitiativePhase(battle, rng, []);
    advancePhase(battle, []);
    declareAttacks(battle, "a", [{ weaponIndex: 4, targetId: "b" }], [], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(battle, rng, events);

    expect(battle.buildings["3,3"]).toBeUndefined();
    expect(events).toContainEqual({ kind: "buildingCollapsed", col: 3, row: 3 });
    expect(events.some((e) => e.kind === "unitFell" && e.cause.kind === "buildingCollapse")).toBe(
      true,
    );
    // 20 attack + 1 collapse + 15 falling (50t, 2 levels + 1).
    expect(poolTotal(battle.units.b!)).toBe(totalBefore - 36);
  });
});

describe("collapseDamageTotal", () => {
  it("scales base damage by levels above, rounding up at the end (TW p.176)", () => {
    // Base = CF/10 unrounded; total = base + base x levels, ceil at end.
    expect(collapseDamageTotal(40, 2)).toBe(12);
    expect(collapseDamageTotal(15, 2)).toBe(5);
    expect(collapseDamageTotal(120, 2)).toBe(36);
    expect(collapseDamageTotal(40, 0)).toBe(4);
    expect(collapseDamageTotal(1, 2)).toBe(1);
  });
});

describe("punchHitLocation", () => {
  it("rolls the Front/Rear punch column (TW p.145)", () => {
    expect(punchHitLocation(1)).toBe("leftArm");
    expect(punchHitLocation(2)).toBe("leftTorso");
    expect(punchHitLocation(3)).toBe("centerTorso");
    expect(punchHitLocation(4)).toBe("rightTorso");
    expect(punchHitLocation(5)).toBe("rightArm");
    expect(punchHitLocation(6)).toBe("head");
  });
});
function poolTotal(unit: UnitState): number {
  let total = 0;
  for (const pool of Object.values(unit.damage.armor)) total += pool;
  for (const pool of Object.values(unit.damage.armorRear)) total += pool;
  for (const pool of Object.values(unit.damage.internalStructure)) total += pool;
  return total;
}
