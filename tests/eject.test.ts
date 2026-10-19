import { describe, expect, it } from "vitest";
import { neighbor } from "../src/core/hex";
import { mechDef } from "../src/data/index";
import { resolveWeaponAttack } from "../src/rules/attack";
import type { BattleState, GameEvent, UnitInit } from "../src/rules/game";
import {
  advancePhase,
  buildUnitInit,
  ejectPilot,
  executeMove,
  isHull,
  isImmobile,
  isUnitOnBoard,
  nextActor,
  occupantAt,
  occupantTeamAt,
  partialCoverMod,
  requireUnit,
  rollInitiativePhase,
  validateAttacks,
} from "../src/rules/game";
import { losClear } from "../src/rules/los";
import { reachableLandings } from "../src/rules/movement";
import { pilotRecord } from "../src/rules/pilot";
import { ejectionModifier } from "../src/rules/piloting";
import { toHitTotal } from "../src/rules/tohit";
import { checkVictory, createTestBattle, scriptedRng } from "./helpers";

function hbkVsEnf(): BattleState {
  const units: UnitInit[] = [
    buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
    buildUnitInit("enf", "ENF-4R", 2, { col: 5, row: 4 }, "nw"),
  ];
  return createTestBattle([], units, true);
}

function startMovementTurn(state: BattleState, rng = scriptedRng(1, 1, 4, 4)): BattleState {
  rollInitiativePhase(state, rng, []);
  return state;
}

describe("eject", () => {
  it("requires the movement phase", () => {
    const state = hbkVsEnf();
    expect(() => ejectPilot(state, "hbk", scriptedRng(6, 6), [])).toThrow(/before initiative/);
  });

  it("removes the unit, marks it acted, emits events, and leaves a hull", () => {
    const state = startMovementTurn(hbkVsEnf());
    const events: GameEvent[] = [];
    ejectPilot(state, "hbk", scriptedRng(6, 6), events);
    const hbk = requireUnit(state, "hbk");
    expect(hbk.removed).toBe("pilotEjected");
    expect(hbk.destroyed).toBe("not");
    expect(isHull(hbk)).toBe(true);
    expect(isUnitOnBoard(hbk)).toBe(true);
    expect(state.actedThisPhase).toContain("hbk");
    expect(
      events.some(
        (e) => e.kind === "unitRemoved" && e.unitId === "hbk" && e.reason === "pilotEjected",
      ),
    ).toBe(true);
    expect(occupantAt(state, { col: 2, row: 4 })?.id).toBe("hbk");
    expect(state.wreckage).toEqual({});
  });

  it("rejects a unit already removed from play", () => {
    const state = startMovementTurn(hbkVsEnf());
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(() => ejectPilot(state, "hbk", scriptedRng(6, 6), [])).toThrow(/not the current actor/);
  });

  it("allows a shut-down unit to eject", () => {
    const state = startMovementTurn(hbkVsEnf());
    requireUnit(state, "hbk").shutdown = "manual";
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(requireUnit(state, "hbk").removed).toBe("pilotEjected");
    expect(isHull(requireUnit(state, "hbk"))).toBe(true);
  });

  it("skips the ejected unit in the actor queue and settles victory", () => {
    const state = startMovementTurn(hbkVsEnf());
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(nextActor(state)).toBe("enf");
    expect(checkVictory(state).winnerTeam).toBe(2);
  });

  it("keeps the posture it was left in", () => {
    const state = startMovementTurn(hbkVsEnf());
    requireUnit(state, "hbk").prone = true;
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(requireUnit(state, "hbk").prone).toBe(true);
    expect(isHull(requireUnit(state, "hbk"))).toBe(true);
  });

  it("lets any team walk through the hull hex but not end there (TO:AR p.184)", () => {
    const hull = { col: 3, row: 4 };
    const start = neighbor(hull, "s");
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, hull, "n"),
      buildUnitInit("enf", "ENF-4R", 2, start, "n"),
    ];
    const state = startMovementTurn(createTestBattle([], units, true));
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    const beyond = neighbor(hull, "n");
    executeMove(
      state,
      "enf",
      "walk",
      [
        { kind: "enter", to: hull },
        { kind: "enter", to: beyond },
      ],
      [],
      { rng: scriptedRng() },
    );
    expect(requireUnit(state, "enf").position).toEqual(beyond);
  });

  it("lists the hull hex as passable, never as a landing, and offers a charge into it", () => {
    const hull = { col: 3, row: 4 };
    const start = neighbor(hull, "s");
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, hull, "n"),
      buildUnitInit("enf", "ENF-4R", 2, start, "n"),
    ];
    const state = startMovementTurn(createTestBattle([], units, true));
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    const landings = reachableLandings(start, "n", {
      mode: "walk",
      walking: 4,
      running: 6,
      jumping: 0,
      prone: false,
      grid: state,
      team: 2,
      occupantTeam: (hex) => occupantTeamAt(state, hex, "enf"),
      meleeOk: () => true,
    });
    const at = (h: { col: number; row: number }) =>
      landings.filter((l) => l.hex.col === h.col && l.hex.row === h.row);
    expect(at(hull).every((l) => l.melee?.kind === "charge")).toBe(true);
    expect(at(hull).length).toBeGreaterThan(0);
    expect(at(neighbor(hull, "n")).length).toBeGreaterThan(0);
  });

  it("does not block LOS and gives no partial cover (TW pp.100, 102)", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 3, row: 3 }, "n"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 4 }, "s"),
      buildUnitInit("cda", "CDA-3MA", 1, { col: 3, row: 2 }, "s"),
    ];
    const state = startMovementTurn(createTestBattle([], units, true));
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(losClear(state, { col: 3, row: 2 }, { col: 3, row: 4 })).toBe(true);
    expect(partialCoverMod(state, requireUnit(state, "cda"), requireUnit(state, "enf"))).toBe(0);
  });

  it("is a legal target for both sides at the immobile modifier (TW p.110)", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 3, row: 3 }, "n"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 5 }, "n"),
      buildUnitInit("cda", "CDA-3MA", 1, { col: 3, row: 1 }, "s"),
    ];
    const state = startMovementTurn(createTestBattle([], units, true));
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    const hbk = requireUnit(state, "hbk");
    expect(isImmobile(hbk)).toBe(true);
    // Its own team (cda) and the enemy (enf) may both fire at it.
    expect(() =>
      validateAttacks(state, "cda", [{ weaponIndex: 1, targetId: "hbk" }]),
    ).not.toThrow();
    expect(() =>
      validateAttacks(state, "enf", [{ weaponIndex: 1, targetId: "hbk" }]),
    ).not.toThrow();
    // A live teammate stays off limits.
    requireUnit(state, "hbk").removed = "not";
    expect(() => validateAttacks(state, "cda", [{ weaponIndex: 1, targetId: "hbk" }])).toThrow(
      /another team/,
    );
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
    // Location roll 2+3=5 -> right leg; under cover it strikes the cover.
    const covered = resolveWeaponAttack({
      ...base,
      rng: scriptedRng(6, 6, 2, 3),
      partialCoverMod: 2,
    });
    expect(covered.breakdown.terrainMod).toBe(0);
    expect(covered.breakdown.coverMod).toBe(2);
    expect(toHitTotal(covered.breakdown)).toBe(2);
    expect(covered.hit).toBe(true);
    expect(covered.groups).toHaveLength(0);
    expect(covered.applications).toEqual([]);
    // Control: without cover the same rolls put damage on the leg.
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

