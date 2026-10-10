import { describe, expect, it } from "vitest";
import type { BattleState, GameEvent, UnitInit } from "../src/rules/game";
import {
  advancePhase,
  attemptVoluntaryStartup,
  buildUnitInit,
  declareAttacks,
  executeMove,
  nextActor,
  passMovement,
  requireUnit,
  rollInitiativePhase,
  voluntaryShutdown,
} from "../src/rules/game";
import { createTestBattle, scriptedRng } from "./helpers";

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

describe("voluntary shutdown", () => {
  it("requires the movement phase", () => {
    const state = hbkVsEnf();
    expect(() => voluntaryShutdown(state, "hbk", [])).toThrow(/movement/);
  });

  it("takes an online unit off-line and marks it as acted", () => {
    const state = startMovementTurn(hbkVsEnf());
    const events: GameEvent[] = [];
    voluntaryShutdown(state, "hbk", events);
    expect(requireUnit(state, "hbk").shutdown).toBe("manual");
    expect(state.actedThisPhase).toContain("hbk");
    expect(
      events.some(
        (e) => e.kind === "shutdownCheck" && e.unitId === "hbk" && e.manual && e.result !== "avoid",
      ),
    ).toBe(true);
  });

  it("rejects a unit that is already shut down", () => {
    const state = startMovementTurn(hbkVsEnf());
    voluntaryShutdown(state, "hbk", []);
    expect(() => voluntaryShutdown(state, "hbk", [])).toThrow(/already shut down/);
  });

  it("blocks movement and firing while down (including 'starting')", () => {
    const state = startMovementTurn(hbkVsEnf());
    voluntaryShutdown(state, "hbk", []);
    // hbk is down; only enf remains in the movement phase. Move enf, then
    // advance to weapon attack. hbk (still down as "starting") must be
    // refused a target declaration.
    executeMove(state, "enf", "walk", [], []);
    expect(requireUnit(state, "hbk").shutdown).toBe("manual");
    requireUnit(state, "hbk").shutdown = "starting";
    advancePhase(state, []); // movement -> weaponAttack
    expect(() =>
      declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], []),
    ).toThrow(/shut down|current actor/);
  });

  it("persists through the heat phase instead of auto-restarting", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.shutdown = "manual";
    hbk.heat = 12;
    startMovementTurn(state);
    advancePhase(state, []); // movement -> weaponAttack
    advancePhase(state, [], scriptedRng(3, 3, 3, 1)); // weaponAttack -> end (heat check)
    expect(hbk.shutdown).toBe("manual");
  });
});

describe("voluntary startup", () => {
  it("auto-succeeds below the shutdown threshold (heat < 14)", () => {
    const state = startMovementTurn(hbkVsEnf());
    const hbk = requireUnit(state, "hbk");
    voluntaryShutdown(state, "hbk", []);
    const events: GameEvent[] = [];
    attemptVoluntaryStartup(state, "hbk", events, scriptedRng());
    expect(hbk.shutdown).toBe("starting");
    expect(
      events.some(
        (e) =>
          e.kind === "restartCheck" && e.unitId === "hbk" && e.result === "success" && e.manual,
      ),
    ).toBe(true);
    expect(state.actedThisPhase).toContain("hbk");
  });

  it("fails when the avoidance roll is too low", () => {
    const state = startMovementTurn(hbkVsEnf());
    const hbk = requireUnit(state, "hbk");
    hbk.heat = 18; // avoid 6
    voluntaryShutdown(state, "hbk", []);
    const events: GameEvent[] = [];
    attemptVoluntaryStartup(state, "hbk", events, scriptedRng(2, 1)); // 2D6 = 3 < 6
    expect(hbk.shutdown).toBe("manual");
    expect(
      events.some(
        (e) =>
          e.kind === "restartCheck" && e.unitId === "hbk" && e.result !== "success" && e.manual,
      ),
    ).toBe(true);
    expect(state.actedThisPhase).toContain("hbk");
  });

  it("cannot start up at heat 30+, even with a perfect roll, and rolls nothing", () => {
    const state = startMovementTurn(hbkVsEnf());
    const hbk = requireUnit(state, "hbk");
    hbk.heat = 30;
    voluntaryShutdown(state, "hbk", []);
    const events: GameEvent[] = [];
    attemptVoluntaryStartup(state, "hbk", events, scriptedRng(6, 6));
    expect(hbk.shutdown).toBe("manual");
    expect(events).toMatchObject([{ kind: "restartCheck", result: "heat", manual: true, roll: 0 }]);
    expect(state.actedThisPhase).toContain("hbk");
  });

  it("blocks an unconscious pilot's startup at heat 14+ but not below 14", () => {
    const state = startMovementTurn(hbkVsEnf());
    const hbk = requireUnit(state, "hbk");
    hbk.unconscious = true;
    hbk.heat = 18;
    voluntaryShutdown(state, "hbk", []);
    const events: GameEvent[] = [];
    attemptVoluntaryStartup(state, "hbk", events, scriptedRng(6, 6));
    expect(hbk.shutdown).toBe("manual");
    expect(events).toMatchObject([{ kind: "restartCheck", result: "unconscious" }]);

    const low = startMovementTurn(hbkVsEnf());
    const hbk2 = requireUnit(low, "hbk");
    hbk2.unconscious = true;
    voluntaryShutdown(low, "hbk", []);
    attemptVoluntaryStartup(low, "hbk", [], scriptedRng());
    expect(hbk2.shutdown).toBe("starting");
  });

  it("rejects an online unit and a pending startup", () => {
    const state = startMovementTurn(hbkVsEnf());
    expect(() => attemptVoluntaryStartup(state, "enf", [], scriptedRng())).toThrow(/not shut down/);
    voluntaryShutdown(state, "hbk", []);
    attemptVoluntaryStartup(state, "hbk", []);
    expect(() => attemptVoluntaryStartup(state, "hbk", [], scriptedRng())).toThrow(
      /already starting/,
    );
  });

  it("still counts as down until the next initiative roll", () => {
    const state = startMovementTurn(hbkVsEnf());
    const hbk = requireUnit(state, "hbk");
    voluntaryShutdown(state, "hbk", []);
    attemptVoluntaryStartup(state, "hbk", []);
    expect(hbk.shutdown).toBe("starting");
    advancePhase(state, []); // movement -> weaponAttack
    expect(nextActor(state)).toBe("enf"); // hbk skipped, still down
    advancePhase(state, [], scriptedRng(3, 3, 3, 1)); // weaponAttack -> end
    expect(hbk.shutdown).toBe("starting");
    advancePhase(state, [], scriptedRng(3, 3, 3, 1)); // end -> initiative
    expect(hbk.shutdown).toBe("not");
  });
});

describe("movement pass for shut-down units", () => {
  it("marks a down unit as acted without changing state", () => {
    const state = startMovementTurn(hbkVsEnf());
    voluntaryShutdown(state, "hbk", []);
    passMovement(state, "hbk");
    expect(requireUnit(state, "hbk").shutdown).toBe("manual");
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
    startMovementTurn(state, scriptedRng(2, 2, 6, 6)); // team 2 (enf) wins initiative
    requireUnit(state, "hbk").shutdown = "heat"; // down, not acted this turn
    expect(nextActor(state)).toBe("hbk");
  });

  it("skips down units in the weapon attack phase", () => {
    const state = startMovementTurn(hbkVsEnf());
    voluntaryShutdown(state, "hbk", []);
    executeMove(state, "enf", "walk", [], []);
    advancePhase(state, []); // movement -> weaponAttack
    expect(nextActor(state)).toBe("enf");
  });
});
