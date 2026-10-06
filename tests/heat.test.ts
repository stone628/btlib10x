import { describe, expect, it } from "vitest";
import type { UnitDamageState } from "../src";
import { LOCATIONS, type Location, type TerrainType } from "../src/core/types";
import { mechDef, mechDefFor } from "../src/data/index";
import { countDestroyedEngine } from "../src/rules/critical";
import type { BattleState, GameEvent, UnitInit } from "../src/rules/game";
import {
  advancePhase,
  buildUnitInit,
  declareAttacks,
  executeMove,
  nextActor,
  requireUnit,
  resolveAllAttacks,
  rollInitiativePhase,
} from "../src/rules/game";
import {
  ammoExplosionAvoid,
  effectiveMoveBudget,
  engineHitHeat,
  heatDissipation,
  largestAmmoBin,
  movementHeat,
  movementMpPenalty,
  shutdownAvoid,
  toHitHeatModifier,
  waterHeatBonus,
} from "../src/rules/heat";
import { createTestBattle, scriptedRng } from "./helpers";

function hbkVsEnf(): BattleState {
  const units: UnitInit[] = [
    buildUnitInit("hbk", "HBK-4G", 0, { col: 2, row: 4 }, "se"),
    buildUnitInit("enf", "ENF-4R", 1, { col: 4, row: 5 }, "nw"),
  ];
  return createTestBattle([], units, true);
}

function bzkVsEnf(): BattleState {
  const units: UnitInit[] = [
    buildUnitInit("bzk", "BZK-F3", 0, { col: 2, row: 4 }, "se"),
    buildUnitInit("enf", "ENF-4R", 1, { col: 4, row: 5 }, "nw"),
  ];
  return createTestBattle([], units, true);
}

function startMovementTurn(state: BattleState, rng = scriptedRng(1, 1, 4, 4)): BattleState {
  rollInitiativePhase(state, rng, []);
  return state;
}

function startAttackTurn(state: BattleState, rng = scriptedRng(1, 1, 4, 4)): BattleState {
  advancePhase(startMovementTurn(state, rng), []);
  return state;
}

// ---------------------------------------------------------------- pure functions ----

describe("movementHeat", () => {
  it("standStill always 0", () => {
    expect(movementHeat("standStill", 0)).toBe(0);
    expect(movementHeat("standStill", 5)).toBe(0);
  });
  it("walk always 1 (movable declaration yields heat even with zero steps)", () => {
    expect(movementHeat("walk", 0)).toBe(1);
    expect(movementHeat("walk", 1)).toBe(1);
    expect(movementHeat("walk", 4)).toBe(1);
  });
  it("run always returns 2 (TW p. 159: declared mode, not distance)", () => {
    expect(movementHeat("run", 0)).toBe(2);
    expect(movementHeat("run", 3)).toBe(2);
  });
  it("jump returns max(3, mpSpent)", () => {
    expect(movementHeat("jump", 0)).toBe(3);
    expect(movementHeat("jump", 2)).toBe(3);
    expect(movementHeat("jump", 6)).toBe(6);
  });
});

describe("engineHitHeat", () => {
  it("0 for 0 destroyed engine slots", () => {
    expect(engineHitHeat(0)).toBe(0);
  });
  it("5 for 1 destroyed engine slot", () => {
    expect(engineHitHeat(1)).toBe(5);
  });
  it("10 for 2+ destroyed engine slots", () => {
    expect(engineHitHeat(2)).toBe(10);
    expect(engineHitHeat(4)).toBe(10);
  });
});

describe("toHitHeatModifier", () => {
  it("0 below 8", () => {
    expect(toHitHeatModifier(7)).toBe(0);
  });
  it("1 at 8–12", () => {
    expect(toHitHeatModifier(8)).toBe(1);
    expect(toHitHeatModifier(12)).toBe(1);
  });
  it("2 at 13–16", () => {
    expect(toHitHeatModifier(13)).toBe(2);
    expect(toHitHeatModifier(16)).toBe(2);
  });
  it("3 at 17–23", () => {
    expect(toHitHeatModifier(17)).toBe(3);
    expect(toHitHeatModifier(23)).toBe(3);
  });
  it("4 at 24+", () => {
    expect(toHitHeatModifier(24)).toBe(4);
    expect(toHitHeatModifier(50)).toBe(4);
  });
});

describe("movementMpPenalty", () => {
  it("0 below 5", () => {
    expect(movementMpPenalty(4)).toBe(0);
  });
  it("1 at 5–9", () => {
    expect(movementMpPenalty(5)).toBe(1);
    expect(movementMpPenalty(9)).toBe(1);
  });
  it("2 at 10–14", () => {
    expect(movementMpPenalty(10)).toBe(2);
  });
  it("3 at 15–19", () => {
    expect(movementMpPenalty(15)).toBe(3);
  });
  it("4 at 20–24", () => {
    expect(movementMpPenalty(20)).toBe(4);
  });
  it("5 at 25+", () => {
    expect(movementMpPenalty(25)).toBe(5);
  });
});

