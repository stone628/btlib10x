import { describe, expect, it } from "vitest";
import { mechDefFor } from "../src/index";
import { setSlotDestroyed } from "../src/rules/critical";
import {
  advancePhase,
  applyPilotHits,
  buildUnitInit,
  declareAttacks,
  type GameEvent,
  requireUnit,
  resolveAllAttacks,
  rollInitiativePhase,
} from "../src/rules/game";
import { sheetIdLine } from "../web/terminal/session.common";
import { createTestBattle, scriptedRng } from "./helpers";

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
      { kind: "unitRemoved", unitId: "enf", reason: "pilotKilled" },
      {
        kind: "unitRemoved",
        unitId: "enf",
        reason: "destroyed",
        destroyReason: "centerTorsoDestroyed",
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
      .map((s, i) => (s.kind === "structure" && s.name === "engine" ? i : -1))
      .filter((i) => i >= 0)
      .slice(0, 3);
    for (const i of engine) setSlotDestroyed(enf.critSlotsDestroyed, "centerTorso", i);
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(1, 3, 3));
    expect(enf.removed).toBe("pilotKilled");
    expect(enf.destroyed).toBe("engineDestroyed");
    expect(removals(events, "enf")).toEqual([
      { kind: "unitRemoved", unitId: "enf", reason: "destroyed", destroyReason: "engineDestroyed" },
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
