import { afterEach, describe, expect, it } from "vitest";
import { neighbor } from "../src/core/hex";
import { hexCell, hexEntryCost, setCell } from "../src/core/terrain";
import { hexKey, type Location, type TerrainType } from "../src/core/types";
import { mechDef, registeredMechDefs } from "../src/data/index";
import { setSlotDestroyed } from "../src/rules/critical";
import { applyPilotHits } from "../src/rules/game/consequences";
import { WRECKAGE_TONNAGE_MIN } from "../src/rules/game/constants";
import { buildUnitInit } from "../src/rules/game/create";
import { declareAttacks, passAttack } from "../src/rules/game/declare";
import { killCredit } from "../src/rules/game/ledger";
import { advancePhase } from "../src/rules/game/loop";
import { executeMove } from "../src/rules/game/move";
import { abandonPilot, ejectPilot, voluntaryShutdown } from "../src/rules/game/pilotActions";
import { hasWreckage, isHull, requireUnit, wreckageAt } from "../src/rules/game/queries";
import { resolveAllAttacks } from "../src/rules/game/resolveAttacks";
import { nextActor, rollInitiativePhase } from "../src/rules/game/turnOrder";
import type { BattleState, GameEvent, UnitInit, UnitState } from "../src/rules/game/types";
import { reachableLandings } from "../src/rules/movement";
import { pilotRecord } from "../src/rules/pilot";
import { salvageReport } from "../src/rules/salvage";
import {
  bvSkillMultiplier,
  crippleReasons,
  damagedFraction,
  scoreReport,
  unitScore,
} from "../src/rules/score";
import { loadBattleState, parseBattleState, saveBattleState } from "../src/rules/snapshot";
import { battleModel, boardToText, WRECKAGE_MARKER } from "../web/terminal/renderer.text";
import {
  commitMovement,
  declareMovementMode,
  newSession,
  type Session,
  setConfigLocale,
} from "../web/terminal/session";
import { handleSessionGameEvents } from "../web/terminal/session.common";
import { createTestBattle, critWeapon } from "./helpers/battle";
import { sweepPiloting } from "./helpers/piloting";
import { scriptedRng } from "./helpers/rng";
import { disableCritical, execute } from "./helpers/session";

function hbkVsEnf(critsDisabled = true): BattleState {
  const units: UnitInit[] = [
    buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
    buildUnitInit("enf", "ENF-4R", 2, { col: 5, row: 4 }, "nw"),
  ];
  return createTestBattle([], units, critsDisabled);
}

/** Start the movement phase; by default team 1 (hbk) loses initiative and moves first. */
function movement(state: BattleState, rng = scriptedRng(1, 1, 4, 4)): BattleState {
  rollInitiativePhase(state, rng, []);
  return state;
}