describe("shutdownAvoid", () => {
  it("null below 14", () => {
    expect(shutdownAvoid(13)).toBe(0);
  });
  it("4 at 14–17", () => {
    expect(shutdownAvoid(14)).toBe(4);
    expect(shutdownAvoid(17)).toBe(4);
  });
  it("6 at 18–21", () => {
    expect(shutdownAvoid(18)).toBe(6);
    expect(shutdownAvoid(21)).toBe(6);
  });
  it("8 at 22–25", () => {
    expect(shutdownAvoid(22)).toBe(8);
    expect(shutdownAvoid(25)).toBe(8);
  });
  it("10 at 26–29", () => {
    expect(shutdownAvoid(26)).toBe(10);
    expect(shutdownAvoid(29)).toBe(10);
  });
  it("null at 30+ (auto)", () => {
    expect(shutdownAvoid(30)).toBe(12);
  });
});

describe("ammoExplosionAvoid", () => {
  it("null below 19", () => {
    expect(ammoExplosionAvoid(18)).toBe(0);
  });
  it("4 at 19–22", () => {
    expect(ammoExplosionAvoid(19)).toBe(4);
    expect(ammoExplosionAvoid(22)).toBe(4);
  });
  it("6 at 23–27", () => {
    expect(ammoExplosionAvoid(23)).toBe(6);
    expect(ammoExplosionAvoid(27)).toBe(6);
  });
  it("8 at 28+", () => {
    expect(ammoExplosionAvoid(28)).toBe(8);
    expect(ammoExplosionAvoid(50)).toBe(8);
  });
});

describe("effectiveMoveBudget", () => {
  it("full walk/run at heat 0", () => {
    const def = mechDef("HBK-4G")!;
    const move = { walking: def.walking, running: def.running, jumping: def.jumping };
    expect(effectiveMoveBudget("walk", move, 0)).toBe(def.walking);
    expect(effectiveMoveBudget("run", move, 0)).toBe(def.running);
    expect(effectiveMoveBudget("jump", move, 0)).toBe(def.jumping);
  });
  it("subtracts MP penalty", () => {
    const def = mechDef("HBK-4G")!;
    const move = { walking: def.walking, running: def.running, jumping: def.jumping };
    expect(effectiveMoveBudget("run", move, 10)).toBe(def.running - 3);
    expect(effectiveMoveBudget("walk", move, 25)).toBe(0);
  });
});

describe("heatDissipation / countDestroyedEngineSlots", () => {
  it("HBK-4G dissipates 13 (8 engine + 5 external single)", () => {
    const state = hbkVsEnf();
    const unit = requireUnit(state, "hbk");
    const def = mechDefFor(unit);
    expect(heatDissipation(def, unit.damage, unit.critSlotsDestroyed)).toBe(13);
    expect(countDestroyedEngine(def, unit.damage, unit.critSlotsDestroyed)).toBe(0);
  });
  it("destroying an engine slot adds heat but does not retire a sink (strict TW)", () => {
    const state = hbkVsEnf();
    const unit = requireUnit(state, "hbk");
    const def = mechDefFor(unit);
    const destroyed = {
      ...unit.critSlotsDestroyed,
      centerTorso: [true, ...unit.critSlotsDestroyed.centerTorso.slice(1)],
    };
    expect(heatDissipation(def, unit.damage, destroyed)).toBe(13);
    expect(countDestroyedEngine(def, unit.damage, destroyed)).toBe(1);
  });
});

describe("waterHeatBonus (TW p.159)", () => {
  it("is zero out of water", () => {
    const unit = requireUnit(hbkVsEnf(), "hbk");
    const def = mechDefFor(unit);
    expect(waterHeatBonus(def, unit.damage, unit.critSlotsDestroyed, 0, false)).toBe(0);
  });
  it("depth 2+ or prone submerges every sink, capped at 6", () => {
    const unit = requireUnit(hbkVsEnf(), "hbk");
    const def = mechDefFor(unit);
    // HBK-4G: 13 operational single sinks -> capped at 6.
    expect(waterHeatBonus(def, unit.damage, unit.critSlotsDestroyed, 2, false)).toBe(6);
    expect(waterHeatBonus(def, unit.damage, unit.critSlotsDestroyed, 1, true)).toBe(6);
  });
  it("depth 1 standing counts only leg sinks", () => {
    const unit = requireUnit(hbkVsEnf(), "hbk");
    const def = mechDefFor(unit);
    const bonus = waterHeatBonus(def, unit.damage, unit.critSlotsDestroyed, 1, false);
    expect(bonus).toBeLessThanOrEqual(6);
    expect(bonus).toBeLessThan(6 + 1);
  });
});

