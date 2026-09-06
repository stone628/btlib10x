import { describe, expect, it } from "vitest";
import { getMechDef, getMechDefFor } from "../src/data/index.js";
import type { BattleState, UnitInit } from "../src/rules/game.js";
import {
  advancePhase,
  createBattle,
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
import { makeBattleOptions, scriptedRng } from "./helpers.js";

function hbkVsEnf(): BattleState {
  const units: UnitInit[] = [
    { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 2, row: 4 }, facing: "se" },
    { id: "enf", model: "ENF-4R", team: 1, gunnery: 4, position: { col: 3, row: 4 }, facing: "nw" },
  ];
  return createBattle(units, makeBattleOptions(units, true));
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
    expect(shutdownAvoid(13)).toBeNull();
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
    expect(shutdownAvoid(30)).toBeNull();
  });
});

describe("ammoExplosionAvoid", () => {
  it("null below 19", () => {
    expect(ammoExplosionAvoid(18)).toBeNull();
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
  it("HBK-4G has 15 sinks, 6 engine slots", () => {
    const state = hbkVsEnf();
    const unit = getUnit(state, "hbk");
    const def = getMechDefFor(unit);
    expect(heatDissipation(def, unit.critSlotsDestroyed)).toBe(15);
    expect(countDestroyedEngineSlots(def, unit.critSlotsDestroyed)).toBe(6);
  });
  it("destroying 1 engine slot reduces sinks by 1", () => {
    const state = hbkVsEnf();
    const unit = getUnit(state, "hbk");
    const def = getMechDefFor(unit);
    const destroyed = {
      ...unit.critSlotsDestroyed,
      centerTorso: [true, ...unit.critSlotsDestroyed.centerTorso.slice(1)],
    };
    expect(heatDissipation(def, destroyed)).toBe(14);
    expect(countDestroyedEngineSlots(def, destroyed)).toBe(7);
  });
});

describe("largestAmmoBin", () => {
  it("returns the AC/20 bin for HBK-4G", () => {
    const state = hbkVsEnf();
    const unit = getUnit(state, "hbk");
    const def = getMechDefFor(unit);
    const bin = largestAmmoBin(def, unit.ammoBins);
    expect(bin).not.toBeNull();
    expect(bin!.weapon).toBe("Autocannon/20");
    expect(bin!.shotsRemaining).toBe(10);
  });
});

// ---------------------------------------------------------------- game integration ----

describe("game integration: movement heat", () => {
  it("walk adds 1 heat", () => {
    const state = hbkVsEnf();
    startMovementTurn(state);
    declareMove(state, "hbk", "walk");
    executeMove(state, "hbk", []);
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
    executeMove(state, "hbk", []);
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
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }]);
    resolveDeclaredAttacks(state, "hbk", scriptedRng(6, 6, 3, 4));
    const hbk = getUnit(state, "hbk");
    expect(hbk.heat).toBe(7);
    const weaponHeatEvent = state.events.find((e) => e.kind === "heatWeapon");
    expect(weaponHeatEvent).toBeDefined();
    expect(
      (weaponHeatEvent as Extract<(typeof state.events)[number], { kind: "heatWeapon" }>).weapon,
    ).toBe("Autocannon/20");
  });
});

describe("game integration: dissipation", () => {
  it("resolveHeatPhase dissipates up to sink count", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    hbk.heat = 20;
    startAttackTurn(state);
    advancePhase(state, scriptedRng(3, 3, 3, 1));
    expect(hbk.heat).toBe(20 - 15);
    const dissipEvent = state.events.find((e) => e.kind === "heatDissipated" && e.unitId === "hbk");
    expect(dissipEvent).toBeDefined();
    expect(
      (dissipEvent as Extract<(typeof state.events)[number], { kind: "heatDissipated" }>).dissip,
    ).toBe(15);
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
    expect(hbk.shutdown).toBe(true);
    expect(state.events.some((e) => e.kind === "shutdownAuto")).toBe(true);
  });

  it("rolls shutdown avoid at 14–29", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    hbk.heat = 18;
    startAttackTurn(state);
    advancePhase(state, scriptedRng(3, 3, 3, 1));
    expect(hbk.shutdown).toBe(true);
    expect(state.events.some((e) => e.kind === "shutdown" && e.unitId === "hbk")).toBe(true);
  });

  it("avoids shutdown when roll >= avoid", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    hbk.heat = 18;
    startAttackTurn(state);
    advancePhase(state, scriptedRng(6, 6, 6, 6));
    expect(hbk.shutdown).toBe(false);
    expect(state.events.some((e) => e.kind === "shutdownAvoided" && e.unitId === "hbk")).toBe(true);
  });

  it("skips shutdown unit in nextActor", () => {
    const state = hbkVsEnf();
    startMovementTurn(state);
    declareMove(state, "hbk", "walk");
    executeMove(state, "hbk", []);
    getUnit(state, "hbk").shutdown = true;
    expect(nextActor(state)).toBe("enf");
  });

  it("restarts automatically when heat below 14", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    hbk.shutdown = true;
    hbk.heat = 12;
    startAttackTurn(state);
    advancePhase(state, scriptedRng(3, 3, 3, 1));
    expect(hbk.shutdown).toBe(false);
    expect(state.events.some((e) => e.kind === "restarted" && e.unitId === "hbk")).toBe(true);
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

describe("game integration: heat ammo explosion", () => {
  it("largest ammo bin detonates when avoidance roll fails", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    hbk.heat = 30; // auto shutdown first
    startAttackTurn(state);
    // shutdown auto: no roll; ammo avoid roll 4 < 8 (avoid=8 for heat 30)
    advancePhase(state, scriptedRng(3, 1, 6, 6, 6, 6));
    expect(hbk.ammoBins["hbk:leftTorso:1"]).toBe(0);
    expect(state.events.some((e) => e.kind === "heatAmmoExplosion" && e.unitId === "hbk")).toBe(
      true,
    );
  });
});
