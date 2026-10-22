import { describe, expect, it } from "vitest";
import type { HexGrid } from "../src/core/terrain";
import { type HexCell, hexKey } from "../src/core/types";
import { resolveWeaponAttack } from "../src/rules/attack";
import {
  applyBuildingDamage,
  createBuildingState,
  isBuildingTerrain,
  isCollapsed,
} from "../src/rules/building";
import {
  advancePhase,
  applyFall,
  type BattleState,
  buildUnitInit,
  collapseDamageTotal,
  damageBuildingAt,
  declareAttacks,
  executeMove,
  type GameEvent,
  partialCoverBuildingHex,
  partialCoverMod,
  passAttack,
  requireUnit,
  resolveAllAttacks,
  rollInitiativePhase,
  type TerrainHexDef,
  type UnitInit,
  type UnitState,
} from "../src/rules/game";
import { punchHitLocation } from "../src/rules/hitlocation";
import { losBlockedByWater } from "../src/rules/los";
import { reachableLandings } from "../src/rules/movement";
import { buildingMovementModifier } from "../src/rules/piloting";
import { createTestBattle, groupsTotaling, scriptedRng } from "./helpers";

describe("isBuildingTerrain", () => {
  it("accepts each building terrain", () => {
    expect(isBuildingTerrain("lightBuilding")).toBe(true);
    expect(isBuildingTerrain("mediumBuilding")).toBe(true);
    expect(isBuildingTerrain("heavyBuilding")).toBe(true);
    expect(isBuildingTerrain("hardenedBuilding")).toBe(true);
  });

  it("rejects non-building terrain", () => {
    expect(isBuildingTerrain("clear")).toBe(false);
    expect(isBuildingTerrain("lightWoods")).toBe(false);
    expect(isBuildingTerrain("rubble")).toBe(false);
    expect(isBuildingTerrain("toString")).toBe(false);
  });
});