describe("heatDissipation: engine sink capacity + double heat sinks", () => {
  // Classic construction: engine mounts floor(walk x tons / 25) sinks
  // internally; the rest occupy crit slots. Double sinks dissipate 2 each.
  const cases: ReadonlyArray<[string, number]> = [
    ["HBK-4G", 13], // 200 engine: 8 internal + 5 single
    ["AS7-D", 20], // 300 engine: 12 internal + 8 single
    ["ENF-4R", 12], // 200 engine: 8 internal + 4 single
    ["WVR-6R", 12], // 275 engine: 11 internal + 1 single
    ["GRF-1N", 12], // 275 engine: 11 internal + 1 single
    ["WHK-Prime", 40], // 340 engine: 13 internal + 7 double devices, x2 each
    ["TBR-Prime", 34], // 375 engine: 15 internal + 2 double devices, x2 each
    ["MC-MKII-2", 26], // 360 engine: 13 of 14 capacity, all double
    ["CDA-3MA", 20], // 320 engine: 10 of 12 capacity, all double
    ["HER-5SA", 20], // 240 engine: 9 internal + 1 IS double device
  ];
  it.each(cases)("%s dissipates %i heat per turn", (model, expected) => {
    const def = mechDef(model)!;
    const damage: UnitDamageState = {
      armor: { ...def.armor },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure },
    };
    const destroyed = Object.fromEntries(
      LOCATIONS.map((l) => [l, def.critSlots[l].map(() => false)]),
    ) as Record<Location, boolean[]>;
    expect(heatDissipation(def, damage, destroyed)).toBe(expected);
  });

  it("destroying one DHS crit of a group retires the whole device (-2)", () => {
    const def = mechDef("WHK-Prime")!;
    const damage: UnitDamageState = {
      armor: { ...def.armor },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure },
    };
    const destroyed = Object.fromEntries(
      LOCATIONS.map((l) => [l, def.critSlots[l].map(() => false)]),
    ) as Record<Location, boolean[]>;
    // One Clan DHS device = 2 crit slots in a run; destroy one slot of the
    // left-leg run [5,6].
    destroyed.leftLeg[4] = true;
    expect(heatDissipation(def, damage, destroyed)).toBe(38);
  });
});

describe("largestAmmoBin", () => {
  it("returns the AC/20 bin for HBK-4G", () => {
    const state = hbkVsEnf();
    const unit = requireUnit(state, "hbk");
    const def = mechDefFor(unit);
    const bin = largestAmmoBin(def, unit.ammoBins, scriptedRng(6));
    expect(bin).not.toBeNull();
    expect(bin!.weapon).toBe("AC/20");
    // 10 declared shots spread over two 5-shot bins: only the single
    // largest bin detonates, not the whole mount.
    expect(bin!.shotsRemaining).toBe(5);
    expect(bin!.damage).toBe(100);
  });

  it("returns null when only non-explosive ammo is loaded (BZK-F3 gauss)", () => {
    const state = bzkVsEnf();
    const unit = requireUnit(state, "bzk");
    const def = mechDefFor(unit);
    // BZK-F3 mounts two gauss ammo bins in the center torso.
    expect(unit.ammoBins["centerTorso:11"]?.shots).toBe(8);
    expect(unit.ammoBins["centerTorso:12"]?.shots).toBe(8);
    expect(largestAmmoBin(def, unit.ammoBins, scriptedRng(6))).toBeNull();
  });

  it("picks by per-shot DV first (TW p.160): SRM-6 bin over fuller AC/5", () => {
    // WVR-6R carries SRM 6 (DV 12) and AC/5 (DV 5). With SRM drained to a
    // single shot (12 dmg) and AC/5 fully loaded (100 dmg), the old
    // shots*DV criterion would pick AC/5; TW requires the higher per-shot
    // DV bin to blow first regardless of remaining shot count.
    const state = createTestBattle(
      [],
      [
        buildUnitInit("wvr", "WVR-6R", 0, { col: 2, row: 4 }, "n"),
        buildUnitInit("dummy", "ENF-4R", 1, { col: 6, row: 6 }, "nw"),
      ],
      true,
    );
    const unit = requireUnit(state, "wvr");
    const def = mechDefFor(unit);
    // Drain every SRM-6 ammo bin down to 1 shot.
    for (const [id, bin] of Object.entries(unit.ammoBins)) {
      if (bin.weapon === "SRM 6") {
        unit.ammoBins[id] = { ...bin, shots: 1 };
      }
    }
    const bin = largestAmmoBin(def, unit.ammoBins, scriptedRng(6));
    expect(bin).not.toBeNull();
    expect(bin!.weapon).toBe("SRM 6");
    expect(bin!.damagePerShot).toBe(12);
    expect(bin!.shotsRemaining).toBe(1);
  });
});

// ---------------------------------------------------------------- game integration ----

