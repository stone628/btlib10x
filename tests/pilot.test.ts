import { describe, expect, it } from "vitest";
import { neighbor } from "../src/core/hex";
import { mechDef } from "../src/data/index";
import { mechDefFor } from "../src/index";
import { resolveWeaponAttack } from "../src/rules/attack";
import { setSlotDestroyed } from "../src/rules/critical";
import {
  advancePhase,
  applyPilotHits,
  type BattleState,
  buildUnitInit,
  createBattle,
  declareAttacks,
  ejectPilot,
  executeMove,
  type GameEvent,
  isHull,
  isImmobile,
  isUnitOnBoard,
  nextActor,
  occupantAt,
  occupantTeamAt,
  partialCoverMod,
  requireUnit,
  resolveAllAttacks,
  rollInitiativePhase,
  type UnitInit,
  type UnitState,
  validateAttacks,
} from "../src/rules/game";
import { losClear } from "../src/rules/los";
import { reachableLandings } from "../src/rules/movement";
import { pilotRecord, pilotStatus } from "../src/rules/pilot";
import { consciousnessTarget, ejectionDamage, ejectionModifier } from "../src/rules/piloting";
import { loadBattleState, saveBattleState } from "../src/rules/snapshot";
import { toHitTotal } from "../src/rules/tohit";
import { sheetIdLine } from "../web/terminal/session.common";
import { checkVictory, createTestBattle, scriptedRng } from "./helpers";