describe("building damage and collapse", () => {
  it("applies damage to the structural factor", () => {
    const b = createBuildingState("lightBuilding"); // CF 15
    expect(applyBuildingDamage(b, 5).cf).toBe(10);
  });

  it("clamps CF at 0 (collapse) and reports collapsed", () => {
    const b = createBuildingState("lightBuilding");
    const collapsed = applyBuildingDamage(b, 20);
    expect(collapsed.cf).toBe(0);
    expect(isCollapsed(collapsed)).toBe(true);
  });

  it("hardened buildings start at the unspecified-building default CF", () => {
    expect(createBuildingState("hardenedBuilding").cf).toBe(120);
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
    buildUnitInit("a", "HBK-4G", 1, { col: 2, row: 3 }, "se"),
    buildUnitInit("b", "ENF-4R", 2, { col: 2, row: 1 }, "sw"),
  ];
  const terrain: readonly TerrainHexDef[] = [{ col: 3, row: 3, type: "lightBuilding" }];
  return createTestBattle(terrain, units, true);
}

describe("battle building integration", () => {
  it("initializes building state from terrain", () => {
    const battle = battleWithBuilding();
    expect(battle.buildings["3,3"]).toEqual({ cf: 15 });
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
    expect(battle.rubbleOrigin["3,3"]).toBe("lightBuilding");
  });

  it("ignores damage to non-building hexes", () => {
    const battle = battleWithBuilding();
    expect(damageBuildingAt(battle, { col: 2, row: 3 }, 100, [])).toBeNull();
  });

  it("charges the phase-start toll per grouping, not full damage (TW p.171)", () => {
    // Medium building CF 40: an AC/20 single-group hit costs the hex
    // ceil(40/10) = 4, once, and absorbs that much: the occupant takes 16.
    const battle: BattleState = createTestBattle(
      [{ col: 3, row: 3, type: "mediumBuilding" }],
      [
        buildUnitInit("a", "HBK-4G", 1, { col: 2, row: 3 }, "ne"),
        buildUnitInit("b", "ENF-4R", 2, { col: 3, row: 3 }, "sw"),
      ],
      true,
    );
    // RNG: initiative 2D6 x2 teams; AC/20 to-hit then location (7 = center
    // torso, live group under partial cover); 20+ damage PSR (6 succeeds).
    const rng = scriptedRng(1, 2, 3, 3, 3, 3, 3, 4, 3, 3);
    const totalBefore = poolTotal(battle.units.b!);
    rollInitiativePhase(battle, rng, []);
    advancePhase(battle, [], scriptedRng());
    declareAttacks(
      battle,
      "a",
      [{ weaponIndex: 4, targetId: "b" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
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
    expect(poolTotal(battle.units.b!)).toBe(totalBefore - 16);
  });

  it("freezes the toll at phase-start CF and defers reduction (TW p.171)", () => {
    // Light building CF 15: two AC/20 hits in one phase — one per occupant —
    // each cost ceil(15/10) = 2, total 4, leaving CF 11 standing.
    // Full-damage arithmetic (20 + 20) would collapse it twice over.
    // (Two targets: same-target volleys share one phase-start snapshot.)
    const battle: BattleState = createTestBattle(
      [{ col: 3, row: 3, type: "lightBuilding" }],
      [
        buildUnitInit("a", "HBK-4G", 1, { col: 2, row: 3 }, "ne"),
        buildUnitInit("c", "HBK-4G", 1, { col: 4, row: 3 }, "nw"),
        buildUnitInit("b", "ENF-4R", 2, { col: 3, row: 3 }, "sw"),
        buildUnitInit("d", "ENF-4R", 2, { col: 3, row: 2 }, "ne"),
      ],
      true,
    );
    // createBattle rejects stacked starts; put d in the building hex with b.
    battle.units.d!.position = { col: 3, row: 3 };
    // RNG: initiative; a to-hit + location; c to-hit + location; one 20+
    // damage PSR per target; padding for pilot/consciousness rolls.
    const rng = scriptedRng(1, 2, 3, 3, 3, 3, 3, 4, 3, 3, 3, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3);
    const bBefore = poolTotal(battle.units.b!);
    const dBefore = poolTotal(battle.units.d!);
    rollInitiativePhase(battle, rng, []);
    advancePhase(battle, [], scriptedRng());
    // Activation alternates teams (loser first): a, b, c, d. Idle occupants
    // pass like the web layer (`passAttack`).
    declareAttacks(
      battle,
      "a",
      [{ weaponIndex: 4, targetId: "b" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    passAttack(battle, "b");
    declareAttacks(
      battle,
      "c",
      [{ weaponIndex: 4, targetId: "d" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    passAttack(battle, "d");
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
    expect(poolTotal(battle.units.b!)).toBe(bBefore - 18);
    expect(poolTotal(battle.units.d!)).toBe(dBefore - 18);
  });

  it("collapses on tolls with punch-table groupings (TW pp.176-177)", () => {
    const battle: BattleState = createTestBattle(
      [{ col: 3, row: 3, type: "lightBuilding" }],
      [
        buildUnitInit("a", "HBK-4G", 1, { col: 2, row: 3 }, "ne"),
        buildUnitInit("b", "ENF-4R", 2, { col: 3, row: 3 }, "sw"),
      ],
      true,
    );
    // CF 1: a single AC/20 grouping tolls 1 (19 reaches the occupant) and collapses the hex.
    // Collapse total = ceil(1/10 x 3) = 1, one punch-table group.
    battle.buildings["3,3"] = { cf: 1 };
    // RNG: initiative; to-hit; location 7 (center torso); punch 2
    // (leftTorso); 20+ damage PSR; padding.
    const rng = scriptedRng(1, 2, 3, 3, 3, 3, 3, 4, 2, 3, 3, 3, 3, 3, 3);
    const totalBefore = poolTotal(battle.units.b!);
    rollInitiativePhase(battle, rng, []);
    advancePhase(battle, [], scriptedRng());
    declareAttacks(
      battle,
      "a",
      [{ weaponIndex: 4, targetId: "b" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
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
    expect(poolTotal(battle.units.b!)).toBe(totalBefore - 20);
  });

  it("adds standard falling damage above Level 0 (TW p.177)", () => {
    const battle: BattleState = createTestBattle(
      [{ col: 3, row: 3, type: "lightBuilding", level: 2 }],
      [
        buildUnitInit("a", "HBK-4G", 1, { col: 2, row: 3 }, "ne"),
        buildUnitInit("b", "ENF-4R", 2, { col: 3, row: 3 }, "sw"),
      ],
      true,
    );
    battle.buildings["3,3"] = { cf: 1 };
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
    advancePhase(battle, [], scriptedRng());
    declareAttacks(
      battle,
      "a",
      [{ weaponIndex: 4, targetId: "b" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    const events: GameEvent[] = [];
    resolveAllAttacks(battle, rng, events);

    expect(battle.buildings["3,3"]).toBeUndefined();
    expect(events).toContainEqual({ kind: "buildingCollapsed", col: 3, row: 3 });
    expect(events.some((e) => e.kind === "unitFell" && e.cause.kind === "buildingCollapse")).toBe(
      true,
    );
    // 19 attack (1 absorbed) + 1 collapse + 15 falling (50t, 2 levels + 1).
    expect(poolTotal(battle.units.b!)).toBe(totalBefore - 35);
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

describe("building-entry", () => {
  /** Initiative script that makes team 1 lose, so its unit moves first. */
  const TEAM1_FIRST = (): ReturnType<typeof scriptedRng> => scriptedRng(2, 2, 5, 5);

  function buildingChecks(events: readonly GameEvent[]) {
    return events.filter(
      (e): e is Extract<GameEvent, { kind: "pilotingCheck" }> =>
        e.kind === "pilotingCheck" && e.reason === "building",
    );
  }

  describe("Building Movement Modifiers Table (TW p.167)", () => {
    it("bands hexes moved into +0..+6", () => {
      const cases: Array<[number, number]> = [
        [1, 0],
        [2, 0],
        [3, 1],
        [4, 1],
        [5, 2],
        [6, 2],
        [7, 3],
        [9, 3],
        [10, 4],
        [17, 4],
        [18, 5],
        [24, 5],
        [25, 6],
        [40, 6],
      ];
      for (const [hexes, mod] of cases) expect(buildingMovementModifier(hexes)).toBe(mod);
    });
  });

  describe("building entry (TW p.167)", () => {
    it("adds the hexes-moved modifier: Piloting 5, hardened, 5th hex → 12", () => {
      const state = createTestBattle(
        [{ col: 2, row: 6, type: "hardenedBuilding" }],
        [
          buildUnitInit("cda", "CDA-3MA", 1, { col: 2, row: 1 }, "s"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 8, row: 8 }, "n"),
        ],
        true,
      );
      rollInitiativeFor(state);
      const events: GameEvent[] = [];
      executeMove(
        state,
        "cda",
        "run",
        [2, 3, 4, 5, 6].map((row) => ({ kind: "enter" as const, to: { col: 2, row } })),
        events,
        { rng: scriptedRng(6, 6) },
      );
      const [check] = buildingChecks(events);
      expect(check).toBeDefined();
      // Hardened +5, five hexes moved +2.
      expect(check!.triggerModifier).toBe(7);
      expect(check!.basePiloting + check!.triggerModifier + check!.preexistingModifier).toBe(12);
    });

    it("a one-hex entry adds no movement modifier", () => {
      const state = createTestBattle(
        [{ col: 2, row: 3, type: "mediumBuilding" }],
        [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 8, row: 8 }, "n"),
        ],
        true,
      );
      rollInitiativeFor(state);
      const events: GameEvent[] = [];
      executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 2, row: 3 } }], events, {
        rng: scriptedRng(6, 6),
      });
      expect(buildingChecks(events).map((e) => e.triggerModifier)).toEqual([1]);
    });

    it("counts every hex this turn, not just since the last reversal", () => {
      const state = createTestBattle(
        [{ col: 2, row: 3, type: "lightBuilding" }],
        [
          buildUnitInit("cda", "CDA-3MA", 1, { col: 2, row: 1 }, "s"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 8, row: 8 }, "n"),
        ],
        true,
      );
      rollInitiativeFor(state);
      const events: GameEvent[] = [];
      // Forward into the building (2nd hex, +0), out, then back into it
      // backward (4th hex, +1).
      executeMove(
        state,
        "cda",
        "walk",
        [
          { kind: "enter", to: { col: 2, row: 2 } },
          { kind: "enter", to: { col: 2, row: 3 } },
          { kind: "enter", to: { col: 2, row: 4 } },
          { kind: "enter", to: { col: 2, row: 3 } },
        ],
        events,
        { rng: scriptedRng(6, 6, 6, 6) },
      );
      expect(buildingChecks(events).map((e) => e.triggerModifier)).toEqual([0, 1]);
      // Two entries by a 40-ton 'Mech: 15 - 4 - 4.
      expect(state.buildings[hexKey({ col: 2, row: 3 })]!.cf).toBe(7);
    });

    it("a passed entry still damages the hex by tonnage / 10", () => {
      const state = createTestBattle(
        [{ col: 2, row: 3, type: "mediumBuilding" }],
        [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 8, row: 8 }, "n"),
        ],
        true,
      );
      rollInitiativeFor(state);
      const events: GameEvent[] = [];
      executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 2, row: 3 } }], events, {
        rng: scriptedRng(6, 6),
      });
      expect(state.buildings[hexKey({ col: 2, row: 3 })]!.cf).toBe(35);
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "buildingDamaged", col: 2, row: 3, damage: 5, cf: 35 }),
      );
    });

    it("a failed entry crashes on the CF before the unit's own toll", () => {
      const state = createTestBattle(
        [{ col: 2, row: 3, type: "lightBuilding" }],
        [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 8, row: 8 }, "n"),
        ],
        true,
      );
      rollInitiativeFor(state);
      const events: GameEvent[] = [];
      // PSR 1+2 fails (target 5); crash ceil(15/10) = 2 at loc 3+4 (CT).
      executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 2, row: 3 } }], events, {
        rng: scriptedRng(1, 2, 3, 4),
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "buildingCrash",
          groups: groupsTotaling(2),
          column: "front",
        }),
      );
      expect(state.buildings[hexKey({ col: 2, row: 3 })]!.cf).toBe(10);
    });

    it("backing in puts the crash on the rear armor", () => {
      const state = createTestBattle(
        [{ col: 2, row: 1, type: "lightBuilding" }],
        [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 8, row: 8 }, "n"),
        ],
        true,
      );
      rollInitiativeFor(state);
      const hbk = requireUnit(state, "hbk");
      const frontCt = hbk.damage.armor.centerTorso;
      const rearCt = hbk.damage.armorRear.centerTorso;
      const events: GameEvent[] = [];
      executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 2, row: 1 } }], events, {
        rng: scriptedRng(1, 2, 3, 4),
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "buildingCrash",
          groups: groupsTotaling(2),
          column: "rear",
        }),
      );
      expect(hbk.damage.armor.centerTorso).toBe(frontCt);
      expect(hbk.damage.armorRear.centerTorso).toBe(rearCt - 2);
    });

    it("an entry that empties the CF collapses the hex at once and the move goes on", () => {
      const state = createTestBattle(
        [{ col: 2, row: 3, type: "lightBuilding" }],
        [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 8, row: 8 }, "n"),
        ],
        true,
      );
      rollInitiativeFor(state);
      const key = hexKey({ col: 2, row: 3 });
      state.buildings[key]!.cf = 3;
      const events: GameEvent[] = [];
      // PSR 6+6 passes; 5 damage collapses CF 3. Collapse damage
      // ceil(3/10 × 3) = 1 on punch roll 3 (CT).
      executeMove(
        state,
        "hbk",
        "walk",
        [
          { kind: "enter", to: { col: 2, row: 3 } },
          { kind: "enter", to: { col: 2, row: 4 } },
        ],
        events,
        { rng: scriptedRng(6, 6, 3) },
      );
      expect(state.buildings[key]).toBeUndefined();
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "buildingCollapsed", col: 2, row: 3 }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "collapseDamage", unitId: "hbk", damage: 1 }),
      );
      expect(requireUnit(state, "hbk").position).toEqual({ col: 2, row: 4 });
    });
  });

  describe("jumping and buildings (TW p.168)", () => {
    /** enf (2,1)/s jumps down column 2; hbk sits out of the way. */
    function jumpBattle(terrain: Parameters<typeof createTestBattle>[0]) {
      const state = createTestBattle(
        terrain,
        [
          buildUnitInit("enf", "ENF-4R", 1, { col: 2, row: 1 }, "s"),
          buildUnitInit("hbk", "HBK-4G", 2, { col: 8, row: 8 }, "n"),
        ],
        true,
      );
      rollInitiativeFor(state);
      return state;
    }
    const jumpTo = (lastRow: number) =>
      Array.from({ length: lastRow - 1 }, (_, k) => ({
        kind: "enter" as const,
        to: { col: 2, row: k + 2 },
      }));

    it.each(["lightBuilding", "mediumBuilding", "heavyBuilding", "hardenedBuilding"] as const)(
      "refuses a jump landing in a %s and leaves the state alone",
      (type) => {
        const state = jumpBattle([{ col: 2, row: 4, type }]);
        const cf = state.buildings[hexKey({ col: 2, row: 4 })]!.cf;
        const events: GameEvent[] = [];
        expect(() =>
          executeMove(state, "enf", "jump", jumpTo(4), events, { rng: scriptedRng(6, 6) }),
        ).toThrow("enf cannot use Jumping MP to enter a building hex (2,4)");
        expect(requireUnit(state, "enf").position).toEqual({ col: 2, row: 1 });
        expect(state.buildings[hexKey({ col: 2, row: 4 })]!.cf).toBe(cf);
        expect(buildingChecks(events)).toEqual([]);
        // The refused move does not use up the activation.
        executeMove(state, "enf", "jump", jumpTo(3), events, { rng: scriptedRng(6, 6) });
        expect(requireUnit(state, "enf").position).toEqual({ col: 2, row: 3 });
      },
    );

    it("allows jumping over a building and landing beyond it", () => {
      const state = jumpBattle([{ col: 2, row: 3, type: "heavyBuilding" }]);
      const events: GameEvent[] = [];
      executeMove(state, "enf", "jump", jumpTo(4), events, { rng: scriptedRng(6, 6) });
      expect(requireUnit(state, "enf").position).toEqual({ col: 2, row: 4 });
      expect(buildingChecks(events)).toEqual([]);
      expect(state.buildings[hexKey({ col: 2, row: 3 })]!.cf).toBe(90);
    });

    it("allows jumping out of a building hex", () => {
      const state = jumpBattle([{ col: 2, row: 1, type: "mediumBuilding" }]);
      const events: GameEvent[] = [];
      executeMove(state, "enf", "jump", jumpTo(3), events, { rng: scriptedRng(6, 6) });
      expect(requireUnit(state, "enf").position).toEqual({ col: 2, row: 3 });
    });

    it("allows a jump landing on rubble", () => {
      const state = jumpBattle([{ col: 2, row: 4, type: "rubble" }]);
      executeMove(state, "enf", "jump", jumpTo(4), [], { rng: scriptedRng(6, 6) });
      expect(requireUnit(state, "enf").position).toEqual({ col: 2, row: 4 });
    });

    it("reachableLandings offers a building hex to a walk but not to a jump", () => {
      const state = jumpBattle([{ col: 2, row: 3, type: "lightBuilding" }]);
      const enf = requireUnit(state, "enf");
      const landsOn = (mode: "walk" | "jump") =>
        reachableLandings(enf.position, enf.facing, {
          mode,
          walking: 4,
          running: 6,
          jumping: 4,
          prone: false,
          grid: state,
          team: 1,
          occupantTeam: () => undefined,
        }).some((l) => l.hex.col === 2 && l.hex.row === 3);
      expect(landsOn("walk")).toBe(true);
      expect(landsOn("jump")).toBe(false);
    });
  });

  describe("falling inside a building (TW p.167)", () => {
    it("damages the hex as though the 'Mech had entered it", () => {
      const state = createTestBattle(
        [{ col: 2, row: 3, type: "mediumBuilding" }],
        [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 3 }, "s"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 8, row: 8 }, "n"),
        ],
        true,
      );
      const hbk = requireUnit(state, "hbk");
      const events: GameEvent[] = [];
      // Fall dir 1, loc 3+4 (CT), seatbelt 6+6 passes.
      applyFall(
        state,
        hbk,
        scriptedRng(1, 3, 4, 6, 6),
        {
          cause: { kind: "shutdown" },
          hex: { col: 2, row: 3 },
          seatbeltModifier: 0,
          halved: false,
        },
        events,
      );
      expect(hbk.prone).toBe(true);
      expect(state.buildings[hexKey({ col: 2, row: 3 })]!.cf).toBe(35);
    });

    it("a fall outside a building leaves buildings alone", () => {
      const state = createTestBattle(
        [{ col: 2, row: 3, type: "mediumBuilding" }],
        [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 8, row: 8 }, "n"),
        ],
        true,
      );
      const hbk = requireUnit(state, "hbk");
      applyFall(
        state,
        hbk,
        scriptedRng(1, 3, 4, 6, 6),
        {
          cause: { kind: "shutdown" },
          hex: { col: 2, row: 2 },
          seatbeltModifier: 0,
          halved: false,
        },
        [],
      );
      expect(state.buildings[hexKey({ col: 2, row: 3 })]!.cf).toBe(40);
    });
  });

  function rollInitiativeFor(state: ReturnType<typeof createTestBattle>): void {
    rollInitiativePhase(state, TEAM1_FIRST(), []);
  }
});