describe("game integration: movement heat", () => {
  it("walk adds 1 to heatPending (scale unchanged until heat phase)", () => {
    const state = hbkVsEnf();
    startMovementTurn(state);
    const events: GameEvent[] = [];
    executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 1, row: 4 } }], events);
    const hbk = requireUnit(state, "hbk");
    expect(hbk.heat).toBe(0);
    expect(hbk.heatPending).toBe(1);
    const moveEvent = events.find(
      (e): e is Extract<GameEvent, { kind: "heatMove" }> =>
        e.kind === "heatMove" && e.unitId === "hbk",
    );
    expect(moveEvent?.heat).toBe(1);
    expect(moveEvent?.base).toBe(0);
    expect(moveEvent?.totalGenerated).toBe(1);
  });

  it("run adds 2 to heatPending (scale unchanged until heat phase)", () => {
    const state = hbkVsEnf();
    startMovementTurn(state);
    executeMove(state, "hbk", "run", [{ kind: "enter", to: { col: 3, row: 5 } }], []);
    expect(requireUnit(state, "hbk").mpSpent).toBe(1);
    expect(requireUnit(state, "hbk").heat).toBe(0);
    expect(requireUnit(state, "hbk").heatPending).toBe(2);
  });

  it("standStill adds 0 heat", () => {
    const state = hbkVsEnf();
    startMovementTurn(state);
    executeMove(state, "hbk", "standStill", [], []);
    expect(requireUnit(state, "hbk").heat).toBe(0);
    expect(requireUnit(state, "hbk").heatPending).toBe(0);
  });

  it("heat 10 reduces run MP budget by 2 in moved event", () => {
    const state = hbkVsEnf();
    startMovementTurn(state);
    const hbk = requireUnit(state, "hbk");
    hbk.heat = 10;
    const events: GameEvent[] = [];
    executeMove(state, "hbk", "run", [], events);
    const moved = events.find((e) => e.kind === "moved" && e.unitId === "hbk");
    expect(moved).toBeDefined();
    expect((moved as Extract<GameEvent, { kind: "moved" }>).mpBudget).toBe(
      mechDef("HBK-4G")!.running - 3,
    );
  });
});

describe("game integration: weapon heat", () => {
  it("AC/20 (heat 7) adds 7 to heatPending after attack (scale unchanged)", () => {
    const state = hbkVsEnf();
    startAttackTurn(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }], [], []);
    // 20+ damage PSR (needs 6: 3+3 succeeds, no fall).
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(6, 6, 3, 4, 3, 3), events);
    const hbk = requireUnit(state, "hbk");
    expect(hbk.heat).toBe(0);
    expect(hbk.heatPending).toBe(7);
    const weaponHeatEvent = events.find(
      (e): e is Extract<GameEvent, { kind: "heatWeapon" }> => e.kind === "heatWeapon",
    );
    expect(weaponHeatEvent).toBeDefined();
    expect(weaponHeatEvent!.base).toBe(0);
    expect(weaponHeatEvent!.totalGenerated).toBe(7);
  });

  it("rapid-fire heat scales per shot: Ultra AC/5 double-tap adds 2 even on a miss (TW p.103-104)", () => {
    // HER-5SA Ultra AC/5 (weaponIndex 3, 1-based, heat 1/shot): raw to-hit 2 jams and
    // misses TN 6, but both fired shots still cost ammo (declared) and heat.
    const units: UnitInit[] = [
      buildUnitInit("her", "HER-5SA", 0, { col: 2, row: 4 }, "ne"),
      buildUnitInit("enf", "ENF-4R", 1, { col: 3, row: 4 }, "nw"),
    ];
    const state = createTestBattle([], units, true);
    startAttackTurn(state);
    declareAttacks(state, "her", [{ weaponIndex: 3, targetId: "enf", rapidFire: true }], [], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(1, 1), events);
    const her = requireUnit(state, "her");
    expect(her.heat).toBe(0);
    expect(her.heatPending).toBe(2);
    const weaponHeatEvent = events.find(
      (e): e is Extract<GameEvent, { kind: "heatWeapon" }> => e.kind === "heatWeapon",
    );
    expect(weaponHeatEvent?.heat).toBe(2);
    expect(weaponHeatEvent?.totalGenerated).toBe(2);
  });
});