function battle(hbkExtra: Partial<UnitInit> = {}): BattleState {
  const units: UnitInit[] = [
    { ...buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"), ...hbkExtra },
    buildUnitInit("enf", "ENF-4R", 2, { col: 5, row: 4 }, "nw"),
  ];
  const state = createTestBattle([], units, true);
  rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
  return state;
}

/** Sum of `pilotDamaged.hits` emitted for `unitId`. */
function pilotHitsEvented(events: readonly GameEvent[], unitId: string): number {
  return events.reduce(
    (sum, e) => (e.kind === "pilotDamaged" && e.unitId === unitId ? sum + e.hits : sum),
    0,
  );
}

function hurtHead(unit: UnitState, points: number): void {
  const is = unit.damage.internalStructure;
  unit.damage = { ...unit.damage, internalStructure: { ...is, head: is.head - points } };
}

describe("consciousnessTarget scaling", () => {
  it("six-hit pilot matches the printed TW table", () => {
    expect([1, 2, 3, 4, 5, 6].map((h) => consciousnessTarget(h, 6))).toEqual([
      3,
      5,
      7,
      10,
      11,
      null,
    ]);
    expect(consciousnessTarget(0)).toBe(0);
  });

  it("scales the table to a 5-hit and a 7-hit pilot", () => {
    expect([1, 2, 3, 4, 5].map((h) => consciousnessTarget(h, 5))).toEqual([3, 5, 10, 11, null]);
    expect([1, 2, 3, 4, 5, 6, 7].map((h) => consciousnessTarget(h, 7))).toEqual([
      3,
      5,
      7,
      7,
      10,
      11,
      null,
    ]);
  });
});

describe("pilotHitMax", () => {
  it("defaults to 6 and honours UnitInit", () => {
    expect(requireUnit(battle(), "hbk").pilotHitMax).toBe(6);
    expect(requireUnit(battle({ pilotHitMax: 7 }), "hbk").pilotHitMax).toBe(7);
  });

  it("rejects non-integer or < 1 values", () => {
    for (const bad of [0, -1, 2.5]) {
      expect(() =>
        createBattle({ name: "t", width: 8, height: 8, cells: [] } as never, [
          buildUnitInit("a", "HBK-4G", 1, { col: 1, row: 1 }, "n", 4, 5, bad),
          buildUnitInit("b", "ENF-4R", 2, { col: 3, row: 3 }, "n"),
        ]),
      ).toThrow(/pilotHitMax/);
    }
  });

  it("round-trips through a snapshot", () => {
    const state = battle({ pilotHitMax: 5 });
    const snap = saveBattleState(state);
    requireUnit(state, "hbk").pilotHitMax = 9;
    loadBattleState(state, snap);
    expect(requireUnit(state, "hbk").pilotHitMax).toBe(5);
  });
});

describe("pilotStatus / pilotRecord", () => {
  it("derives the four states", () => {
    const state = battle();
    const hbk = requireUnit(state, "hbk");
    expect(pilotStatus(hbk)).toBe("active");
    hbk.unconsciousSinceTurn = state.turn;
    expect(pilotStatus(hbk)).toBe("unconscious");
    hbk.pilotHits = 6;
    expect(pilotStatus(hbk)).toBe("dead");
    hbk.removed = "pilotEjected";
    expect(pilotStatus(hbk)).toBe("dead");
    hbk.pilotHits = 2;
    expect(pilotStatus(hbk)).toBe("ejected");
  });

  it("reports remaining HP and the next consciousness target", () => {
    const state = battle({ pilotHitMax: 7 });
    const hbk = requireUnit(state, "hbk");
    hbk.pilotHits = 2;
    const rec = pilotRecord(hbk);
    expect(rec.hp).toBe(5);
    expect(rec.hitMax).toBe(7);
    expect(rec.nextTarget).toBe(7);
  });
});

describe("ejection PSR", () => {
  it("success: no damage, hits retained, status ejected", () => {
    const state = battle();
    const hbk = requireUnit(state, "hbk");
    hbk.pilotHits = 2;
    const events: GameEvent[] = [];
    ejectPilot(state, "hbk", scriptedRng(6, 6), events);
    expect(hbk.pilotHits).toBe(2);
    expect(pilotStatus(hbk)).toBe("ejected");
    expect(events.some((e) => e.kind === "pilotingCheck" && e.reason === "ejection")).toBe(true);
    expect(events.some((e) => e.kind === "pilotDamaged")).toBe(false);
  });

  it("failure by 3 deals one pilot hit with a consciousness roll", () => {
    const state = battle();
    const hbk = requireUnit(state, "hbk");
    const events: GameEvent[] = [];
    hurtHead(hbk, 1);
    // target 5 -2 (clear landing) +1 (head IS damage) = 4; roll 1+1 = 2:
    // margin 2 -> 1 hit; consciousness 6+6 passes.
    ejectPilot(state, "hbk", scriptedRng(1, 1, 6, 6), events);
    const hits = events.filter((e) => e.kind === "pilotDamaged");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ reason: "ejection", totalHits: 1, hpRemaining: 5 });
    expect(hbk.pilotHits).toBe(1);
    expect(hbk.removed).toBe("pilotEjected");
  });

  it("failure by 1 deals no pilot hit", () => {
    const state = battle();
    const events: GameEvent[] = [];
    // target 5 -2 (clear landing) = 3; roll 2 fails by 1.
    ejectPilot(state, "hbk", scriptedRng(1, 1), events);
    expect(requireUnit(state, "hbk").pilotHits).toBe(0);
    expect(events.some((e) => e.kind === "pilotDamaged")).toBe(false);
  });

  it("pilot killed by ejection damage reads as dead with HP 0 (SALV-01)", () => {
    const state = battle({ pilotHitMax: 1 });
    const hbk = requireUnit(state, "hbk");
    hurtHead(hbk, 1);
    ejectPilot(state, "hbk", scriptedRng(1, 1), []);
    expect(hbk.removed).toBe("pilotEjected");
    expect(pilotStatus(hbk)).toBe("dead");
    expect(pilotRecord(hbk).hp).toBe(0);
  });

  it("ejectionDamage is floor(margin / 2)", () => {
    expect(ejectionDamage({ target: 5, roll: 2, success: false })).toBe(1);
    expect(ejectionDamage({ target: 5, roll: 4, success: false })).toBe(0);
    expect(ejectionDamage({ target: 7, roll: 2, success: false })).toBe(2);
    expect(ejectionDamage({ target: 5, roll: 9, success: true })).toBe(0);
  });
});

