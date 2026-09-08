import { describe, expect, it } from "vitest";
import { LOCATIONS, type Location, type TerrainType } from "../src/core/types.js";
import { getMechDef, getMechDefFor } from "../src/data/index.js";
import type { BattleState, UnitInit } from "../src/rules/game.js";
import {
  advancePhase,
  declareAttacks,
  declareMove,
  executeMove,
  getUnit,
  nextActor,
  resolveDeclaredAttacks,
  rollInitiativePhase,
} from "../src/rules/game.js";
import {
  ammoExplosionAvoid,
  countDestroyedEngineSlots,
  effectiveMoveBudget,
  engineHitHeat,
  heatDissipation,
  largestAmmoBin,
  movementHeat,
  movementMpPenalty,
  shutdownAvoid,
  toHitHeatModifier,
} from "../src/rules/heat.js";
import { createTestBattle, scriptedRng } from "./helpers.js";

function hbkVsEnf(): BattleState {
  const units: UnitInit[] = [
    { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 2, row: 4 }, facing: "se" },
    { id: "enf", model: "ENF-4R", team: 1, gunnery: 4, position: { col: 5, row: 4 }, facing: "nw" },
  ];
  return createTestBattle([], units, true);
}

function bzkVsEnf(): BattleState {
  const units: UnitInit[] = [
    { id: "bzk", model: "BZK-F3", team: 0, gunnery: 4, position: { col: 2, row: 4 }, facing: "se" },
    { id: "enf", model: "ENF-4R", team: 1, gunnery: 4, position: { col: 5, row: 4 }, facing: "nw" },
  ];
  return createTestBattle([], units, true);
}

function startMovementTurn(state: BattleState, rng = scriptedRng(3, 3, 3, 1)): BattleState {
  rollInitiativePhase(state, rng);
  return state;
}

function startAttackTurn(state: BattleState, rng = scriptedRng(3, 3, 3, 1)): BattleState {
  advancePhase(startMovementTurn(state, rng));
  return state;
}

// ---------------------------------------------------------------- pure functions ----

describe("movementHeat", () => {
  it("standStill always 0", () => {
    expect(movementHeat("standStill", 0)).toBe(0);
    expect(movementHeat("standStill", 5)).toBe(0);
  });
  it("walk returns 1 if mpSpent>0, else 0", () => {
    expect(movementHeat("walk", 0)).toBe(0);
    expect(movementHeat("walk", 1)).toBe(1);
    expect(movementHeat("walk", 4)).toBe(1);
  });
  it("run returns 2 if mpSpent>0, else 0", () => {
    expect(movementHeat("run", 0)).toBe(0);
    expect(movementHeat("run", 3)).toBe(2);
  });
  it("jump returns max(3, mpSpent)", () => {
    expect(movementHeat("jump", 0)).toBe(0);
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
    const def = getMechDef("HBK-4G")!;
    const move = { walking: def.walking, running: def.running, jumping: def.jumping };
    expect(effectiveMoveBudget("walk", move, 0)).toBe(def.walking);
    expect(effectiveMoveBudget("run", move, 0)).toBe(def.running);
    expect(effectiveMoveBudget("jump", move, 0)).toBe(def.jumping);
  });
  it("subtracts MP penalty", () => {
    const def = getMechDef("HBK-4G")!;
    const move = { walking: def.walking, running: def.running, jumping: def.jumping };
    expect(effectiveMoveBudget("run", move, 10)).toBe(def.running - 2);
    expect(effectiveMoveBudget("walk", move, 25)).toBe(0);
  });
});