/** Head zeroed before the attack-phase sweep. `prone` skips the salvage
 *  fall (TW p.128) so only the ejection is measured. */
function sweepHeadLoss(preHits: number, extra: Partial<UnitInit> = {}, prone = true) {
  const units: UnitInit[] = [
    { ...buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"), ...extra },
    buildUnitInit("enf", "ENF-4R", 2, { col: 5, row: 4 }, "nw"),
  ];
  const state = createTestBattle([], units, true);
  startMovementTurn(state);
  advancePhase(state, [], scriptedRng()); // movement -> attack
  requireUnit(state, "hbk").pilotHits = preHits;
  requireUnit(state, "hbk").prone = prone;
  zeroHead(state, "hbk");
  const events: GameEvent[] = [];
  // Ejection PSR 6+6; a standing frame then falls: direction 1 (front),
  // one 5-point group at 3+4 (center torso).
  advancePhase(state, events, scriptedRng(6, 6, 1, 3, 4)); // attack sweep
  return { state, events, hbk: requireUnit(state, "hbk") };
}

describe("auto-eject on head destruction (TO p.165)", () => {
  it("ejects instead of killing; pilot hits raised to pilotHitMax - 1", () => {
    for (const pre of [0, 3]) {
      const { hbk, events } = sweepHeadLoss(pre);
      expect(hbk.removed).toBe("pilotEjected");
      // SALV-02: the cause of the loss survives the ejection.
      expect(hbk.destroyed).toBe("headDestroyed");
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

  it("with auto-eject off the head loss kills the MechWarrior (TW p.128)", () => {
    const { hbk, events } = sweepHeadLoss(0, {
      policy: { ammoPolicy: "exposed", autoEject: false, heatFlamer: true },
    });
    expect(hbk.removed).toBe("destroyed");
    expect(hbk.destroyed).toBe("headDestroyed");
    expect(hbk.pilotHits).toBe(hbk.pilotHitMax);
    expect(events.some((e) => e.kind === "pilotingCheck" && e.reason === "ejection")).toBe(false);
  });

  it("rolls the ejection PSR with head damage +3, auto +1, clear landing -2", () => {
    const { events } = sweepHeadLoss(0, {}, false);
    const psr = events.find((e) => e.kind === "pilotingCheck" && e.reason === "ejection");
    expect(psr).toMatchObject({ triggerModifier: 2 });
  });

  it("a standing frame then takes the salvage fall, but the ejected pilot is outside it (TW p.128)", () => {
    const { hbk, events, state } = sweepHeadLoss(0, {}, false);
    expect(hbk.removed).toBe("pilotEjected");
    expect(hbk.prone).toBe(true);
    // Still pilotHitMax - 1 from the auto-eject: the fall adds no 6th hit.
    expect(hbk.pilotHits).toBe(5);
    expect(pilotRecord(hbk).status).toBe("ejected");
    expect(events.some((e) => e.kind === "pilotDamaged" && e.reason === "fall")).toBe(false);
    expect(hbk.damage.armor.centerTorso).toBe(mechDef("HBK-4G")!.armor.centerTorso - 5);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "unitFell", unitId: "hbk", cause: { kind: "salvageFall" } }),
    );
    // 50 t: the destroyed frame leaves wreckage (TO:AR p.155).
    expect(state.wreckage["2,4"]).toEqual([{ model: "HBK-4G", unitId: "hbk" }]);
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
