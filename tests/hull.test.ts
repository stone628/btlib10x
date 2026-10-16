import { describe, expect, it } from "vitest";
import { neighbor } from "../src/core/hex";
import { hexCell, hexEntryCost, setCell } from "../src/core/terrain";
import { hexKey, type TerrainType } from "../src/core/types";
import { mechDef } from "../src/data/index";
import type { BattleState, GameEvent, UnitInit } from "../src/rules/game";
import {
  abandonPilot,
  advancePhase,
  applyPilotHits,
  buildUnitInit,
  ejectPilot,
  executeMove,
  hasWreckage,
  isHull,
  requireUnit,
  resolvePhasePiloting,
  rollInitiativePhase,
  voluntaryShutdown,
  WRECKAGE_TONNAGE_MIN,
  wreckageAt,
} from "../src/rules/game";
import { reachableLandings } from "../src/rules/movement";
import { salvageReport } from "../src/rules/salvage";
import { loadBattleState, saveBattleState } from "../src/rules/snapshot";
import { battleModel, boardToText, WRECKAGE_MARKER } from "../web/terminal/renderer.text";
import type { Session } from "../web/terminal/session";
import { handleSessionGameEvents } from "../web/terminal/session.common";
import { createTestBattle, scriptedRng } from "./helpers";

function hbkVsEnf(critsDisabled = true): BattleState {
  const units: UnitInit[] = [
    buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
    buildUnitInit("enf", "ENF-4R", 2, { col: 5, row: 4 }, "nw"),
  ];
  return createTestBattle([], units, critsDisabled);
}

function movement(state: BattleState): BattleState {
  rollInitiativePhase(state, scriptedRng(3, 3, 3, 1), []);
  return state;
}

/** Zero the center torso and run the attack -> end destruction sweep. */
function destroyBySweep(state: BattleState, id: string, rng = scriptedRng(1, 3, 4)): GameEvent[] {
  if (state.phase === "movement") advancePhase(state, [], scriptedRng());
  const unit = requireUnit(state, id);
  unit.damage = {
    ...unit.damage,
    internalStructure: { ...unit.damage.internalStructure, centerTorso: 0 },
  };
  const events: GameEvent[] = [];
  advancePhase(state, events, rng);
  return events;
}

describe("voluntary abandonment (house rule, TO:AR p.165)", () => {
  it("needs a 'Mech already shut down", () => {
    const state = movement(hbkVsEnf());
    expect(() => abandonPilot(state, "hbk", [])).toThrow(/shut down/);
  });

  it("an active 'Mech cannot shut down and abandon in one turn", () => {
    const state = movement(hbkVsEnf());
    voluntaryShutdown(state, "hbk", []);
    expect(() => abandonPilot(state, "hbk", [])).toThrow(/already acted/);
  });

  it("the pilot steps out unhurt, no roll; the hull stays standing", () => {
    const state = movement(hbkVsEnf());
    requireUnit(state, "hbk").shutdown = "manual";
    const events: GameEvent[] = [];
    abandonPilot(state, "hbk", events);
    const hbk = requireUnit(state, "hbk");
    expect(hbk.removed).toBe("pilotAbandoned");
    expect(isHull(hbk)).toBe(true);
    expect(hbk.prone).toBe(false);
    expect(hbk.pilotHits).toBe(0);
    expect(state.actedThisPhase).toContain("hbk");
    expect(events).toEqual([{ kind: "unitRemoved", unitId: "hbk", reason: "pilotAbandoned" }]);
  });
});

describe("hull (TO:AR pp.184-185)", () => {
  it("never rolls a PSR: 20+ damage drops it without a roll or a pilot hit (TW p.60)", () => {
    const state = movement(hbkVsEnf());
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    const hbk = requireUnit(state, "hbk");
    const hitsBefore = hbk.pilotHits;
    const before = { damage: { hbk: structuredClone(hbk.damage) }, crit: {} };
    hbk.damage.armor.centerTorso -= 20;
    const events: GameEvent[] = [];
    // Fall: direction 1 (front), one 5-point group at 3+4 (CT).
    resolvePhasePiloting(state, scriptedRng(1, 3, 4), before, events);
    expect(hbk.prone).toBe(true);
    expect(hbk.pilotHits).toBe(hitsBefore);
    expect(events.some((e) => e.kind === "pilotingCheck")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "unitFell", unitId: "hbk", hull: true }),
    );
    // The log says why: no roll, nobody aboard.
    const text = handleSessionGameEvents({} as Session, events)
      .flatMap((c) => (c.kind === "lines" ? [...c.lines] : []))
      .join("\n");
    expect(text).toMatch(/empty hull: no pilot/);
  });

  it("head hits on a hull reach no MechWarrior", () => {
    const state = movement(hbkVsEnf());
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    const hbk = requireUnit(state, "hbk");
    const hits = hbk.pilotHits;
    applyPilotHits(state, hbk, 2, "headHit", scriptedRng(), []);
    expect(hbk.pilotHits).toBe(hits);
  });

  it("destroyed, it becomes wreckage and keeps its removal reason", () => {
    const state = movement(hbkVsEnf());
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    const events = destroyBySweep(state, "hbk");
    const hbk = requireUnit(state, "hbk");
    expect(hbk.removed).toBe("pilotEjected");
    expect(hbk.destroyed).toBe("centerTorsoDestroyed");
    expect(isHull(hbk)).toBe(false);
    expect(wreckageAt(state, { col: 2, row: 4 })).toEqual(["hbk"]);
    expect(events).toContainEqual({
      kind: "unitRemoved",
      unitId: "hbk",
      reason: "destroyed",
      destroyReason: "centerTorsoDestroyed",
    });
    expect(events).toContainEqual({ kind: "wreckageLeft", unitId: "hbk", col: 2, row: 4 });
  });
});