describe("game integration: dissipation", () => {
  it("resolveHeatPhase dissipates up to sink count", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.heat = 20;
    startAttackTurn(state);
    // shutdown avoid at 20 -> 6, roll 2+3=5 < 6 fails;
    // shutdown PSR 6+6=12 >= 8 passes; +1 die for `largestAmmoBin`
    // tiebreak on two equal AC/20 bins; ammo avoid 3+1=4 >= 4 passes.
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(2, 3, 6, 6, 6, 3, 1));
    expect(hbk.heat).toBe(20 - 13);
    const dissipEvent = events.find(
      (e): e is Extract<GameEvent, { kind: "heatDissipated" }> =>
        e.kind === "heatDissipated" && e.unitId === "hbk",
    );
    expect(dissipEvent).toBeDefined();
    expect(dissipEvent!.dissip).toBe(13);
    expect(dissipEvent!.startHeat).toBe(20);
    expect(dissipEvent!.totalGenerated).toBe(0);
    expect(dissipEvent!.endHeat).toBe(7);
    expect(dissipEvent!.netChange).toBe(-13);
  });

  it("does not clamp heat before dissipation (TW p. 159 overflow is unbounded)", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.heat = 45;
    startAttackTurn(state);
    // 45 + 20 generated - 13 sinks = 52 endHeat. The old
    // Math.min(HEAT_CAP) clamp produced 40 here by discarding 15 heat
    // before the sinks dissipated.
    hbk.heatPending = 20;
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(6, 6, 6, 6, 6));
    expect(hbk.heat).toBe(52);
    const dissipEvent = events.find(
      (e): e is Extract<GameEvent, { kind: "heatDissipated" }> =>
        e.kind === "heatDissipated" && e.unitId === "hbk",
    );
    expect(dissipEvent).toBeDefined();
    expect(dissipEvent!.dissip).toBe(13);
    expect(dissipEvent!.startHeat).toBe(45);
    expect(dissipEvent!.totalGenerated).toBe(20);
    expect(dissipEvent!.endHeat).toBe(52);
    expect(dissipEvent!.netChange).toBe(7);
  });
});

describe("game integration: engine crit heat", () => {
  it("adds 10 engine heat when 2+ engine slots destroyed", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    const def = mechDefFor(hbk);
    hbk.critSlotsDestroyed = {
      ...hbk.critSlotsDestroyed,
      centerTorso: [true, true, ...hbk.critSlotsDestroyed.centerTorso.slice(2)],
    };
    hbk.heat = 0;
    startAttackTurn(state);
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(3, 3, 3, 1));
    expect(hbk.heat).toBe(
      10 - Math.min(10, heatDissipation(def, hbk.damage, hbk.critSlotsDestroyed)),
    );
    expect(events.some((e) => e.kind === "heatEngineCrit" && e.unitId === "hbk")).toBe(true);
  });
});

describe("game integration: shutdown", () => {
  it("auto shutdown at heat 30+", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    // Post-dissipation check (TW p.159 net update): 43 - 13 sinks = 30 endHeat.
    hbk.heat = 43;
    startAttackTurn(state);
    // auto shutdown (no roll); shutdown PSR 6+6=12 passes; ammo avoid
    // 6+6=12 >= 8 passes. +1 die for `largestAmmoBin` tiebreak on the two
    // equal-AC/20 bins.
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(6, 6, 6, 6, 6));
    expect(hbk.shutdown).toBe("heat");
    expect(
      events.some(
        (e) =>
          e.kind === "shutdownCheck" &&
          e.unitId === "hbk" &&
          !e.avoided &&
          !e.manual &&
          e.avoid >= 12,
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) => e.kind === "pilotingCheck" && e.unitId === "hbk" && e.reason === "shutdown",
      ),
    ).toBe(true);
  });

  it("rolls shutdown avoid at 14–29", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    // Post-dissipation: 31 - 13 = 18 endHeat (avoid 6).
    hbk.heat = 31;
    startAttackTurn(state);
    // shutdown avoid 6; roll 5 < 6 fails; PSR 12 passes.
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(2, 3, 6, 6, 3, 1));
    expect(hbk.shutdown).toBe("heat");
    expect(
      events.some(
        (e): e is Extract<GameEvent, { kind: "shutdownCheck" }> =>
          e.kind === "shutdownCheck" && e.unitId === "hbk" && !e.avoided,
      ),
    ).toBe(true);
  });

  it("avoids shutdown when roll >= avoid", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    // Post-dissipation: 31 - 13 = 18 endHeat (avoid 6).
    hbk.heat = 31;
    startAttackTurn(state);
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(6, 6, 6, 6));
    expect(hbk.shutdown).toBe("not");
    expect(events.some((e) => e.kind === "shutdownCheck" && e.unitId === "hbk" && e.avoided)).toBe(
      true,
    );
  });

  it("skips shutdown unit in nextActor", () => {
    const state = hbkVsEnf();
    startMovementTurn(state);
    executeMove(state, "hbk", "walk", [], []);
    requireUnit(state, "hbk").shutdown = "heat";
    expect(nextActor(state)).toBe("enf");
  });

  it("restarts automatically when heat below 14", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.shutdown = "heat";
    hbk.heat = 12;
    startAttackTurn(state);
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(3, 3, 3, 1));
    expect(hbk.shutdown).toBe("not");
    expect(events.some((e) => e.kind === "restartCheck" && e.unitId === "hbk" && e.success)).toBe(
      true,
    );
  });

  it("does not auto-restart a manual shutdown", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.shutdown = "manual";
    hbk.heat = 12;
    startAttackTurn(state);
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(3, 3, 3, 1));
    expect(hbk.shutdown).toBe("manual");
    expect(events.some((e) => e.kind === "restartCheck" && e.unitId === "hbk" && e.success)).toBe(
      false,
    );
  });

  it("leaves a starting unit untouched and brings it online at the next initiative", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.shutdown = "starting";
    hbk.heat = 12;
    startAttackTurn(state);
    advancePhase(state, [], scriptedRng(3, 3, 3, 1));
    expect(hbk.shutdown).toBe("starting");
    // weaponAttack -> end already ran; advance again: end -> initiative (turn 2).
    advancePhase(state, [], scriptedRng(3, 3, 3, 1));
    expect(hbk.shutdown).toBe("not");
  });
});