describe("eject", () => {
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
      expect(() => ejectPilot(state, "hbk", scriptedRng(6, 6), [])).toThrow(
        /not the current actor/,
      );
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
        policy: {
          ammoPolicy: "exposed",
          autoEject: false,
          heatFlamer: true,
          amsPolicy: "expected",
        },
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
        expect.objectContaining({
          kind: "unitFell",
          unitId: "hbk",
          cause: { kind: "salvageFall" },
        }),
      );
      // 50 t: the destroyed frame leaves wreckage (TO:AR p.155).
      expect(state.wreckage["2,4"]).toEqual([{ model: "HBK-4G", unitId: "hbk" }]);
    });
  });

  describe("API-07: kill-time pilot hits are evented (head loss)", () => {
    const NO_EJECT = {
      policy: { ammoPolicy: "exposed", autoEject: false, heatFlamer: true, amsPolicy: "expected" },
    } as const;

    it("auto-eject: pilotDamaged headLoss before the ejection PSR; unitRemoved keeps destroyReason", () => {
      const { hbk, events } = sweepHeadLoss(0);
      const raise = events.findIndex((e) => e.kind === "pilotDamaged" && e.reason === "headLoss");
      const psr = events.findIndex((e) => e.kind === "pilotingCheck" && e.reason === "ejection");
      expect(events[raise]).toMatchObject({ unitId: "hbk", hits: 5, totalHits: 5, hpRemaining: 1 });
      expect(raise).toBeGreaterThanOrEqual(0);
      expect(raise).toBeLessThan(psr);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "unitRemoved",
          unitId: "hbk",
          reason: "pilotEjected",
          destroyReason: "headDestroyed",
        }),
      );
      expect(pilotHitsEvented(events, "hbk")).toBe(hbk.pilotHits);
    });

    it("auto-eject off: pilotDamaged headLoss before unitRemoved destroyed", () => {
      const { hbk, events } = sweepHeadLoss(2, NO_EJECT);
      const raise = events.findIndex((e) => e.kind === "pilotDamaged" && e.reason === "headLoss");
      const removed = events.findIndex((e) => e.kind === "unitRemoved" && e.reason === "destroyed");
      expect(events[raise]).toMatchObject({ hits: 4, totalHits: 6, hpRemaining: 0 });
      expect(raise).toBeLessThan(removed);
      expect(pilotHitsEvented(events, "hbk") + 2).toBe(hbk.pilotHits);
    });

    it("no event when the pilot is already at the raised total", () => {
      const { hbk, events } = sweepHeadLoss(5);
      expect(hbk.pilotHits).toBe(5);
      expect(events.some((e) => e.kind === "pilotDamaged")).toBe(false);
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
});