describe("heatDissipation / countDestroyedEngineSlots", () => {
  it("HBK-4G dissipates 13 (8 engine + 5 external single)", () => {
    const state = hbkVsEnf();
    const unit = getUnit(state, "hbk");
    const def = getMechDefFor(unit);
    expect(heatDissipation(def, unit.critSlotsDestroyed)).toBe(13);
    expect(countDestroyedEngineSlots(def, unit.critSlotsDestroyed)).toBe(0);
  });
  it("destroying an engine slot adds heat but does not retire a sink (strict TW)", () => {
    const state = hbkVsEnf();
    const unit = getUnit(state, "hbk");
    const def = getMechDefFor(unit);
    const destroyed = {
      ...unit.critSlotsDestroyed,
      centerTorso: [true, ...unit.critSlotsDestroyed.centerTorso.slice(1)],
    };
    expect(heatDissipation(def, destroyed)).toBe(13);
    expect(countDestroyedEngineSlots(def, destroyed)).toBe(1);
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
    ["TW-Prime", 34], // 375 engine: 15 internal + 2 double devices, x2 each
    ["MC-MKII-2", 26], // 360 engine: 13 of 14 capacity, all double
    ["CDA-3MA", 20], // 320 engine: 10 of 12 capacity, all double
    ["HER-5SA", 20], // 240 engine: 9 internal + 1 IS double device
  ];
  it.each(cases)("%s dissipates %i heat per turn", (model, expected) => {
    const def = getMechDef(model)!;
    const destroyed = Object.fromEntries(
      LOCATIONS.map((l) => [l, def.critSlots[l].map(() => false)]),
    ) as Record<Location, boolean[]>;
    expect(heatDissipation(def, destroyed)).toBe(expected);
  });

  it("destroying one DHS crit of a group retires the whole device (-2)", () => {
    const def = getMechDef("WHK-Prime")!;
    const destroyed = Object.fromEntries(
      LOCATIONS.map((l) => [l, def.critSlots[l].map(() => false)]),
    ) as Record<Location, boolean[]>;
    // One Clan DHS device = 2 crit slots in a run; destroy one slot of the
    // left-leg run [5,6].
    destroyed.leftLeg[4] = true;
    expect(heatDissipation(def, destroyed)).toBe(38);
  });
});

describe("largestAmmoBin", () => {
  it("returns the AC/20 bin for HBK-4G", () => {
    const state = hbkVsEnf();
    const unit = getUnit(state, "hbk");
    const def = getMechDefFor(unit);
    const bin = largestAmmoBin(def, unit.ammoBins);
    expect(bin).not.toBeNull();
    expect(bin!.weapon).toBe("AC/20");
    expect(bin!.shotsRemaining).toBe(10);
  });

  it("returns null when only non-explosive ammo is loaded (BZK-F3 gauss)", () => {
    const state = bzkVsEnf();
    const unit = getUnit(state, "bzk");
    const def = getMechDefFor(unit);
    // BZK-F3 mounts two gauss ammo bins in the center torso.
    expect(unit.ammoBins["centerTorso:11"]).toBe(8);
    expect(unit.ammoBins["centerTorso:12"]).toBe(8);
    expect(largestAmmoBin(def, unit.ammoBins)).toBeNull();
  });
});

// ---------------------------------------------------------------- game integration ----

describe("game integration: movement heat", () => {
  it("walk adds 1 heat", () => {
    const state = hbkVsEnf();
    startMovementTurn(state);
    declareMove(state, "hbk", "walk");
    executeMove(state, "hbk", [{ kind: "enter", to: { col: 1, row: 3 } }]);
    const hbk = getUnit(state, "hbk");
    expect(hbk.heat).toBe(1);
    expect(
      state.events.some((e) => e.kind === "heatMove" && e.unitId === "hbk" && e.heat === 1),
    ).toBe(true);
  });

  it("run adds 2 heat", () => {
    const state = hbkVsEnf();
    startMovementTurn(state);
    declareMove(state, "hbk", "run");
    executeMove(state, "hbk", [{ kind: "enter", to: { col: 3, row: 4 } }]);
    expect(getUnit(state, "hbk").mpSpent).toBe(1);
    expect(getUnit(state, "hbk").heat).toBe(2);
  });

  it("standStill adds 0 heat", () => {
    const state = hbkVsEnf();
    startMovementTurn(state);
    declareMove(state, "hbk", "standStill");
    executeMove(state, "hbk", []);
    expect(getUnit(state, "hbk").heat).toBe(0);
  });

  it("heat 10 reduces run MP budget by 2 in moved event", () => {
    const state = hbkVsEnf();
    startMovementTurn(state);
    const hbk = getUnit(state, "hbk");
    hbk.heat = 10;
    declareMove(state, "hbk", "run");
    executeMove(state, "hbk", []);
    const moved = state.events.find((e) => e.kind === "moved" && e.unitId === "hbk");
    expect(moved).toBeDefined();
    expect((moved as Extract<(typeof state.events)[number], { kind: "moved" }>).mpBudget).toBe(
      getMechDef("HBK-4G")!.running - 2,
    );
  });
});

describe("game integration: weapon heat", () => {
  it("AC/20 (heat 7) adds 7 heat after attack", () => {
    const state = hbkVsEnf();
    startAttackTurn(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }]);
    resolveDeclaredAttacks(state, "hbk", scriptedRng(6, 6, 3, 4));
    const hbk = getUnit(state, "hbk");
    expect(hbk.heat).toBe(7);
    const weaponHeatEvent = state.events.find((e) => e.kind === "heatWeapon");
    expect(weaponHeatEvent).toBeDefined();
    expect(
      (weaponHeatEvent as Extract<(typeof state.events)[number], { kind: "heatWeapon" }>).weapon,
    ).toBe("AC/20");
  });
});