describe("wreckage (TO:AR p.155)", () => {
  it(`only 'Mechs of ${WRECKAGE_TONNAGE_MIN} t or more leave it`, () => {
    const units: UnitInit[] = [
      buildUnitInit("lct", "LCT-1V", 1, { col: 2, row: 4 }, "se"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 5, row: 4 }, "nw"),
    ];
    expect(mechDef("LCT-1V")!.tonnage).toBeLessThan(WRECKAGE_TONNAGE_MIN);
    const state = movement(createTestBattle([], units, true));
    destroyBySweep(state, "lct", scriptedRng(1, 3, 4));
    expect(requireUnit(state, "lct").removed).toBe("destroyed");
    expect(state.wreckage).toEqual({});
  });

  it("a standing 'Mech takes the salvage fall on its record (TW p.128)", () => {
    const state = movement(hbkVsEnf());
    // Fall direction 1 (front), one 5-point group at 3+3 (right torso).
    const events = destroyBySweep(state, "enf", scriptedRng(1, 3, 3));
    const enf = requireUnit(state, "enf");
    expect(enf.prone).toBe(true);
    expect(enf.damage.armor.rightTorso).toBe(mechDef("ENF-4R")!.armor.rightTorso - 5);
    // The MechWarrior stayed inside a CT kill and takes the fall's hit.
    expect(enf.pilotHits).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "unitFell", unitId: "enf", cause: { kind: "salvageFall" } }),
    );
  });

  it("a prone 'Mech takes no salvage fall", () => {
    const state = movement(hbkVsEnf());
    requireUnit(state, "enf").prone = true;
    const events = destroyBySweep(state, "enf", scriptedRng());
    expect(events.some((e) => e.kind === "unitFell")).toBe(false);
    expect(wreckageAt(state, { col: 5, row: 4 })).toEqual(["enf"]);
  });

  it("is Rough stacked on the terrain: +1 MP, no repeat, nothing in a standing building", () => {
    const state = hbkVsEnf();
    const hex = { col: 3, row: 3 };
    state.wreckage["3,3"] = ["x"];
    const cost = (terrain: TerrainType): number => {
      setCell(state, hex, hexCell(terrain));
      return hexEntryCost(state, hex, hasWreckage(state, hex));
    };
    expect(cost("clear")).toBe(2);
    expect(cost("lightWoods")).toBe(3);
    expect(cost("rough")).toBe(2);
    expect(cost("rubble")).toBe(3);
    expect(cost("water1")).toBe(3);
    expect(cost("mediumBuilding")).toBe(3);
    state.wreckage["3,3"] = ["x", "y"];
    expect(cost("clear")).toBe(2);
  });

  it("charges the extra MP on the move and in the reachable map", () => {
    const state = movement(hbkVsEnf());
    const enf = requireUnit(state, "enf");
    const ahead = neighbor(enf.position, "nw");
    state.wreckage[hexKey(ahead)] = ["x"];
    const landing = reachableLandings(enf.position, "nw", {
      mode: "walk",
      walking: 4,
      running: 6,
      jumping: 0,
      prone: false,
      grid: state,
      team: 2,
      occupantTeam: () => undefined,
      wreckageAt: (hex) => hasWreckage(state, hex),
    }).find((l) => l.hex.col === ahead.col && l.hex.row === ahead.row && l.facing === "nw");
    expect(landing?.path.map((p) => p.baseMp)).toEqual([2]);
    executeMove(state, "enf", "walk", [{ kind: "enter", to: ahead }], [], {
      rng: scriptedRng(),
    });
    expect(enf.mpSpent).toBe(2);
  });

  it("round-trips through snapshots", () => {
    const state = movement(hbkVsEnf());
    destroyBySweep(state, "enf", scriptedRng(1, 3, 4));
    const snap = saveBattleState(state);
    state.wreckage["5,4"]!.push("bogus");
    loadBattleState(state, snap);
    expect(state.wreckage).toEqual({ "5,4": ["enf"] });
  });
});

describe("salvageReport", () => {
  it("lists hulls and destroyed frames with what is left", () => {
    const state = movement(hbkVsEnf());
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    destroyBySweep(state, "enf", scriptedRng(1, 3, 4));
    const report = salvageReport(state);
    expect(report.map((r) => [r.unitId, r.kind, r.reason, r.destroyReason])).toEqual([
      ["hbk", "hull", "pilotEjected", null],
      ["enf", "wreckage", "destroyed", "centerTorsoDestroyed"],
    ]);
    const enf = report[1]!;
    expect(enf.leftWreckage).toBe(true);
    expect(enf.prone).toBe(true);
    expect(enf.hex).toEqual({ col: 5, row: 4 });
    expect(enf.damage.internalStructure.centerTorso).toBe(0);
    expect(report[0]!.leftWreckage).toBe(false);
  });
});

describe("board rendering", () => {
  it("draws a hull as -id and marks wreckage hexes", () => {
    const state = movement(hbkVsEnf());
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    state.wreckage["4,4"] = ["x"];
    const model = battleModel(state);
    expect(model.cells["2,4"]).toBe("-hbk");
    expect(model.cells["5,4"]).toBe("enf");
    expect(model.wreckage).toEqual({ "4,4": true });
    expect(boardToText(model)).toContain(WRECKAGE_MARKER);
  });
});