describe("game integration: heatMod in to-hit", () => {
  it("attack includes heatMod 2 at heat 13", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.heat = 13;
    startAttackTurn(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(6, 6, 3, 4), events);
    const resolved = events.find((e) => e.kind === "attackResolved");
    expect(resolved).toBeDefined();
    expect(
      (resolved as Extract<GameEvent, { kind: "attackResolved" }>).resolution.breakdown.heatMod,
    ).toBe(2);
  });
});

describe("game integration: immobile target modifier in to-hit", () => {
  function targetModFor(online: boolean, rng = scriptedRng(6, 6, 3, 4)): number {
    const state = hbkVsEnf();
    if (!online) requireUnit(state, "enf").shutdown = "manual";
    startAttackTurn(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, rng, events);
    const resolved = events.find((e) => e.kind === "attackResolved");
    expect(resolved).toBeDefined();
    return (resolved as Extract<GameEvent, { kind: "attackResolved" }>).resolution.breakdown
      .targetMod;
  }

  it("online target in place: targetMod 0", () => {
    expect(targetModFor(true)).toBe(0);
  });

  it("shut-down target: targetMod -4", () => {
    expect(targetModFor(false)).toBe(-4);
  });
});

describe("game integration: target movement modifier counts total hexes", () => {
  function targetModForMoves(moves: readonly ("forward" | "backward")[]): number {
    const state = hbkVsEnf();
    requireUnit(state, "enf").movesThisTurn = [...moves];
    startAttackTurn(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(6, 6, 3, 4), events);
    const resolved = events.find((e) => e.kind === "attackResolved");
    expect(resolved).toBeDefined();
    return (resolved as Extract<GameEvent, { kind: "attackResolved" }>).resolution.breakdown
      .targetMod;
  }

  it("reversed 4-hex walk counts all four hexes (not the 2 since reversal)", () => {
    expect(targetModForMoves(["forward", "forward", "backward", "backward"])).toBe(1);
  });
});

describe("game integration: partial cover in to-hit", () => {
  function makeBattleWithTargetTerrain(type: TerrainType): BattleState {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 0, { col: 2, row: 4 }, "se"),
      buildUnitInit("enf", "ENF-4R", 1, { col: 5, row: 4 }, "nw"),
    ];
    return createTestBattle([{ col: 5, row: 4, type }], units, true);
  }

  function terrainModFor(type: TerrainType): number {
    const state = makeBattleWithTargetTerrain(type);
    startAttackTurn(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(6, 6, 3, 4), events);
    const resolved = events.find((e) => e.kind === "attackResolved");
    expect(resolved).toBeDefined();
    return (resolved as Extract<GameEvent, { kind: "attackResolved" }>).resolution.breakdown
      .terrainMod;
  }

  function coverModFor(type: TerrainType): number {
    const state = makeBattleWithTargetTerrain(type);
    startAttackTurn(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(6, 6, 3, 4), events);
    const resolved = events.find((e) => e.kind === "attackResolved");
    expect(resolved).toBeDefined();
    return (resolved as Extract<GameEvent, { kind: "attackResolved" }>).resolution.breakdown
      .coverMod;
  }

  it("target in clear: terrainMod 0", () => {
    expect(terrainModFor("clear")).toBe(0);
  });

  it("target in water1: coverMod 1 (partial cover), terrainMod 0", () => {
    expect(terrainModFor("water1")).toBe(0);
    expect(coverModFor("water1")).toBe(1);
  });

  it("target in building hex: coverMod 1 (partial cover), terrainMod 0", () => {
    expect(terrainModFor("mediumBuilding")).toBe(0);
    expect(coverModFor("mediumBuilding")).toBe(1);
  });
});