describe("game integration: dissipation", () => {
  it("resolveHeatPhase dissipates up to sink count", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    hbk.heat = 20;
    startAttackTurn(state);
    advancePhase(state, scriptedRng(3, 3, 3, 1));
    expect(hbk.heat).toBe(20 - 13);
    const dissipEvent = state.events.find((e) => e.kind === "heatDissipated" && e.unitId === "hbk");
    expect(dissipEvent).toBeDefined();
    expect(
      (dissipEvent as Extract<(typeof state.events)[number], { kind: "heatDissipated" }>).dissip,
    ).toBe(13);
  });
});

describe("game integration: engine crit heat", () => {
  it("adds 10 engine heat when 2+ engine slots destroyed", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    const def = getMechDefFor(hbk);
    hbk.critSlotsDestroyed = {
      ...hbk.critSlotsDestroyed,
      centerTorso: [true, true, ...hbk.critSlotsDestroyed.centerTorso.slice(2)],
    };
    hbk.heat = 0;
    startAttackTurn(state);
    advancePhase(state, scriptedRng(3, 3, 3, 1));
    expect(hbk.heat).toBe(10 - Math.min(10, heatDissipation(def, hbk.critSlotsDestroyed)));
    expect(state.events.some((e) => e.kind === "heatEngineCrit" && e.unitId === "hbk")).toBe(true);
  });
});

describe("game integration: shutdown", () => {
  it("auto shutdown at heat 30+", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    hbk.heat = 30;
    startAttackTurn(state);
    advancePhase(state, scriptedRng(3, 3, 3, 1));
    expect(hbk.shutdown).toBe("heat");
    expect(state.events.some((e) => e.kind === "shutdownAuto")).toBe(true);
  });

  it("rolls shutdown avoid at 14–29", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    hbk.heat = 18;
    startAttackTurn(state);
    advancePhase(state, scriptedRng(3, 3, 3, 1));
    expect(hbk.shutdown).toBe("heat");
    expect(state.events.some((e) => e.kind === "shutdown" && e.unitId === "hbk")).toBe(true);
  });

  it("avoids shutdown when roll >= avoid", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    hbk.heat = 18;
    startAttackTurn(state);
    advancePhase(state, scriptedRng(6, 6, 6, 6));
    expect(hbk.shutdown).toBe("not");
    expect(state.events.some((e) => e.kind === "shutdownAvoided" && e.unitId === "hbk")).toBe(true);
  });

  it("skips shutdown unit in nextActor", () => {
    const state = hbkVsEnf();
    startMovementTurn(state);
    declareMove(state, "hbk", "walk");
    executeMove(state, "hbk", []);
    getUnit(state, "hbk").shutdown = "heat";
    expect(nextActor(state)).toBe("enf");
  });

  it("restarts automatically when heat below 14", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    hbk.shutdown = "heat";
    hbk.heat = 12;
    startAttackTurn(state);
    advancePhase(state, scriptedRng(3, 3, 3, 1));
    expect(hbk.shutdown).toBe("not");
    expect(state.events.some((e) => e.kind === "restarted" && e.unitId === "hbk")).toBe(true);
  });

  it("does not auto-restart a manual shutdown", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    hbk.shutdown = "manual";
    hbk.heat = 12;
    startAttackTurn(state);
    advancePhase(state, scriptedRng(3, 3, 3, 1));
    expect(hbk.shutdown).toBe("manual");
    expect(state.events.some((e) => e.kind === "restarted" && e.unitId === "hbk")).toBe(false);
  });

  it("leaves a starting unit untouched and brings it online at the next initiative", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    hbk.shutdown = "starting";
    hbk.heat = 12;
    startAttackTurn(state);
    advancePhase(state, scriptedRng(3, 3, 3, 1));
    expect(hbk.shutdown).toBe("starting");
    // weaponAttack -> end already ran; advance again: end -> initiative (turn 2).
    advancePhase(state, scriptedRng(3, 3, 3, 1));
    expect(hbk.shutdown).toBe("not");
  });
});

