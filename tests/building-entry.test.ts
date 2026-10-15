import { describe, expect, it } from "vitest";
import { hexKey } from "../src/core/types";
import {
  applyFall,
  buildUnitInit,
  executeMove,
  type GameEvent,
  requireUnit,
  rollInitiativePhase,
} from "../src/rules/game";
import { buildingMovementModifier } from "../src/rules/piloting";

import { createTestBattle, groupsTotaling, scriptedRng } from "./helpers";

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
      expect.objectContaining({ kind: "buildingCrash", groups: groupsTotaling(2), column: "rear" }),
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

  it("a jump landing keeps the type modifier only and leaves the CF alone", () => {
    const state = createTestBattle(
      [{ col: 2, row: 4, type: "lightBuilding" }],
      [
        buildUnitInit("enf", "ENF-4R", 1, { col: 2, row: 1 }, "s"),
        buildUnitInit("hbk", "HBK-4G", 2, { col: 8, row: 8 }, "n"),
      ],
      true,
    );
    rollInitiativeFor(state);
    const events: GameEvent[] = [];
    executeMove(
      state,
      "enf",
      "jump",
      [2, 3, 4].map((row) => ({ kind: "enter" as const, to: { col: 2, row } })),
      events,
      { rng: scriptedRng(6, 6) },
    );
    expect(buildingChecks(events).map((e) => e.triggerModifier)).toEqual([0]);
    expect(state.buildings[hexKey({ col: 2, row: 4 })]!.cf).toBe(15);
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
      { cause: { kind: "shutdown" }, hex: { col: 2, row: 2 }, seatbeltModifier: 0, halved: false },
      [],
    );
    expect(state.buildings[hexKey({ col: 2, row: 3 })]!.cf).toBe(40);
  });
});

function rollInitiativeFor(state: ReturnType<typeof createTestBattle>): void {
  rollInitiativePhase(state, TEAM1_FIRST(), []);
}