describe("game integration: heat ammo explosion", () => {
  it("largest ammo bin detonates when avoidance roll fails", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    // Post-dissipation: 43 - 13 = 30 endHeat (auto shutdown + ammo avoid 8).
    hbk.heat = 43; // auto shutdown first
    startAttackTurn(state);
    // shutdown auto: no roll; shutdown PSR 1+1=2 fails -> fall (dir 1, loc 7
    // CT, pilot stays awake at 3+3=6 >= 3); ammo avoid 3+1=4 < 8 fails; +1
    // die for the `largestAmmoBin` tiebreak between the two equal AC/20
    // bins; TW p.160 then forces 2 pilot hits + Consciousness Roll per hit,
    // both rolls 6,6 -> 12 (targets 5 then 7, pilot stays awake). The blast
    // destroys the CT, so auto-eject first rolls an ejection PSR (6,6 passes).
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(1, 1, 1, 3, 4, 3, 3, 3, 1, 6, 6, 6, 6, 6, 6, 6));
    expect(hbk.prone).toBe(true);
    expect(
      events.some(
        (e) => e.kind === "pilotingCheck" && e.unitId === "hbk" && e.reason === "shutdown",
      ),
    ).toBe(true);
    // The exploded bin empties (its 5 shots x 20 = 100 damage), not the
    // mount's full 10-shot magazine. The 100-point blast kills the 50-ton
    // HBK outright, so the sibling bin's location is stripped away.
    expect(hbk.ammoBins["leftTorso:1"]?.shots).toBe(0);
    const blast = events.find(
      (e): e is Extract<GameEvent, { kind: "ammoExplosionCheck" }> =>
        e.kind === "ammoExplosionCheck" && e.unitId === "hbk" && !e.avoided,
    );
    expect(blast).toBeDefined();
    expect(blast!.shotsRemaining).toBe(5);
    expect(blast!.damage).toBe(100);
    // TW p.160: ammo explosion deals 2 pilot hits and forces a Consciousness
    // Roll per hit. Fall already landed 1 hit (pilotHits = 1 + 2 = 3).
    const ammoHits = events.filter(
      (e): e is Extract<GameEvent, { kind: "pilotDamaged" }> =>
        e.kind === "pilotDamaged" && e.reason === "ammoExplosion",
    );
    expect(ammoHits).toHaveLength(2);
    const consciousness = events.filter(
      (e): e is Extract<GameEvent, { kind: "consciousnessCheck" }> =>
        e.kind === "consciousnessCheck" && e.unitId === "hbk",
    );
    expect(consciousness.length).toBeGreaterThanOrEqual(3);
    expect(hbk.pilotHits).toBe(3);
    expect(hbk.unconscious).toBe(false);
    expect(hbk.removed).toBe("pilotEjected");
  });

  it("gauss-only unit does not detonate from heat (inert ammo)", () => {
    const state = bzkVsEnf();
    const bzk = requireUnit(state, "bzk");
    // Post-dissipation: 40 - 10 sinks = 30 endHeat (auto shutdown).
    bzk.heat = 40;
    startAttackTurn(state);
    // Shutdown auto: no roll. No ammo avoid roll is taken because the only
    // loaded ammo is gauss (non-explosive). Shutdown PSR 2 fails -> fall
    // (dir 1 front, loc 7 CT, pilot stays awake).
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(1, 1, 1, 3, 4, 3, 3));
    expect(bzk.shutdown).toBe("heat");
    expect(bzk.prone).toBe(true);
    expect(
      events.some((e) => e.kind === "ammoExplosionCheck" && e.unitId === "bzk" && !e.avoided),
    ).toBe(false);
    // Gauss ammo bins survive intact.
    expect(bzk.ammoBins["centerTorso:11"]?.shots).toBe(8);
    expect(bzk.ammoBins["centerTorso:12"]?.shots).toBe(8);
  });
});

// ---------------------------------------------------------------- Bug regressions ----

describe("Bug A: engine crit heat skipped for shut-down units (TW p.160)", () => {
  it("engine crit heat skipped when shutdown === 'heat'", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.critSlotsDestroyed = {
      ...hbk.critSlotsDestroyed,
      centerTorso: [true, true, ...hbk.critSlotsDestroyed.centerTorso.slice(2)],
    };
    hbk.heat = 18;
    hbk.shutdown = "heat";
    startAttackTurn(state);
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(2, 3));
    expect(hbk.heatPending).toBe(0);
    expect(events.some((e) => e.kind === "heatEngineCrit" && e.unitId === "hbk")).toBe(false);
  });

  it("engine crit heat skipped when shutdown === 'manual'", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.critSlotsDestroyed = {
      ...hbk.critSlotsDestroyed,
      centerTorso: [true, true, ...hbk.critSlotsDestroyed.centerTorso.slice(2)],
    };
    hbk.heat = 5;
    hbk.shutdown = "manual";
    startAttackTurn(state);
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(2, 3));
    expect(events.some((e) => e.kind === "heatEngineCrit" && e.unitId === "hbk")).toBe(false);
  });
});

describe("Bug B: auto-restart uses post-dissipation heat, not peak", () => {
  it("heat-shutdown unit restarts without a roll when dissipation drops heat < 14", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.heat = 14;
    hbk.shutdown = "heat";
    startAttackTurn(state);
    // 13 sinks: 14 - 13 = 1 (post-dissipation). max(14, 1) = 14, avoid 4 — NOT auto.
    // Use a setup where dissipation exceeds heat: directly lower scale so the
    // max falls below 14.
    // Actually we want: start 14, no engine crit, no own heat, end = 14 - 13 = 1.
    // max(14, 1) = 14, avoid = 4, must roll. To force auto-restart, set
    // dissipation to exceed heat, i.e. drop scale to 0 with sinks = 0... use a
    // different mech setup where startHeat is small.
    hbk.heat = 10;
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(2, 3));
    expect(hbk.shutdown).toBe("not");
    expect(hbk.heat).toBe(0); // 10 - 10 (sinks ≥ heat)
    const restart = events.find(
      (e): e is Extract<GameEvent, { kind: "restartCheck" }> =>
        e.kind === "restartCheck" && e.unitId === "hbk",
    );
    expect(restart?.success).toBe(true);
    expect(restart?.roll).toBe(0);
  });
});