describe("pilot-killed-destroyed", () => {
  // A pilot killed in the same step its 'Mech is destroyed keeps the removal
  // reason "pilotKilled" and also records the frame's `destroyed` reason: the
  // hull it left is destroyed at once and leaves wreckage after the salvage
  // fall (TW p.128, TO:AR p.155).

  function hbkEnf() {
    return createTestBattle(
      [],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 3 }, "n"),
      ],
      true,
    );
  }

  function toAttack(state: ReturnType<typeof hbkEnf>): void {
    // Team 2 wins initiative, so hbk (team 1) acts first.
    rollInitiativePhase(state, scriptedRng(2, 2, 5, 5), []);
    advancePhase(state, [], scriptedRng());
  }

  /** Enforcer one hit from death; its CT is bare with `ctInternal` left. */
  function primedEnf(ctInternal: number) {
    const state = hbkEnf();
    toAttack(state);
    const enf = requireUnit(state, "enf");
    enf.pilotHits = enf.pilotHitMax - 1;
    enf.damage.armor.centerTorso = 0;
    enf.damage.internalStructure.centerTorso = ctInternal;
    // ML #1 hits the head (6+6): the sixth pilot hit, no consciousness roll.
    // ML #2 hits the CT (3+4).
    declareAttacks(
      state,
      "hbk",
      [
        { weaponIndex: 1, targetId: "enf" },
        { weaponIndex: 2, targetId: "enf" },
      ],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    return state;
  }

  function removals(events: readonly GameEvent[], unitId: string) {
    return events.filter((e) => e.kind === "unitRemoved" && e.unitId === unitId);
  }

  describe("pilot killed while the 'Mech is destroyed", () => {
    it("weapon phase: CT destroyed and pilot killed records both", () => {
      const state = primedEnf(1);
      // Attack dice, then the salvage fall: direction 1, one group at 3+3.
      const rng = scriptedRng(3, 3, 6, 6, 3, 3, 3, 4, 1, 3, 3);
      const events: GameEvent[] = [];
      resolveAllAttacks(state, rng, events);
      const enf = requireUnit(state, "enf");
      expect(enf.damage.internalStructure.centerTorso).toBe(0);
      expect(enf.removed).toBe("pilotKilled");
      expect(enf.destroyed).toBe("centerTorsoDestroyed");
      expect(removals(events, "enf")).toEqual([
        // Credited once, when the pilot dies; the frame's kill adds none.
        {
          kind: "unitRemoved",
          unitId: "enf",
          reason: "pilotKilled",
          credit: [{ unitId: "hbk", damage: 6, share: 1 }],
        },
        {
          kind: "unitRemoved",
          unitId: "enf",
          reason: "destroyed",
          destroyReason: "centerTorsoDestroyed",
          credit: [],
        },
      ]);
      expect(state.wreckage["2,3"]).toEqual([{ model: "ENF-4R", unitId: "enf" }]);
      expect(rng.remaining()).toBe(0);
    });

    it("weapon phase: pilot killed in an intact frame leaves destroyed 'not'", () => {
      const state = primedEnf(20);
      const rng = scriptedRng(3, 3, 6, 6, 3, 3, 3, 4);
      resolveAllAttacks(state, rng, []);
      const enf = requireUnit(state, "enf");
      expect(enf.removed).toBe("pilotKilled");
      expect(enf.destroyed).toBe("not");
    });

    it("the end-of-attack sweep fills an engine kill on a pilot-killed unit", () => {
      const state = hbkEnf();
      toAttack(state);
      const enf = requireUnit(state, "enf");
      enf.pilotHits = enf.pilotHitMax - 1;
      applyPilotHits(state, enf, 1, "headHit", scriptedRng(), []);
      expect(enf.removed).toBe("pilotKilled");
      const def = mechDefFor(enf);
      const engine = def.critSlots.centerTorso
        .map((s, i) => (s.kind === "structure" && s.type === "engine" ? i : -1))
        .filter((i) => i >= 0)
        .slice(0, 3);
      for (const i of engine) setSlotDestroyed(enf.critSlotsDestroyed, "centerTorso", i);
      const events: GameEvent[] = [];
      advancePhase(state, events, scriptedRng(1, 3, 3));
      expect(enf.removed).toBe("pilotKilled");
      expect(enf.destroyed).toBe("engineDestroyed");
      expect(removals(events, "enf")).toEqual([
        {
          kind: "unitRemoved",
          unitId: "enf",
          reason: "destroyed",
          destroyReason: "engineDestroyed",
          credit: [],
        },
      ]);
    });

    it("an earlier destroyed reason is not overwritten", () => {
      const state = hbkEnf();
      toAttack(state);
      const enf = requireUnit(state, "enf");
      enf.pilotHits = enf.pilotHitMax - 1;
      applyPilotHits(state, enf, 1, "headHit", scriptedRng(), []);
      enf.destroyed = "cockpitDestroyed";
      enf.damage.internalStructure.centerTorso = 0;
      advancePhase(state, [], scriptedRng());
      expect(enf.destroyed).toBe("cockpitDestroyed");
    });

    it("the record sheet id line shows both reasons", () => {
      const view = {
        id: "enf",
        team: 2,
        removed: "pilotKilled",
        destroyed: "centerTorsoDestroyed",
      } as Parameters<typeof sheetIdLine>[0];
      expect(sheetIdLine(view)).toContain("pilot killed, CT destroyed");
      expect(sheetIdLine({ ...view, destroyed: "not" })).toContain("(pilot killed)");
    });
  });
});

