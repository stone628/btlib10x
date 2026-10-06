import { describe, expect, it } from "vitest";
import { neighbor } from "../src/core/hex";
import { resolveWeaponAttack } from "../src/rules/attack";
import type { BattleState, GameEvent, TerrainHexDef, UnitInit } from "../src/rules/game";
import {
  advancePhase,
  buildUnitInit,
  ejectPilot,
  executeMove,
  nextActor,
  partialCoverMod,
  requireUnit,
  rollInitiativePhase,
  wreckAt,
} from "../src/rules/game";
import { losClear } from "../src/rules/los";
import { reachableLandings } from "../src/rules/movement";
import { ejectionModifier } from "../src/rules/piloting";
import { checkVictory, createTestBattle, scriptedRng } from "./helpers";

function hbkVsEnf(): BattleState {
  const units: UnitInit[] = [
    buildUnitInit("hbk", "HBK-4G", 0, { col: 2, row: 4 }, "se"),
    buildUnitInit("enf", "ENF-4R", 1, { col: 5, row: 4 }, "nw"),
  ];
  return createTestBattle([], units, true);
}

function startMovementTurn(state: BattleState, rng = scriptedRng(3, 3, 3, 1)): BattleState {
  rollInitiativePhase(state, rng, []);
  return state;
}

