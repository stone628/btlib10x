import { describe, expect, it } from "vitest";
import type { BattleState, GameEvent, UnitInit, UnitState } from "../src/rules/game";
import {
  buildUnitInit,
  createBattle,
  ejectPilot,
  requireUnit,
  rollInitiativePhase,
} from "../src/rules/game";
import { pilotRecord, pilotStatus } from "../src/rules/pilot";
import { consciousnessTarget, ejectionDamage } from "../src/rules/piloting";
import { loadBattleState, saveBattleState } from "../src/rules/snapshot";
import { createTestBattle, scriptedRng } from "./helpers";

function battle(hbkExtra: Partial<UnitInit> = {}): BattleState {
  const units: UnitInit[] = [
    { ...buildUnitInit("hbk", "HBK-4G", 0, { col: 2, row: 4 }, "se"), ...hbkExtra },
    buildUnitInit("enf", "ENF-4R", 1, { col: 5, row: 4 }, "nw"),
  ];
  const state = createTestBattle([], units, true);
  rollInitiativePhase(state, scriptedRng(3, 3, 3, 1), []);
  return state;
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
          buildUnitInit("a", "HBK-4G", 0, { col: 1, row: 1 }, "n", 4, 5, bad),
          buildUnitInit("b", "ENF-4R", 1, { col: 3, row: 3 }, "n"),
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
    hbk.unconscious = true;
    expect(pilotStatus(hbk)).toBe("unconscious");
    hbk.pilotHits = 6;
    expect(pilotStatus(hbk)).toBe("dead");
    hbk.removed = "pilotEjected";
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
    expect(rec.targets).toHaveLength(7);
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

  it("pilot killed by ejection damage still reads as ejected with HP 0", () => {
    const state = battle({ pilotHitMax: 1 });
    const hbk = requireUnit(state, "hbk");
    hurtHead(hbk, 1);
    ejectPilot(state, "hbk", scriptedRng(1, 1), []);
    expect(hbk.removed).toBe("pilotEjected");
    expect(pilotStatus(hbk)).toBe("ejected");
    expect(pilotRecord(hbk).hp).toBe(0);
  });

  it("ejectionDamage is floor(margin / 2)", () => {
    expect(ejectionDamage({ target: 5, roll: 2, success: false })).toBe(1);
    expect(ejectionDamage({ target: 5, roll: 4, success: false })).toBe(0);
    expect(ejectionDamage({ target: 7, roll: 2, success: false })).toBe(2);
    expect(ejectionDamage({ target: 5, roll: 9, success: true })).toBe(0);
  });
});