describe("building-cover", () => {
  /**
   * Leg hits stopped by building partial cover damage the building (TW p.102,
   * BLD-03).
   */

  function setup() {
    return createTestBattle(
      [{ col: 3, row: 3, type: "lightBuilding" }],
      [
        buildUnitInit("a", "HBK-4G", 1, { col: 3, row: 2 }, "s"),
        buildUnitInit("t", "ENF-4R", 2, { col: 3, row: 4 }, "n"),
      ],
      true,
    );
  }

  describe("building as partial cover (BLD-03)", () => {
    it("names the building hex that provides the cover", () => {
      const state = setup();
      const a = requireUnit(state, "a");
      const t = requireUnit(state, "t");
      expect(partialCoverMod(state, a, t)).toBe(1);
      expect(partialCoverBuildingHex(state, a, t)).toEqual({ col: 3, row: 3 });
    });

    it("a leg result reports its damage as coverDamage instead of vanishing", () => {
      const target = requireUnit(setup(), "t");
      // 2+3 = 5 -> right leg; the cover takes the hit.
      const res = resolveWeaponAttack({
        gunnery: 0,
        attackerMoved: "standStill",
        targetHexesMoved: 0,
        targetJumped: false,
        targetTerrain: "clear",
        interveningTerrains: [],
        distance: 1,
        weapon: "Small Laser",
        targetDamage: target.damage,
        rng: scriptedRng(6, 6, 2, 3),
        partialCoverMod: 1,
      });
      expect(res.groups).toHaveLength(0);
      expect(res.coverDamage).toBe(3);
    });
  });

  describe("building misses (BLD-01)", () => {
    const input = (extra: object) => ({
      gunnery: 4,
      attackerMoved: "standStill" as const,
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear" as const,
      interveningTerrains: [],
      distance: 1,
      weapon: "Medium Laser",
      targetDamage: requireUnit(setup(), "t").damage,
      ...extra,
    });

    it("a missed shot at a target beside the building hits the building", () => {
      const res = resolveWeaponAttack({
        ...input({ missesStrikeBuilding: true }),
        rng: scriptedRng(1, 1),
      });
      expect(res.groups).toHaveLength(0);
      expect(res.buildingAbsorbed).toBe(5);
    });

    it("is off unless the attacker stands adjacent to a building target hex", () => {
      const res = resolveWeaponAttack({ ...input({}), rng: scriptedRng(1, 1) });
      expect(res.buildingAbsorbed).toBeUndefined();
    });
  });

  describe("partial cover for powered-down targets", () => {
    it("a shut-down standing 'Mech keeps its partial cover", () => {
      const state = setup();
      const a = requireUnit(state, "a");
      const t = requireUnit(state, "t");
      expect(partialCoverMod(state, a, t)).toBe(1);
      t.shutdown = "heat";
      expect(partialCoverMod(state, a, t)).toBe(1);
      t.unconsciousSinceTurn = state.turn;
      expect(partialCoverMod(state, a, t)).toBe(1);
      t.prone = true;
      expect(partialCoverMod(state, a, t)).toBe(0);
    });
  });
});