describe("eject", () => {
  it("requires the movement phase", () => {
    const state = hbkVsEnf();
    expect(() => ejectPilot(state, "hbk", scriptedRng(6, 6), [])).toThrow(/movement/);
  });

  it("removes the unit, marks it acted, emits events, and spawns a level-2 wreck", () => {
    const state = startMovementTurn(hbkVsEnf());
    const events: GameEvent[] = [];
    ejectPilot(state, "hbk", scriptedRng(6, 6), events);
    const hbk = requireUnit(state, "hbk");
    expect(hbk.removed).toBe("pilotEjected");
    expect(hbk.destroyed).toBe("not");
    expect(state.actedThisPhase).toContain("hbk");
    expect(state.wrecks["2,4"]).toEqual({ unitId: "hbk", level: 2 });
    expect(
      events.some(
        (e) => e.kind === "unitRemoved" && e.unitId === "hbk" && e.reason === "pilotEjected",
      ),
    ).toBe(true);
    expect(wreckAt(state, { col: 2, row: 4 })?.unitId).toBe("hbk");
  });

  it("rejects a unit already removed from play", () => {
    const state = startMovementTurn(hbkVsEnf());
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(() => ejectPilot(state, "hbk", scriptedRng(6, 6), [])).toThrow(/removed from play/);
  });

  it("allows a shut-down unit to eject", () => {
    const state = startMovementTurn(hbkVsEnf());
    requireUnit(state, "hbk").shutdown = "manual";
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(requireUnit(state, "hbk").removed).toBe("pilotEjected");
    expect(state.wrecks["2,4"]).toEqual({ unitId: "hbk", level: 2 });
  });

  it("skips the ejected unit in the actor queue and settles victory", () => {
    const state = startMovementTurn(hbkVsEnf());
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(nextActor(state)).toBe("enf");
    expect(checkVictory(state).winnerTeam).toBe(1);
  });

  it("blocks walking into a wreck hex", () => {
    const wreck = { col: 3, row: 4 };
    const start = neighbor(neighbor(wreck, "s"), "s");
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 0, wreck, "n"),
      buildUnitInit("enf", "ENF-4R", 1, start, "n"),
    ];
    const state = startMovementTurn(createTestBattle([], units, true));
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(() =>
      executeMove(
        state,
        "enf",
        "walk",
        [
          { kind: "enter", to: neighbor(start, "n") },
          { kind: "enter", to: wreck },
        ],
        [],
      ),
    ).toThrow(/wreck/);
  });

  it("blocks landing on a wreck hex", () => {
    const wreck = { col: 3, row: 4 };
    const start = neighbor(wreck, "n");
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 0, wreck, "n"),
      buildUnitInit("enf", "ENF-4R", 1, start, "s"),
    ];
    const state = startMovementTurn(createTestBattle([], units, true));
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(
      reachableLandings(start, "s", {
        mode: "jump",
        walking: 4,
        running: 7,
        jumping: 3,
        prone: false,
        grid: state,
        team: 1,
        wreckAt: (hex) => wreckAt(state, hex) !== undefined,
        occupantTeam: () => undefined,
      }).some((l) => l.hex.col === wreck.col && l.hex.row === wreck.row),
    ).toBe(false);
    expect(() => executeMove(state, "enf", "walk", [{ kind: "enter", to: wreck }], [])).toThrow(
      /wreck/,
    );
  });

  it("a level-2 wreck blocks LOS only when lying strictly between the endpoints", () => {
    const state = startMovementTurn(hbkVsEnf());
    requireUnit(state, "hbk").position = { col: 3, row: 4 };
    const from = { col: 2, row: 4 };
    const to = { col: 4, row: 4 };
    expect(losClear(state, from, to)).toBe(true);
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(state.wrecks["3,4"]?.level).toBe(2);
    expect(losClear(state, from, to, state.wrecks)).toBe(false);
    expect(losClear(state, from, { col: 3, row: 4 }, state.wrecks)).toBe(true);
  });

  it("a level-1 wreck does not block LOS between standard ground 'Mechs (TO)", () => {
    const units: UnitInit[] = [
      // BZK-F3 is 35t (light) → eject produces a level-1 wreck per TO.
      buildUnitInit("bzk", "BZK-F3", 0, { col: 3, row: 4 }, "n"),
      buildUnitInit("enf", "ENF-4R", 1, { col: 5, row: 4 }, "nw"),
    ];
    const state = startMovementTurn(createTestBattle([], units, true));
    const from = { col: 2, row: 4 };
    const to = { col: 4, row: 4 };
    expect(losClear(state, from, to)).toBe(true);
    ejectPilot(state, "bzk", scriptedRng(6, 6), []);
    expect(state.wrecks["3,4"]?.level).toBe(1);
    // Tactical Operations: L1 does not block LOS between two standing standard 'Mechs.
    expect(losClear(state, from, to, state.wrecks)).toBe(true);
  });

  it("grants +2 partial cover to a target adjacent to a wreck", () => {
    const wreck = { col: 3, row: 3 };
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 0, wreck, "n"),
      buildUnitInit("enf", "ENF-4R", 1, { col: 3, row: 4 }, "s"),
      buildUnitInit("cda", "CDA-3MA", 0, { col: 2, row: 4 }, "se"),
    ];
    const state = startMovementTurn(createTestBattle([], units, true));
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(partialCoverMod(state, requireUnit(state, "cda"), requireUnit(state, "enf"))).toBe(2);
    requireUnit(state, "enf").position = { col: 1, row: 5 };
    expect(partialCoverMod(state, requireUnit(state, "cda"), requireUnit(state, "enf"))).toBe(0);
  });

  it("prone eject leaves a level-1 wreck regardless of tonnage (TO)", () => {
    const state = startMovementTurn(hbkVsEnf());
    requireUnit(state, "hbk").prone = true;
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(state.wrecks["2,4"]).toEqual({ unitId: "hbk", level: 1 });
  });

  it("light 'Mech eject leaves a level-1 wreck regardless of posture (TO)", () => {
    // BZK-F3 is 35t (light). Eject from standing or prone → L1 either way.
    const units: UnitInit[] = [
      buildUnitInit("bzk", "BZK-F3", 0, { col: 2, row: 4 }, "n"),
      buildUnitInit("enf", "ENF-4R", 1, { col: 5, row: 4 }, "nw"),
    ];
    const standing = startMovementTurn(createTestBattle([], units, true));
    ejectPilot(standing, "bzk", scriptedRng(6, 6), []);
    expect(standing.wrecks["2,4"]).toEqual({ unitId: "bzk", level: 1 });

    const proneUnits: UnitInit[] = [
      buildUnitInit("bzk", "BZK-F3", 0, { col: 2, row: 4 }, "n"),
      buildUnitInit("enf", "ENF-4R", 1, { col: 5, row: 4 }, "nw"),
    ];
    const prone = startMovementTurn(createTestBattle([], proneUnits, true));
    requireUnit(prone, "bzk").prone = true;
    ejectPilot(prone, "bzk", scriptedRng(6, 6), []);
    expect(prone.wrecks["2,4"]).toEqual({ unitId: "bzk", level: 1 });
  });

  it("L1 wreck grants +1 partial cover to a standing ground target behind it (TO)", () => {
    // Light wreck (BZK) at (3,3); ENF adjacent at (3,4) standing; attacker
    // CDA at (2,4) on the same level as the target — below the L1 wreck top.
    const units: UnitInit[] = [
      buildUnitInit("bzk", "BZK-F3", 0, { col: 3, row: 3 }, "n"),
      buildUnitInit("enf", "ENF-4R", 1, { col: 3, row: 4 }, "s"),
      buildUnitInit("cda", "CDA-3MA", 0, { col: 2, row: 4 }, "se"),
    ];
    const state = startMovementTurn(createTestBattle([], units, true));
    ejectPilot(state, "bzk", scriptedRng(6, 6), []);
    expect(state.wrecks["3,3"]?.level).toBe(1);
    expect(partialCoverMod(state, requireUnit(state, "cda"), requireUnit(state, "enf"))).toBe(1);
  });

  it("L1 wreck provides no cover to a prone target (TO: standing ground only)", () => {
    const units: UnitInit[] = [
      buildUnitInit("bzk", "BZK-F3", 0, { col: 3, row: 3 }, "n"),
      buildUnitInit("enf", "ENF-4R", 1, { col: 3, row: 4 }, "s"),
      buildUnitInit("cda", "CDA-3MA", 0, { col: 2, row: 4 }, "se"),
    ];
    const state = startMovementTurn(createTestBattle([], units, true));
    ejectPilot(state, "bzk", scriptedRng(6, 6), []);
    requireUnit(state, "enf").prone = true;
    expect(partialCoverMod(state, requireUnit(state, "cda"), requireUnit(state, "enf"))).toBe(0);
  });

  it("L2 wreck: +1 partial cover for an elevated target with attacker at wreck top (TO)", () => {
    // HBK wreck at (3,3) on default hex level 0 → wreckTop = 0 + 2 = 2.
    // Target ENF on hex level 3 (Level 3+ target). Attacker CDA on hex level
    // 2 (equal to wreck top, so attacker is "at" the wreck top → attacker is
    // NOT below). Target is elevated vs attacker. → TO +1 branch fires.
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 0, { col: 3, row: 3 }, "n"),
      buildUnitInit("enf", "ENF-4R", 1, { col: 3, row: 4 }, "s"),
      buildUnitInit("cda", "CDA-3MA", 0, { col: 2, row: 3 }, "se"),
    ];
    const terrain: TerrainHexDef[] = [
      { col: 3, row: 4, type: "clear", level: 3 },
      { col: 2, row: 3, type: "clear", level: 2 },
    ];
    const state = startMovementTurn(createTestBattle(terrain, units, true));
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(state.wrecks["3,3"]?.level).toBe(2);
    expect(partialCoverMod(state, requireUnit(state, "cda"), requireUnit(state, "enf"))).toBe(1);
  });

  it("L2 wreck still grants +2 when the attacker is below the wreck top even with an elevated target", () => {
    // Target is on hex level 2 (elevated above attacker), but the attacker is
    // still below the wreck top (cell level 0 < 0 + 2 = 2) → TW default +2
    // path wins over the TO elevated-target branch.
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 0, { col: 3, row: 3 }, "n"),
      buildUnitInit("enf", "ENF-4R", 1, { col: 3, row: 4 }, "s"),
      buildUnitInit("cda", "CDA-3MA", 0, { col: 2, row: 4 }, "se"),
    ];
    const terrain: TerrainHexDef[] = [{ col: 3, row: 4, type: "clear", level: 2 }];
    const state = startMovementTurn(createTestBattle(terrain, units, true));
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(state.wrecks["3,3"]?.level).toBe(2);
    expect(partialCoverMod(state, requireUnit(state, "cda"), requireUnit(state, "enf"))).toBe(2);
  });

  it("strikes the cover on a leg roll and deals no damage", () => {
    const target = requireUnit(startMovementTurn(hbkVsEnf()), "enf");
    const base = {
      gunnery: 0,
      piloting: 5,
      attackerMoved: "standStill" as const,
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear" as const,
      interveningTerrains: [] as const,
      distance: 1,
      weapon: "Small Laser",
      targetDamage: target.damage,
    };
    // Location roll 2+3=5 -> right leg; under cover it strikes the wreck.
    const covered = resolveWeaponAttack({
      ...base,
      rng: scriptedRng(6, 6, 2, 3),
      partialCoverMod: 2,
    });
    expect(covered.breakdown.terrainMod).toBe(0);
    expect(covered.breakdown.coverMod).toBe(2);
    expect(covered.breakdown.total).toBe(2);
    expect(covered.hit).toBe(true);
    expect(covered.groups).toHaveLength(0);
    expect(covered.application).toBeNull();
    // Control: without wreck cover the same rolls put damage on the leg.
    const open = resolveWeaponAttack({ ...base, rng: scriptedRng(6, 6, 2, 3) });
    expect(open.groups).toHaveLength(1);
    expect(open.groups[0]!.location).toBe("rightLeg");
  });
});