/** Zero the center torso and run the attack -> end destruction sweep. */
function destroyBySweep(
  state: BattleState,
  id: string,
  rng = scriptedRng(1, 3, 4, 3, 3),
): GameEvent[] {
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
    expect(() => abandonPilot(state, "hbk", [])).toThrow(/not the current actor/);
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
    expect(events).toEqual([
      { kind: "unitRemoved", unitId: "hbk", reason: "pilotAbandoned", credit: [] },
    ]);
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
    sweepPiloting(state, scriptedRng(1, 3, 4), before, events);
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
    expect(wreckageAt(state, { col: 2, row: 4 })).toEqual([{ model: "HBK-4G", unitId: "hbk" }]);
    expect(events).toContainEqual({
      kind: "unitRemoved",
      unitId: "hbk",
      reason: "destroyed",
      destroyReason: "centerTorsoDestroyed",
      credit: [],
    });
    expect(events).toContainEqual({ kind: "wreckageLeft", unitId: "hbk", col: 2, row: 4 });
    // It fell standing, but its pilot left turns ago: no fall hit (SALV-07).
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "unitFell", unitId: "hbk", cause: { kind: "salvageFall" } }),
    );
    expect(hbk.pilotHits).toBe(0);
    expect(events.some((e) => e.kind === "pilotDamaged")).toBe(false);
  });

  it("an abandoned hull destroyed standing wounds no one", () => {
    const state = movement(hbkVsEnf());
    requireUnit(state, "hbk").shutdown = "manual";
    abandonPilot(state, "hbk", []);
    const events = destroyBySweep(state, "hbk");
    const hbk = requireUnit(state, "hbk");
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "unitFell", unitId: "hbk", cause: { kind: "salvageFall" } }),
    );
    expect(hbk.pilotHits).toBe(0);
    expect(events.some((e) => e.kind === "pilotDamaged")).toBe(false);
  });

  it("a pilot one hit short of death who ejected survives the hull's destruction", () => {
    const state = movement(hbkVsEnf());
    const hbk = requireUnit(state, "hbk");
    hbk.pilotHits = hbk.pilotHitMax - 1;
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    destroyBySweep(state, "hbk");
    expect(hbk.pilotHits).toBe(hbk.pilotHitMax - 1);
    expect(pilotRecord(hbk).status).toBe("ejected");
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
    destroyBySweep(state, "lct", scriptedRng(1, 3, 4, 3, 3));
    expect(requireUnit(state, "lct").removed).toBe("destroyed");
    expect(state.wreckage).toEqual({});
  });

  it("a standing 'Mech takes the salvage fall on its record (TW p.128)", () => {
    const state = movement(hbkVsEnf());
    // Fall direction 1 (front), one 5-point group at 3+3 (right torso),
    // then the pilot's consciousness roll 3+3 (SALV-09).
    const events = destroyBySweep(state, "enf", scriptedRng(1, 3, 3, 3, 3));
    const enf = requireUnit(state, "enf");
    expect(enf.prone).toBe(true);
    expect(enf.damage.armor.rightTorso).toBe(mechDef("ENF-4R")!.armor.rightTorso - 5);
    // The MechWarrior stayed inside a CT kill and takes the fall's hit.
    expect(enf.pilotHits).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "unitFell", unitId: "enf", cause: { kind: "salvageFall" } }),
    );
  });

  it("the fall's pilot hit forces a consciousness roll (TW p.41-42, SALV-09)", () => {
    const pass = movement(hbkVsEnf());
    requireUnit(pass, "enf").pilotHits = 3;
    // Fall 1, 3+3; then 5+5 against TN 10 at 4 hits: stays awake.
    const passEvents = destroyBySweep(pass, "enf", scriptedRng(1, 3, 3, 5, 5));
    const enf = requireUnit(pass, "enf");
    expect(enf.pilotHits).toBe(4);
    expect(pilotRecord(enf).status).toBe("active");
    expect(passEvents).toContainEqual({
      kind: "consciousnessCheck",
      unitId: "enf",
      cause: "fall",
      rolls: [{ roll: 10, target: 10, hits: 4 }],
      required: 1,
      failedAt: null,
      success: true,
      consciousBefore: true,
    });

    const fail = movement(hbkVsEnf());
    requireUnit(fail, "enf").pilotHits = 3;
    // 4+5 = 9 misses TN 10: knocked out on the record.
    const failEvents = destroyBySweep(fail, "enf", scriptedRng(1, 3, 3, 4, 5));
    expect(pilotRecord(requireUnit(fail, "enf")).status).toBe("unconscious");
    expect(failEvents).toContainEqual(
      expect.objectContaining({
        kind: "consciousnessCheck",
        unitId: "enf",
        success: false,
        failedAt: 1,
      }),
    );
  });

  it("a fall hit that kills the pilot takes no consciousness roll", () => {
    const state = movement(hbkVsEnf());
    const enf = requireUnit(state, "enf");
    enf.pilotHits = enf.pilotHitMax - 1;
    const rng = scriptedRng(1, 3, 3);
    const events = destroyBySweep(state, "enf", rng);
    expect(rng.remaining()).toBe(0);
    expect(pilotRecord(enf).status).toBe("dead");
    expect(events.some((e) => e.kind === "consciousnessCheck")).toBe(false);
  });

  it("an unconscious pilot rolls no more for the fall", () => {
    const state = movement(hbkVsEnf());
    const enf = requireUnit(state, "enf");
    enf.pilotHits = 1;
    enf.unconsciousSinceTurn = state.turn;
    const rng = scriptedRng(1, 3, 3);
    const events = destroyBySweep(state, "enf", rng);
    expect(rng.remaining()).toBe(0);
    expect(enf.pilotHits).toBe(2);
    expect(events.some((e) => e.kind === "consciousnessCheck")).toBe(false);
  });

  it("a prone 'Mech takes no salvage fall", () => {
    const state = movement(hbkVsEnf());
    requireUnit(state, "enf").prone = true;
    const events = destroyBySweep(state, "enf", scriptedRng());
    expect(events.some((e) => e.kind === "unitFell")).toBe(false);
    expect(wreckageAt(state, { col: 5, row: 4 })).toEqual([{ model: "ENF-4R", unitId: "enf" }]);
  });

  it("is Rough stacked on the terrain: +1 MP, no repeat, nothing in a standing building", () => {
    const state = hbkVsEnf();
    const hex = { col: 3, row: 3 };
    state.wreckage["3,3"] = [{ model: "X", unitId: "x" }];
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
    state.wreckage["3,3"] = [
      { model: "X", unitId: "x" },
      { model: "Y", unitId: "y" },
    ];
    expect(cost("clear")).toBe(2);
  });

  it("charges the extra MP on the move and in the reachable map", () => {
    const state = movement(hbkVsEnf(), scriptedRng(3, 3, 3, 1));
    const enf = requireUnit(state, "enf");
    const ahead = neighbor(enf.position, "nw");
    state.wreckage[hexKey(ahead)] = [{ model: "X", unitId: "x" }];
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
    destroyBySweep(state, "enf", scriptedRng(1, 3, 4, 3, 3));
    const snap = saveBattleState(state);
    state.wreckage["5,4"]!.push({ model: "X", unitId: "bogus" });
    loadBattleState(state, snap);
    expect(state.wreckage).toEqual({ "5,4": [{ model: "ENF-4R", unitId: "enf" }] });
  });
});

