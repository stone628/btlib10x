import { describe, expect, it } from "vitest";
import type { BattleState, UnitInit } from "../src/rules/game.js";
import {
  advancePhase,
  attemptVoluntaryStartup,
  createBattle,
  declareAttacks,
  declareMove,
  executeMove,
  getUnit,
  nextActor,
  passMovement,
  rollInitiativePhase,
  voluntaryShutdown,
} from "../src/rules/game.js";
import { makeBattleOptions, scriptedRng } from "./helpers.js";

function hbkVsEnf(): BattleState {
  const units: UnitInit[] = [
    { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 2, row: 4 }, facing: "se" },
    { id: "enf", model: "ENF-4R", team: 1, gunnery: 4, position: { col: 5, row: 4 }, facing: "nw" },
  ];
  return createBattle(units, makeBattleOptions(units, true));
}

function startMovementTurn(state: BattleState, rng = scriptedRng(3, 3, 3, 1)): BattleState {
  rollInitiativePhase(state, rng);
  return state;
}

describe("voluntary shutdown", () => {
  it("requires the movement phase", () => {
    const state = hbkVsEnf();
    expect(() => voluntaryShutdown(state, "hbk")).toThrow(/movement/);
  });

  it("takes an online unit off-line and marks it as acted", () => {
    const state = startMovementTurn(hbkVsEnf());
    voluntaryShutdown(state, "hbk");
    expect(getUnit(state, "hbk").shutdown).toBe("manual");
    expect(state.actedThisPhase).toContain("hbk");
    expect(state.events.some((e) => e.kind === "shutdownManual" && e.unitId === "hbk")).toBe(true);
  });

  it("rejects a unit that is already shut down", () => {
    const state = startMovementTurn(hbkVsEnf());
    voluntaryShutdown(state, "hbk");
    expect(() => voluntaryShutdown(state, "hbk")).toThrow(/already shut down/);
  });

  it("blocks movement and firing while down (including 'starting')", () => {
    const state = startMovementTurn(hbkVsEnf());
    voluntaryShutdown(state, "hbk");
    // hbk is down; only enf remains in the movement phase. Move enf, then
    // advance to weapon attack. hbk (still down as "starting") must be
    // refused a target declaration.
    declareMove(state, "enf", "walk");
    executeMove(state, "enf", []);
    expect(getUnit(state, "hbk").shutdown).toBe("manual");
    getUnit(state, "hbk").shutdown = "starting";
    advancePhase(state); // movement -> weaponAttack
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }])).toThrow(
      /shut down/,
    );
  });

  it("persists through the heat phase instead of auto-restarting", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    hbk.shutdown = "manual";
    hbk.heat = 12;
    startMovementTurn(state);
    advancePhase(state); // movement -> weaponAttack
    advancePhase(state, scriptedRng(3, 3, 3, 1)); // weaponAttack -> end (heat check)
    expect(hbk.shutdown).toBe("manual");
  });
});

describe("voluntary startup", () => {
  it("auto-succeeds below the shutdown threshold (heat < 14)", () => {
    const state = startMovementTurn(hbkVsEnf());
    const hbk = getUnit(state, "hbk");
    voluntaryShutdown(state, "hbk");
    attemptVoluntaryStartup(state, "hbk", scriptedRng());
    expect(hbk.shutdown).toBe("starting");
    expect(state.events.some((e) => e.kind === "startupSuccess" && e.unitId === "hbk")).toBe(true);
    expect(state.actedThisPhase).toContain("hbk");
  });

  it("fails when the avoidance roll is too low", () => {
    const state = startMovementTurn(hbkVsEnf());
    const hbk = getUnit(state, "hbk");
    hbk.heat = 18; // avoid 6
    voluntaryShutdown(state, "hbk");
    attemptVoluntaryStartup(state, "hbk", scriptedRng(2, 1)); // 2D6 = 3 < 6
    expect(hbk.shutdown).toBe("manual");
    expect(state.events.some((e) => e.kind === "startupFailed" && e.unitId === "hbk")).toBe(true);
    expect(state.actedThisPhase).toContain("hbk");
  });

  it("rejects an online unit and a pending startup", () => {
    const state = startMovementTurn(hbkVsEnf());
    expect(() => attemptVoluntaryStartup(state, "enf", scriptedRng())).toThrow(/not shut down/);
    voluntaryShutdown(state, "hbk");
    attemptVoluntaryStartup(state, "hbk", scriptedRng());
    expect(() => attemptVoluntaryStartup(state, "hbk", scriptedRng())).toThrow(/already starting/);
  });

  it("still counts as down until the next initiative roll", () => {
    const state = startMovementTurn(hbkVsEnf());
    const hbk = getUnit(state, "hbk");
    voluntaryShutdown(state, "hbk");
    attemptVoluntaryStartup(state, "hbk", scriptedRng());
    expect(hbk.shutdown).toBe("starting");
    advancePhase(state); // movement -> weaponAttack
    expect(nextActor(state)).toBe("enf"); // hbk skipped, still down
    advancePhase(state, scriptedRng(3, 3, 3, 1)); // weaponAttack -> end
    expect(hbk.shutdown).toBe("starting");
    advancePhase(state, scriptedRng(3, 3, 3, 1)); // end -> initiative
    expect(hbk.shutdown).toBe("not");
  });
});

describe("movement pass for shut-down units", () => {
  it("marks a down unit as acted without changing state", () => {
    const state = startMovementTurn(hbkVsEnf());
    voluntaryShutdown(state, "hbk");
    passMovement(state, "hbk");
    expect(getUnit(state, "hbk").shutdown).toBe("manual");
    expect(state.actedThisPhase).toContain("hbk");
    expect(nextActor(state)).toBe("enf");
  });

  it("rejects an online unit", () => {
    const state = startMovementTurn(hbkVsEnf());
    expect(() => passMovement(state, "enf")).toThrow(/not shut down/);
  });
});

describe("movement priority for shut-down units", () => {
  it("puts a down unit first regardless of initiative", () => {
    const state = hbkVsEnf();
    startMovementTurn(state, scriptedRng(2, 2, 6, 6)); // team 1 (enf) wins initiative
    getUnit(state, "hbk").shutdown = "heat"; // down, not acted this turn
    expect(nextActor(state)).toBe("hbk");
  });

  it("skips down units in the weapon attack phase", () => {
    const state = startMovementTurn(hbkVsEnf());
    voluntaryShutdown(state, "hbk");
    declareMove(state, "enf", "walk");
    executeMove(state, "enf", []);
    advancePhase(state); // movement -> weaponAttack
    expect(nextActor(state)).toBe("enf");
  });
});