function zeroHead(state: BattleState, id: string): void {
  const unit = requireUnit(state, id);
  unit.damage = {
    ...unit.damage,
    internalStructure: { ...unit.damage.internalStructure, head: 0 },
  };
}

function sweepHeadLoss(preHits: number, extra: Partial<UnitInit> = {}) {
  const units: UnitInit[] = [
    { ...buildUnitInit("hbk", "HBK-4G", 0, { col: 2, row: 4 }, "se"), ...extra },
    buildUnitInit("enf", "ENF-4R", 1, { col: 5, row: 4 }, "nw"),
  ];
  const state = createTestBattle([], units, true);
  startMovementTurn(state);
  advancePhase(state, []); // movement -> attack
  requireUnit(state, "hbk").pilotHits = preHits;
  zeroHead(state, "hbk");
  const events: GameEvent[] = [];
  advancePhase(state, events, scriptedRng(6, 6, 6, 6)); // attack sweep
  return { state, events, hbk: requireUnit(state, "hbk") };
}

describe("auto-eject on head destruction (TO p.165)", () => {
  it("ejects instead of killing; pilot hits raised to pilotHitMax - 1", () => {
    for (const pre of [0, 3]) {
      const { hbk, events } = sweepHeadLoss(pre);
      expect(hbk.removed).toBe("pilotEjected");
      expect(hbk.destroyed).toBe("not");
      expect(hbk.pilotHits).toBe(5);
      expect(events.some((e) => e.kind === "unitRemoved" && e.reason === "pilotEjected")).toBe(
        true,
      );
    }
  });

  it("scales with a custom pilotHitMax", () => {
    const { hbk } = sweepHeadLoss(0, { pilotHitMax: 4 });
    expect(hbk.removed).toBe("pilotEjected");
    expect(hbk.pilotHits).toBe(3);
  });

  it("rolls the ejection PSR with head damage +3, auto +1, clear landing -2", () => {
    const { events } = sweepHeadLoss(0);
    const psr = events.find((e) => e.kind === "pilotingCheck" && e.reason === "ejection");
    expect(psr).toMatchObject({ triggerModifier: 2 });
  });
});

describe("ejectionModifier (TO p.165)", () => {
  const base = {
    landingTerrain: "clear",
    landingLevel: 0,
    prone: false,
    unconscious: false,
    headStructureDamage: 0,
    auto: false,
  } as const;
  it("sums the table terms", () => {
    expect(ejectionModifier(base)).toBe(-2);
    expect(ejectionModifier({ ...base, landingTerrain: "water1" })).toBe(-1);
    expect(ejectionModifier({ ...base, landingTerrain: "rubble" })).toBe(0);
    expect(ejectionModifier({ ...base, landingTerrain: "lightWoods" })).toBe(2);
    expect(ejectionModifier({ ...base, landingTerrain: "heavyWoods" })).toBe(3);
    expect(ejectionModifier({ ...base, landingTerrain: "mediumBuilding", landingLevel: 2 })).toBe(
      2,
    );
    expect(ejectionModifier({ ...base, prone: true })).toBe(3);
    expect(ejectionModifier({ ...base, unconscious: true })).toBe(1);
    expect(ejectionModifier({ ...base, headStructureDamage: 2 })).toBe(0);
    expect(ejectionModifier({ ...base, auto: true })).toBe(-1);
  });
});