describe("game integration: heatMod in to-hit", () => {
  it("attack includes heatMod 2 at heat 13", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    hbk.heat = 13;
    startAttackTurn(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }]);
    resolveDeclaredAttacks(state, "hbk", scriptedRng(6, 6, 3, 4));
    const resolved = state.events.find((e) => e.kind === "attackResolved");
    expect(resolved).toBeDefined();
    expect(
      (resolved as Extract<(typeof state.events)[number], { kind: "attackResolved" }>).resolution
        .breakdown.heatMod,
    ).toBe(2);
  });
});

describe("game integration: immobile target modifier in to-hit", () => {
  function targetModFor(online: boolean, rng = scriptedRng(6, 6, 3, 4)): number {
    const state = hbkVsEnf();
    if (!online) getUnit(state, "enf").shutdown = "manual";
    startAttackTurn(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }]);
    resolveDeclaredAttacks(state, "hbk", rng);
    const resolved = state.events.find((e) => e.kind === "attackResolved");
    expect(resolved).toBeDefined();
    return (resolved as Extract<(typeof state.events)[number], { kind: "attackResolved" }>)
      .resolution.breakdown.targetMod;
  }

  it("online target in place: targetMod 0", () => {
    expect(targetModFor(true)).toBe(0);
  });

  it("shut-down target: targetMod -4", () => {
    expect(targetModFor(false)).toBe(-4);
  });
});

describe("game integration: partial cover in to-hit", () => {
  function makeBattleWithTargetTerrain(type: TerrainType): BattleState {
    const units: UnitInit[] = [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: 2, row: 4 },
        facing: "se",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 5, row: 4 },
        facing: "nw",
      },
    ];
    return createTestBattle([{ col: 5, row: 4, type }], units, true);
  }

  function terrainModFor(type: TerrainType): number {
    const state = makeBattleWithTargetTerrain(type);
    startAttackTurn(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }]);
    resolveDeclaredAttacks(state, "hbk", scriptedRng(6, 6, 3, 4));
    const resolved = state.events.find((e) => e.kind === "attackResolved");
    expect(resolved).toBeDefined();
    return (resolved as Extract<(typeof state.events)[number], { kind: "attackResolved" }>)
      .resolution.breakdown.terrainMod;
  }

  it("target in clear: terrainMod 0", () => {
    expect(terrainModFor("clear")).toBe(0);
  });

  it("target in water1: terrainMod 1 (partial cover)", () => {
    expect(terrainModFor("water1")).toBe(1);
  });

  it("target in building hex: terrainMod 1 (partial cover)", () => {
    expect(terrainModFor("mediumBuilding")).toBe(1);
  });
});

describe("game integration: heat ammo explosion", () => {
  it("largest ammo bin detonates when avoidance roll fails", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    hbk.heat = 30; // auto shutdown first
    startAttackTurn(state);
    // shutdown auto: no roll; ammo avoid roll 4 < 8 (avoid=8 for heat 30)
    advancePhase(state, scriptedRng(3, 1, 6, 6, 6, 6));
    expect(hbk.ammoBins["leftTorso:1"]).toBe(0);
    expect(state.events.some((e) => e.kind === "heatAmmoExplosion" && e.unitId === "hbk")).toBe(
      true,
    );
  });

  it("gauss-only unit does not detonate from heat (inert ammo)", () => {
    const state = bzkVsEnf();
    const bzk = getUnit(state, "bzk");
    bzk.heat = 30;
    startAttackTurn(state);
    // Shutdown auto: no roll. No ammo avoid roll is taken because the only
    // loaded ammo is gauss (non-explosive). The same scripted rng would
    // otherwise fail an avoid=8 roll.
    advancePhase(state, scriptedRng(3, 1, 6, 6, 6, 6));
    expect(bzk.shutdown).toBe("heat");
    expect(state.events.some((e) => e.kind === "heatAmmoExplosion" && e.unitId === "bzk")).toBe(
      false,
    );
    // Gauss ammo bins survive intact.
    expect(bzk.ammoBins["centerTorso:11"]).toBe(8);
    expect(bzk.ammoBins["centerTorso:12"]).toBe(8);
  });
});