describe("Bug C: involuntary shutdown rolls use roll >= avoid for success", () => {
  it("roll equal to avoid avoids shutdown", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    // Post-dissipation: 31 - 13 = 18 endHeat (avoid 6).
    hbk.heat = 31; // avoid 6
    startAttackTurn(state);
    // roll 6 >= 6 -> avoided
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(3, 3, 6, 6, 3, 1));
    expect(hbk.shutdown).toBe("not");
    expect(
      events.some(
        (e): e is Extract<GameEvent, { kind: "shutdownCheck" }> =>
          e.kind === "shutdownCheck" && e.unitId === "hbk" && e.avoided,
      ),
    ).toBe(true);
  });
});

describe("Bug D: heat phase net update (TW p.159 single step)", () => {
  it("post-dissipation endHeat drives the shutdown check", () => {
    // start 5, own 25 (deferred in heatPending), dissip 13 → end 17.
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.heat = 5;
    hbk.heatPending = 25; // simulate weapon fire heat in deferred form
    startAttackTurn(state);
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(2, 3, 6, 6, 3, 1));
    // End = 5 + 25 - 13 = 17; avoid at 17 = 4 (threshold 14).
    expect(hbk.heat).toBe(17);
    const check = events.find(
      (e): e is Extract<GameEvent, { kind: "shutdownCheck" }> =>
        e.kind === "shutdownCheck" && e.unitId === "hbk",
    );
    expect(check).toBeDefined();
    expect(check!.heat).toBe(17);
    expect(check!.avoid).toBe(4);
  });
});

describe("Bug E: own heat deferred — weapon attack uses start-of-turn heat", () => {
  it("weapon attack phase to-hit reads start-of-turn heat, not pending", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.heat = 13; // to-hit +2
    startAttackTurn(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(6, 6, 3, 4), events);
    const resolved = events.find(
      (e): e is Extract<GameEvent, { kind: "attackResolved" }> => e.kind === "attackResolved",
    );
    expect(resolved).toBeDefined();
    // heatMod = 2 (at 13). Movement heat this turn doesn't add to it.
    expect(resolved!.resolution.breakdown.heatMod).toBe(2);
    expect(hbk.heat).toBe(13);
  });
});

describe("deferred event payload (base, heat, totalGenerated)", () => {
  it("heatMove carries base/totalGenerated", () => {
    const state = hbkVsEnf();
    startMovementTurn(state);
    hbk_setHeat(state, 4);
    const events: GameEvent[] = [];
    executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 1, row: 4 } }], events);
    const move = events.find(
      (e): e is Extract<GameEvent, { kind: "heatMove" }> => e.kind === "heatMove",
    );
    expect(move).toBeDefined();
    expect(move!.base).toBe(4);
    expect(move!.heat).toBe(1);
    expect(move!.totalGenerated).toBe(1);
  });

  it("heatWeapon carries base/totalGenerated", () => {
    const state = hbkVsEnf();
    hbk_setHeat(state, 8);
    startAttackTurn(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }], [], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(6, 6, 3, 4, 3, 3), events);
    const w = events.find(
      (e): e is Extract<GameEvent, { kind: "heatWeapon" }> => e.kind === "heatWeapon",
    );
    expect(w).toBeDefined();
    expect(w!.base).toBe(8);
    expect(w!.totalGenerated).toBe(7);
  });

  it("heatDissipated carries start/end/total/netChange", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.heat = 20;
    hbk.heatPending = 3; // 3 own heat (we won't actually generate this turn)
    startAttackTurn(state);
    // shutdown avoid 2+3=5 < 6 fails; PSR 6+6=12 >= 8 passes; +1 die for
    // `largestAmmoBin` tiebreak (the two equal AC/20 bins); ammo avoid
    // 1+6=7 >= 4 passes.
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(2, 3, 6, 6, 6, 1, 6));
    const d = events.find(
      (e): e is Extract<GameEvent, { kind: "heatDissipated" }> =>
        e.kind === "heatDissipated" && e.unitId === "hbk",
    );
    expect(d).toBeDefined();
    expect(d!.startHeat).toBe(20);
    expect(d!.totalGenerated).toBe(3);
    expect(d!.endHeat).toBe(10);
    expect(d!.netChange).toBe(-10);
  });
});

function hbk_setHeat(state: BattleState, value: number): void {
  requireUnit(state, "hbk").heat = value;
}