describe("DMG-08: pilot fate reads the frame, eject first (TW p.128, TO:AR p.165)", () => {
  // HBK fires two Medium Lasers at the adjacent prone ENF (no salvage fall):
  // ML #1 at the bare CT crits the third engine slot (two already gone), ML
  // #2 strikes the head. The engine kill resolves first, so the destroy
  // reason is "engineDestroyed", yet the head decides the pilot.
  function engineThenHead(opts: { autoEject?: boolean; preHits?: number; headArmor?: number }) {
    const enfInit = buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 3 }, "n");
    const state = createTestBattle(
      [],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
        opts.autoEject === false
          ? { ...enfInit, policy: { ...enfInit.policy!, autoEject: false } }
          : enfInit,
      ],
      false,
    );
    rollInitiativePhase(state, scriptedRng(2, 2, 5, 5), []);
    advancePhase(state, [], scriptedRng());
    const enf = requireUnit(state, "enf");
    enf.pilotHits = opts.preHits ?? 0;
    enf.prone = true;
    enf.damage.armor.centerTorso = 0;
    enf.damage.armor.head = opts.headArmor ?? 0;
    setSlotDestroyed(enf.critSlotsDestroyed, "centerTorso", 0);
    setSlotDestroyed(enf.critSlotsDestroyed, "centerTorso", 1);
    declareAttacks(
      state,
      "hbk",
      [
        { weaponIndex: 1, targetId: "enf" },
        { weaponIndex: 2, targetId: "enf" },
      ],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    return { state, enf };
  }

  // ML #1: to-hit 3+3, CT 3+4, one crit 4+4, upper half 1, slot 3 (engine).
  // ML #2: to-hit 3+3, head 6+6; its crit roll (2+2 below, none) unless set.
  const ENGINE_THEN_HEAD = [3, 3, 3, 4, 4, 4, 1, 3, 3, 3, 6, 6] as const;

  it("auto-eject on: the head loss ejects though the engine kill came first", () => {
    const { state, enf } = engineThenHead({});
    const events: GameEvent[] = [];
    // Ejection PSR 6+6.
    resolveAllAttacks(state, scriptedRng(...ENGINE_THEN_HEAD, 2, 2, 6, 6), events);
    expect(enf.destroyed).toBe("engineDestroyed");
    expect(enf.removed).toBe("pilotEjected");
    expect(enf.pilotHits).toBe(enf.pilotHitMax - 1);
    expect(events.some((e) => e.kind === "pilotingCheck" && e.reason === "ejection")).toBe(true);
  });

  it("auto-eject off: the head loss kills the MechWarrior", () => {
    const { state, enf } = engineThenHead({ autoEject: false });
    // Not ejecting, the head hit lands aboard: consciousness roll 6+6.
    resolveAllAttacks(state, scriptedRng(...ENGINE_THEN_HEAD, 2, 2, 6, 6), []);
    expect(enf.destroyed).toBe("engineDestroyed");
    expect(enf.removed).toBe("destroyed");
    expect(enf.pilotHits).toBe(enf.pilotHitMax);
  });

  it("a cockpit crit after the engine kill kills the MechWarrior, no eject", () => {
    // Head armor 3 leaves the head standing at 1 structure; ML #2's crit
    // 4+4 (one) on slot 3 is the cockpit; the head hit's consciousness roll
    // is 6+6.
    const { state, enf } = engineThenHead({ headArmor: 3 });
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(...ENGINE_THEN_HEAD, 4, 4, 3, 6, 6), events);
    expect(enf.damage.internalStructure.head).toBeGreaterThan(0);
    expect(enf.destroyed).toBe("engineDestroyed");
    expect(enf.removed).toBe("destroyed");
    expect(enf.pilotHits).toBe(enf.pilotHitMax);
    expect(events.some((e) => e.kind === "pilotingCheck" && e.reason === "ejection")).toBe(false);
  });

  it("eject first: the killing volley's head hit folds into the five", () => {
    // Five prior hits: tallied first, the head hit would be the sixth.
    const { state, enf } = engineThenHead({ preHits: 5 });
    resolveAllAttacks(state, scriptedRng(...ENGINE_THEN_HEAD, 2, 2, 6, 6), []);
    expect(enf.removed).toBe("pilotEjected");
    expect(enf.pilotHits).toBe(enf.pilotHitMax - 1);
  });

  // ML #1 at the bare right torso crits its AC/10 bin: the blast takes the
  // RT and the CT. ML #2 then strikes the head.
  function blastThenHead(headArmor: number, autoEject = true) {
    const enfInit = buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 3 }, "n");
    const state = createTestBattle(
      [],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
        autoEject ? enfInit : { ...enfInit, policy: { ...enfInit.policy!, autoEject: false } },
      ],
      false,
    );
    rollInitiativePhase(state, scriptedRng(2, 2, 5, 5), []);
    advancePhase(state, [], scriptedRng());
    const enf = requireUnit(state, "enf");
    enf.prone = true;
    enf.damage.armor.rightTorso = 0;
    enf.damage.armor.head = headArmor;
    declareAttacks(
      state,
      "hbk",
      [
        { weaponIndex: 1, targetId: "enf" },
        { weaponIndex: 2, targetId: "enf" },
      ],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    return { state, enf };
  }

  // ML #1: to-hit 3+3, right torso 3+3, crit 4+4, upper half 1, slot 3 (AC/10
  // bin); the blast's crit rolls 2+2, 2+2 find nothing. ML #2: to-hit 3+3,
  // head 6+6.
  const BLAST_THEN_HEAD = [3, 3, 3, 3, 4, 4, 1, 3, 2, 2, 2, 2, 3, 3, 6, 6] as const;

  it("head lost with a CT blast ejects at five, the feedback folded in", () => {
    const { state, enf } = blastThenHead(0);
    const events: GameEvent[] = [];
    // Head crit roll 2+2 (none), then the ejection PSR 6+6.
    resolveAllAttacks(state, scriptedRng(...BLAST_THEN_HEAD, 2, 2, 6, 6), events);
    expect(enf.damage.internalStructure.head).toBe(0);
    expect(enf.destroyed).toBe("centerTorsoDestroyed");
    expect(enf.removed).toBe("pilotEjected");
    expect(enf.pilotHits).toBe(enf.pilotHitMax - 1);
    expect(events.some((e) => e.kind === "pilotDamaged" && e.reason === "ammoExplosion")).toBe(
      false,
    );
  });

  it("a cockpit lost with a CT blast kills the MechWarrior, no eject", () => {
    // Head armor 3 leaves the head at 1 structure; its crit 4+4 (one) on
    // slot 3 is the cockpit.
    const { state, enf } = blastThenHead(3);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(...BLAST_THEN_HEAD, 4, 4, 3), events);
    expect(enf.damage.internalStructure.head).toBeGreaterThan(0);
    expect(enf.removed).toBe("destroyed");
    expect(enf.pilotHits).toBe(enf.pilotHitMax);
    expect(events.some((e) => e.kind === "pilotingCheck" && e.reason === "ejection")).toBe(false);
  });

  describe("API-07: kill-time pilot hits are evented", () => {
    it("cockpit: pilotDamaged cockpitHit before unitRemoved destroyed", () => {
      const { state, enf } = engineThenHead({ headArmor: 3 });
      const events: GameEvent[] = [];
      resolveAllAttacks(state, scriptedRng(...ENGINE_THEN_HEAD, 4, 4, 3, 6, 6), events);
      const raise = events.findIndex((e) => e.kind === "pilotDamaged" && e.reason === "cockpitHit");
      const removed = events.findIndex((e) => e.kind === "unitRemoved" && e.reason === "destroyed");
      // The head hit's own point landed first (1), the cockpit raises to 6.
      expect(events[raise]).toMatchObject({ unitId: "enf", hits: 5, totalHits: 6 });
      expect(raise).toBeLessThan(removed);
      expect(pilotHitsEvented(events, "enf")).toBe(enf.pilotHits);
    });

    it("auto-eject: unitRemoved pilotEjected carries the engine kill as destroyReason", () => {
      const { state, enf } = engineThenHead({});
      const events: GameEvent[] = [];
      resolveAllAttacks(state, scriptedRng(...ENGINE_THEN_HEAD, 2, 2, 6, 6), events);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "unitRemoved",
          reason: "pilotEjected",
          destroyReason: "engineDestroyed",
        }),
      );
      expect(pilotHitsEvented(events, "enf")).toBe(enf.pilotHits);
    });

    it("CT blast without auto-eject: pilotDamaged ctBlast, total 6", () => {
      // Head armor 9 holds ML #2; spare 6s cover any consciousness rolls.
      const { state, enf } = blastThenHead(9, false);
      const events: GameEvent[] = [];
      resolveAllAttacks(state, scriptedRng(...BLAST_THEN_HEAD, 6, 6, 6, 6, 6, 6, 6, 6), events);
      expect(enf.damage.internalStructure.head).toBeGreaterThan(0);
      expect(enf.removed).toBe("destroyed");
      expect(enf.pilotHits).toBe(6);
      const raise = events.find((e) => e.kind === "pilotDamaged" && e.reason === "ctBlast");
      expect(raise).toMatchObject({ unitId: "enf", totalHits: 6, hpRemaining: 0 });
      expect(pilotHitsEvented(events, "enf")).toBe(enf.pilotHits);
    });

    it("CT blast with the head lost and auto-eject: pilotDamaged headLoss before the ejection PSR", () => {
      const { state, enf } = blastThenHead(0);
      const events: GameEvent[] = [];
      resolveAllAttacks(state, scriptedRng(...BLAST_THEN_HEAD, 2, 2, 6, 6), events);
      const raise = events.findIndex((e) => e.kind === "pilotDamaged" && e.reason === "headLoss");
      const psr = events.findIndex((e) => e.kind === "pilotingCheck" && e.reason === "ejection");
      expect(events[raise]).toMatchObject({ hits: 5, totalHits: 5 });
      expect(raise).toBeLessThan(psr);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "unitRemoved",
          reason: "pilotEjected",
          destroyReason: "centerTorsoDestroyed",
        }),
      );
      expect(pilotHitsEvented(events, "enf")).toBe(enf.pilotHits);
    });
  });

  it("an ejected pilot takes the blast feedback but no hits aboard", () => {
    const state = battle();
    const hbk = requireUnit(state, "hbk");
    hbk.destroyed = "centerTorsoDestroyed";
    hbk.removed = "pilotEjected";
    applyPilotHits(state, hbk, 1, "headHit", scriptedRng(), []);
    applyPilotHits(state, hbk, 1, "fall", scriptedRng(), []);
    expect(hbk.pilotHits).toBe(0);
    applyPilotHits(state, hbk, 2, "ammoExplosion", scriptedRng(6, 6, 6, 6), []);
    expect(hbk.pilotHits).toBe(2);
  });
});
