import { describe, expect, it } from "vitest";
import type { BattleState, GameEvent } from "../src/rules/game";
import {
  advancePhase,
  buildUnitInit,
  declareAttacks,
  ejectPilot,
  killCredit,
  nextActor,
  passAttack,
  requireUnit,
  resolveAllAttacks,
  rollInitiativePhase,
} from "../src/rules/game";
import { parseBattleState, saveBattleState } from "../src/rules/snapshot";
import { createTestBattle, scriptedRng } from "./helpers";

// Kill credit (docs/SCORING.md §6): a removed unit's `unitRemoved` event
// shares the kill among the enemies that damaged it in the resolution that
// removed it, by armor + structure points dealt there. The battle-long
// `damageTakenFrom` ledger records every hit but does not drive credit.

/** hbk + wvr (team 1) against enf (team 2) and its teammate cda. */
function lance(): BattleState {
  return createTestBattle(
    [],
    [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
      buildUnitInit("wvr", "WVR-6R", 1, { col: 4, row: 2 }, "s"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 3 }, "n"),
      buildUnitInit("cda", "CDA-3MA", 2, { col: 4, row: 4 }, "n"),
    ],
    true,
  );
}

function toAttack(state: BattleState): void {
  rollInitiativePhase(state, scriptedRng(2, 2, 5, 5), []);
  advancePhase(state, [], scriptedRng());
}

const HIGH_RNG = { d6: () => 6, snapshot: () => "", load: () => {} };

/** Walk the attack-phase actor queue: run `plans[id]` for its unit, pass the rest. */
function declareAll(state: BattleState, plans: Record<string, () => void>): void {
  for (let actor = nextActor(state); actor !== null; actor = nextActor(state)) {
    const plan = plans[actor];
    if (plan !== undefined) plan();
    else passAttack(state, actor);
  }
}

describe("damageTakenFrom ledger", () => {
  it("gives no kill credit outside a damage window", () => {
    const state = lance();
    const enf = requireUnit(state, "enf");
    enf.damageTakenFrom = { hbk: 10, wvr: 30 };
    expect(killCredit(state, enf)).toEqual([]);
  });

  it("survives a snapshot round trip", () => {
    const state = lance();
    requireUnit(state, "enf").damageTakenFrom = { hbk: 7 };
    const back = parseBattleState(saveBattleState(state));
    expect(back.units.enf!.damageTakenFrom).toEqual({ hbk: 7 });
  });
});

describe("unitRemoved credit", () => {
  it("credits only the resolution that removed the unit, not earlier damage", () => {
    const state = lance();
    toAttack(state);
    const enf = requireUnit(state, "enf");
    // The Wolverine stripped 18 points in an earlier turn.
    enf.damageTakenFrom = { wvr: 18 };
    enf.pilotHits = enf.pilotHitMax - 1;
    enf.damage.armor.centerTorso = 0;
    enf.damage.internalStructure.centerTorso = 1;
    // hbk's ML #1 hits the head (6+6, the sixth pilot hit), ML #2 the CT (3+4).
    declareAll(state, {
      hbk: () =>
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
        ),
    });
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(3, 3, 6, 6, 3, 3, 3, 4, 1, 3, 3), events);
    const removed = events.filter((e) => e.kind === "unitRemoved" && e.unitId === "enf");
    expect(removed[0]).toMatchObject({
      reason: "pilotKilled",
      credit: [{ unitId: "hbk", damage: 6, share: 1 }],
    });
    // The frame destroyed in the same step is not credited a second time.
    expect(removed[1]).toMatchObject({ reason: "destroyed", credit: [] });
    // The ledger keeps both.
    expect(enf.damageTakenFrom).toEqual({ wvr: 18, hbk: 6 });
  });

  it("shares a kill between every enemy that hit in the same sub-pass", () => {
    const state = lance();
    toAttack(state);
    const enf = requireUnit(state, "enf");
    enf.damageTakenFrom = { wvr: 40 };
    enf.pilotHits = enf.pilotHitMax - 1;
    // Every die a 6: every shot hits the head, the first one kills the pilot.
    declareAll(state, {
      hbk: () =>
        declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], [], HIGH_RNG),
      wvr: () =>
        declareAttacks(state, "wvr", [{ weaponIndex: 1, targetId: "enf" }], [], [], HIGH_RNG),
    });
    const events: GameEvent[] = [];
    resolveAllAttacks(state, HIGH_RNG, events);
    const removed = events.find((e) => e.kind === "unitRemoved" && e.unitId === "enf");
    if (removed?.kind !== "unitRemoved") throw new Error("enf not removed");
    expect(removed.credit.map((c) => c.unitId).sort()).toEqual(["hbk", "wvr"]);
    expect(removed.credit.reduce((n, c) => n + c.share, 0)).toBeCloseTo(1);
    const wvr = removed.credit.find((c) => c.unitId === "wvr")!;
    expect(wvr.damage).toBe(enf.damageTakenFrom.wvr! - 40);
  });

  it("never saves the damage window", () => {
    const state = lance();
    toAttack(state);
    declareAll(state, {
      hbk: () =>
        declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], [], HIGH_RNG),
    });
    resolveAllAttacks(state, HIGH_RNG, []);
    expect(state.currentDealt).toBeDefined();
    expect(saveBattleState(state)).not.toContain("currentDealt");
    expect(parseBattleState(saveBattleState(state)).currentDealt).toBeUndefined();
  });

  it("gives none for an ejection outside a damage window", () => {
    const state = lance();
    rollInitiativePhase(state, scriptedRng(5, 5, 2, 2), []); // team 2 (enf) moves first
    const enf = requireUnit(state, "enf");
    enf.damageTakenFrom = { hbk: 25 };
    const events: GameEvent[] = [];
    ejectPilot(state, "enf", HIGH_RNG, events);
    const removed = events.find((e) => e.kind === "unitRemoved");
    expect(removed).toMatchObject({ unitId: "enf", reason: "pilotEjected", credit: [] });
  });

  it("records physical attack damage against the attacker", () => {
    const state = lance();
    toAttack(state);
    const hbk = requireUnit(state, "hbk");
    declareAll(state, {
      enf: () =>
        declareAttacks(
          state,
          "enf",
          [],
          [{ type: "punch", targetId: "hbk", limb: "rightArm" }],
          [],
          HIGH_RNG,
        ),
    });
    const events: GameEvent[] = [];
    resolveAllAttacks(state, { d6: () => 4, snapshot: () => "", load: () => {} }, events);
    const punch = events.find((e) => e.kind === "physicalAttackResolved");
    if (punch?.kind !== "physicalAttackResolved") throw new Error("no punch resolved");
    expect(punch.resolution.hit).toBe(true);
    const dealt = punch.resolution.damageToTarget.reduce((n, g) => n + g.damage, 0);
    expect(hbk.damageTakenFrom).toEqual({ enf: dealt });
  });
});