describe("salvageReport", () => {
  it("lists hulls and destroyed frames with what is left", () => {
    const state = movement(hbkVsEnf());
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    destroyBySweep(state, "enf", scriptedRng(1, 3, 4, 3, 3));
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

describe("salvageReport: intact weapons and equipment", () => {
  it("lists frame and unclaimed severed-limb contents, skipping lost ones", () => {
    const state = movement(hbkVsEnf());
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    const hbk = requireUnit(state, "hbk");
    // Left arm severed and left lying; right arm severed and picked up.
    hbk.blownOffLimbs.push({ limb: "leftArm", salvageable: true });
    hbk.blownOffLimbs.push({ limb: "rightArm", salvageable: false });
    hbk.damage = {
      ...hbk.damage,
      internalStructure: { ...hbk.damage.internalStructure, leftArm: 0, rightArm: 0, head: 0 },
    };
    hbk.critSlotsDestroyed = { ...hbk.critSlotsDestroyed, rightTorso: 1 }; // AC/20 slot 1
    const items = salvageReport(state)[0]!.salvageable;
    const weapons = items.filter((i) => i.kind === "weapon");
    expect(weapons).toEqual([
      { kind: "weapon", name: "Medium Laser", location: "leftArm", severed: true, count: 1 },
    ]);
    const equipment = items.filter((i) => i.kind === "equipment");
    expect(equipment.every((i) => !i.severed && i.location !== "head")).toBe(true);
  });

  it("counts every intact weapon on an undamaged hull", () => {
    const state = movement(hbkVsEnf());
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    const weapons = salvageReport(state)[0]!.salvageable.filter((i) => i.kind === "weapon");
    expect(weapons.map((w) => [w.location, w.name, w.count])).toEqual([
      ["leftArm", "Medium Laser", 1],
      ["rightArm", "Medium Laser", 1],
      ["head", "Small Laser", 1],
      ["rightTorso", "AC/20", 1],
    ]);
  });
});

describe("board rendering", () => {
  it("draws a hull as -id and marks wreckage hexes", () => {
    const state = movement(hbkVsEnf());
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    state.wreckage["4,4"] = [{ model: "X", unitId: "x" }];
    const model = battleModel(state);
    expect(model.cells["2,4"]).toBe("-hbk");
    expect(model.cells["5,4"]).toBe("enf");
    expect(model.wreckage).toEqual({ "4,4": true });
    expect(boardToText(model)).toContain(WRECKAGE_MARKER);
  });
});

describe("score", () => {
  function duel(): BattleState {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
      buildUnitInit("cda", "CDA-3MA", 2, { col: 5, row: 4 }, "nw"),
    ];
    return createTestBattle([], units, true);
  }

  function teamScore(state: BattleState, team: number): number {
    return scoreReport(state).find((t) => t.team === team)!.score;
  }

  /** Strip `points` of front armor from `loc`. */
  function hitArmor(unit: UnitState, loc: Location, points: number): void {
    unit.damage.armor[loc] -= points;
  }

  function destroyLocation(unit: UnitState, loc: Location): void {
    unit.damage.armor[loc] = 0;
    unit.damage.internalStructure[loc] = 0;
  }

  /** Flag the first `n` slots of a named structure component. */
  function critStructure(unit: UnitState, name: string, n: number): void {
    const def = mechDef(unit.model)!;
    let left = n;
    for (const loc of Object.keys(def.critSlots) as Location[]) {
      def.critSlots[loc].forEach((s, i) => {
        if (left > 0 && s.kind === "structure" && s.type === name) {
          setSlotDestroyed(unit.critSlotsDestroyed, loc, i);
          left--;
        }
      });
    }
  }

  describe("Battle Value in the catalog", () => {
    it("carries MUL BV onto the built MechDef", () => {
      expect(mechDef("HBK-4G")!.bv).toBe(1041);
      expect(mechDef("CDA-3MA")!.bv).toBe(1158);
      expect(mechDef("AS7-D")!.bv).toBe(1897);
    });

    it("gives every base sheet a BV", () => {
      for (const def of registeredMechDefs()) expect(Number.isInteger(def.bv)).toBe(true);
      expect(mechDef("TBR-Prime")!.bv).toBe(2737);
    });
  });

  describe("bvSkillMultiplier", () => {
    it("rates a regular 4/5 MechWarrior at 1.00", () => {
      expect(bvSkillMultiplier(4, 5)).toBe(1);
      expect(bvSkillMultiplier(3, 5)).toBe(1.2);
      expect(bvSkillMultiplier(2, 3)).toBe(1.68);
    });

    it("clamps skills outside 0..8", () => {
      expect(bvSkillMultiplier(-1, 9)).toBe(bvSkillMultiplier(0, 8));
    });
  });

  describe("scoreReport", () => {
    it("is 0 for both teams before anyone is hit", () => {
      const state = duel();
      expect(scoreReport(state).map((t) => [t.team, t.score])).toEqual([
        [1, 0],
        [2, 0],
      ]);
    });

    it("values a unit at BV × skill multiplier", () => {
      const state = duel();
      state.units.hbk!.gunnery = 3;
      expect(unitScore(state.units.hbk!).value).toBe(Math.round(1041 * 1.2));
    });

    it("counts partial damage at half the damaged fraction", () => {
      const state = duel();
      const cda = state.units.cda!;
      hitArmor(cda, "centerTorso", 10);
      const damaged = damagedFraction(cda);
      expect(damaged).toBeGreaterThan(0);
      const s = unitScore(cda);
      expect(s.crippled).toEqual([]);
      expect(s.lost).toBeCloseTo(damaged / 2);
      expect(teamScore(state, 1)).toBe(Math.round(2 * 1158 * (damaged / 2)));
      expect(teamScore(state, 2)).toBe(Math.round(-1158 * (damaged / 2)));
    });

    it("counts a crippled unit as half lost", () => {
      const state = duel();
      const cda = state.units.cda!;
      destroyLocation(cda, "leftTorso");
      expect(crippleReasons(cda)).toContain("sideTorsoDestroyed");
      expect(unitScore(cda).lost).toBe(0.5);
      expect(teamScore(state, 1)).toBe(1158);
    });

    it("counts a destroyed unit and a hull as fully lost, and own losses once", () => {
      const state = duel();
      const cda = state.units.cda!;
      cda.removed = "destroyed";
      cda.destroyed = "centerTorsoDestroyed";
      expect(teamScore(state, 1)).toBe(2 * 1158);
      expect(teamScore(state, 2)).toBe(-1158);

      const hull = duel();
      hull.units.cda!.removed = "pilotEjected";
      expect(teamScore(hull, 1)).toBe(2 * 1158);
    });

    it("does not change when a hull is later destroyed", () => {
      const state = duel();
      const cda = state.units.cda!;
      cda.removed = "pilotKilled";
      const before = teamScore(state, 1);
      cda.destroyed = "centerTorsoDestroyed";
      expect(teamScore(state, 1)).toBe(before);
    });

    it("is never more than half for armor damage alone", () => {
      const state = duel();
      const cda = state.units.cda!;
      const def = mechDef("CDA-3MA")!;
      for (const loc of Object.keys(def.armor) as Location[]) cda.damage.armor[loc] = 0;
      for (const loc of ["leftTorso", "centerTorso", "rightTorso"] as const) {
        cda.damage.armorRear[loc] = 0;
      }
      expect(unitScore(cda).lost).toBeLessThanOrEqual(0.5);
    });
  });

  describe("crippleReasons", () => {
    it("flags engine and gyro hits", () => {
      const two = duel().units.hbk!;
      critStructure(two, "engine", 2);
      expect(crippleReasons(two)).toContain("engineHits");
      const mixed = duel().units.hbk!;
      critStructure(mixed, "engine", 1);
      critStructure(mixed, "gyro", 1);
      expect(crippleReasons(mixed)).toContain("gyroAndEngineHits");
      const one = duel().units.hbk!;
      critStructure(one, "engine", 1);
      expect(crippleReasons(one)).toEqual([]);
    });

    it("flags lost sensors and four pilot hits", () => {
      const blind = duel().units.hbk!;
      critStructure(blind, "sensors", 2);
      expect(crippleReasons(blind)).toContain("sensorsLost");
      const hurt = duel().units.hbk!;
      hurt.pilotHits = 4;
      expect(crippleReasons(hurt)).toEqual(["pilotHits"]);
      hurt.pilotHits = 3;
      expect(crippleReasons(hurt)).toEqual([]);
    });

    it("flags structure damage in three limbs", () => {
      const u = duel().units.hbk!;
      for (const loc of ["leftArm", "rightArm"] as const) u.damage.internalStructure[loc] -= 1;
      expect(crippleReasons(u)).toEqual([]);
      u.damage.internalStructure.leftLeg -= 1;
      expect(crippleReasons(u)).toContain("limbStructureDamage");
    });

    it("counts torso structure damage only once its front armor is gone", () => {
      const u = duel().units.hbk!;
      u.damage.internalStructure.centerTorso -= 1;
      u.damage.internalStructure.rightTorso -= 1;
      expect(crippleReasons(u)).toEqual([]);
      u.damage.armor.centerTorso = 0;
      u.damage.armor.rightTorso = 0;
      expect(crippleReasons(u)).toContain("torsoStructureDamage");
    });

    it("flags a unit whose weapons are all destroyed", () => {
      const u = duel().units.hbk!;
      const def = mechDef("HBK-4G")!;
      const keys = Object.keys(def.weapons).map(Number);
      for (const k of keys.slice(1)) critWeapon(u, k);
      expect(crippleReasons(u)).toEqual([]);
      critWeapon(u, keys[0]!);
      expect(crippleReasons(u)).toEqual(["allWeaponsLost"]);
    });

    it("flags a gun with no ammo left as lost", () => {
      const u = duel().units.hbk!;
      const def = mechDef("HBK-4G")!;
      for (const [k, m] of Object.entries(def.weapons)) {
        if (m.weapon !== "AC/20") critWeapon(u, Number(k));
      }
      expect(crippleReasons(u)).toEqual([]);
      for (const id of Object.keys(u.ammoBins)) u.ammoBins[id as keyof typeof u.ammoBins] = 0;
      expect(crippleReasons(u)).toEqual(["allWeaponsLost"]);
    });
  });
});

describe("kill-credit", () => {
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
});

describe("salvage-cmd", () => {
  function started(): Session {
    const s = newSession(42);
    execute(s, "map quickstart");
    execute(s, "add a HBK-4G 5 5 n");
    execute(s, "add b HBK-4G 6 5 s");
    execute(s, "start");
    disableCritical(s);
    return s;
  }

  /** Eject whoever moves until the battle ends (bounded). */
  function driveToOver(s: Session): void {
    let guard = 0;
    while (s.state === "battle") {
      if (++guard > 200) throw new Error("driveToOver did not finish");
      if (s.battle!.phase === "movement") {
        declareMovementMode(s, "eject");
        commitMovement(s);
      } else {
        execute(s, "done");
      }
    }
  }

  function over(): Session {
    const s = started();
    driveToOver(s);
    expect(s.state).toBe("over");
    return s;
  }

  /** Ids of the units that left play, and those still operational. */
  function split(s: Session): { gone: string[]; operational: string[] } {
    const units = Object.values(s.battle!.units);
    return {
      gone: units.filter((u) => u.removed !== "not").map((u) => u.id),
      operational: units.filter((u) => u.removed === "not").map((u) => u.id),
    };
  }

  afterEach(() => setConfigLocale("en"));

  describe("salvage command", () => {
    it("is not available before the battle is over", () => {
      const s = started();
      expect(execute(s, "salvage")).toEqual([
        "error: 'salvage' is not available in this phase (try 'help salvage' to read about it)",
      ]);
      const setup = newSession(1);
      expect(execute(setup, "salvage")[0]).toContain("not available in this phase");
      expect(execute(setup, "help salvage")[0]).toBe("usage: salvage [id]");
    });

    it("lists every ejected hull in the roster table", () => {
      const s = over();
      const { gone } = split(s);
      expect(gone.length).toBeGreaterThan(0);
      const out = execute(s, "salvage");
      expect(out[0]).toBe(`salvage (${gone.length}):`);
      for (const id of gone) {
        expect(
          out.some((l) => l.includes(id) && l.includes("hull") && l.includes("pilot ejected")),
        ).toBe(true);
      }
      expect(out.some((l) => l.includes("salvageables"))).toBe(false);
    });

    it("shows a hull's salvageables beside its armor diagram", () => {
      const s = over();
      const { gone, operational } = split(s);
      const id = gone[0]!;
      const unit = s.battle!.units[id]!;
      const out = execute(s, `salvage ${id}`);
      expect(out[0]).toBe(
        `${id} HBK-4G (team ${unit.team}) - hull, pilot ejected, ${unit.position.col},${unit.position.row} standing`,
      );
      expect(out.some((l) => l.includes("salvageables") && l.includes("salvaged hull"))).toBe(true);
      expect(out.some((l) => l.includes("weapons & equipment:") && l.includes("[ HD ]"))).toBe(
        true,
      );
      expect(out.some((l) => l.includes("  RT: AC/20"))).toBe(true);
      expect(out.some((l) => l.includes("stranded ammo: none"))).toBe(true);
      expect(out.some((l) => l.includes("[ RT ] [ CT ] [ LT ]"))).toBe(true);
      expect(out.some((l) => l.startsWith("salvage ("))).toBe(false);
      expect(execute(s, "salvage nosuch")).toEqual(["error: Unknown unit id: nosuch"]);
      for (const other of operational) {
        expect(execute(s, `salvage ${other}`)).toEqual([
          `error: '${other}' left nothing to salvage`,
        ]);
      }
    });

    it("shows wreckage with the salvageables column only", () => {
      const s = over();
      const unit = s.battle!.units[split(s).gone[0]!]!;
      unit.removed = "destroyed";
      unit.destroyed = "centerTorsoDestroyed";
      unit.prone = true;
      unit.damage = {
        ...unit.damage,
        internalStructure: { ...unit.damage.internalStructure, centerTorso: 0 },
      };
      unit.blownOffLimbs.push({ limb: "leftArm", salvageable: true });
      unit.damage.internalStructure.leftArm = 0;
      const out = execute(s, `salvage ${unit.id}`);
      expect(out[0]).toBe(
        `${unit.id} HBK-4G (team ${unit.team}) - wreckage, CT destroyed, ${unit.position.col},${unit.position.row} prone`,
      );
      expect(out.some((l) => l.includes("salvageables"))).toBe(true);
      expect(out.some((l) => l.includes("salvaged hull") || l.includes("[ HD ]"))).toBe(false);
      expect(out.some((l) => l.includes("  LA (severed): Medium Laser"))).toBe(true);
      const row = execute(s, "salvage").find(
        (l) => l.includes(unit.id) && l.includes("CT destroyed"),
      );
      expect(row).toContain("yes");
    });

    it("speaks Korean after lang ko", () => {
      const s = over();
      execute(s, "lang ko");
      expect(execute(s, "salvage")[0]).toMatch(/^회수 목록 \(\d+\):$/);
      const out = execute(s, `salvage ${split(s).gone[0]!}`);
      expect(out[0]).toContain("기체");
      expect(out.some((l) => l.includes("회수 가능") && l.includes("회수 기체"))).toBe(true);
      expect(out.some((l) => l.includes("무기 및 장비:"))).toBe(true);
    });
  });
});
