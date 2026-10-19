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
    expect(() => voluntaryShutdown(state, "hbk", [])).toThrow(/before initiative/);
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
    requireUnit(state, "hbk").shutdown = "manual";
    expect(() => voluntaryShutdown(state, "hbk", [])).toThrow(/already shut down/);
  });

  it("blocks movement and firing while down", () => {
    const state = startMovementTurn(hbkVsEnf());
    voluntaryShutdown(state, "hbk", []);
    // hbk is down; only enf remains in the movement phase. Move enf, then
    // advance to weapon attack. hbk (still down) must be refused a
    // target declaration.
    executeMove(state, "enf", "walk", [], [], { rng: scriptedRng() });
    expect(requireUnit(state, "hbk").shutdown).toBe("manual");
    advancePhase(state, [], scriptedRng()); // movement -> weaponAttack
    expect(() =>
      declareAttacks(
        state,
        "hbk",
        [{ weaponIndex: 1, targetId: "enf" }],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      ),
    ).toThrow(/shut down|current actor/);
  });

  it("persists through the heat phase instead of auto-restarting", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.shutdown = "manual";
    hbk.heat = 12;
    startMovementTurn(state);
    advancePhase(state, [], scriptedRng()); // movement -> weaponAttack
    advancePhase(state, [], scriptedRng(3, 3, 3, 1)); // weaponAttack -> end (heat check)
    expect(hbk.shutdown).toBe("manual");
  });
});

describe("voluntary startup", () => {
  it("auto-succeeds below the shutdown threshold (heat < 14)", () => {
    const state = startMovementTurn(hbkVsEnf());
    const hbk = requireUnit(state, "hbk");
    hbk.shutdown = "manual"; // shut down in an earlier turn
    const events: GameEvent[] = [];
    attemptVoluntaryStartup(state, "hbk", events, scriptedRng());
    expect(hbk.shutdown).toBe("not");
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
    hbk.shutdown = "manual"; // shut down in an earlier turn
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
    hbk.shutdown = "manual"; // shut down in an earlier turn
    const events: GameEvent[] = [];
    attemptVoluntaryStartup(state, "hbk", events, scriptedRng(6, 6));
    expect(hbk.shutdown).toBe("manual");
    expect(events).toMatchObject([{ kind: "restartCheck", result: "heat", manual: true, roll: 0 }]);
    expect(state.actedThisPhase).toContain("hbk");
  });

  it("gives an unconscious pilot no startup attempt: the unit is not an actor (TW p.42)", () => {
    const state = startMovementTurn(hbkVsEnf());
    const hbk = requireUnit(state, "hbk");
    hbk.unconsciousSinceTurn = state.turn;
    hbk.shutdown = "manual"; // shut down in an earlier turn
    expect(() => attemptVoluntaryStartup(state, "hbk", [], scriptedRng())).toThrow(
      /not the current actor/,
    );
    expect(hbk.shutdown).toBe("manual");
    expect(nextActor(state)).toBe("enf");
  });

  it("rejects an online unit, including one that just started up", () => {
    const state = startMovementTurn(hbkVsEnf());
    expect(() => attemptVoluntaryStartup(state, "hbk", [], scriptedRng())).toThrow(/not shut down/);
    requireUnit(state, "hbk").shutdown = "manual";
    attemptVoluntaryStartup(state, "hbk", [], scriptedRng());
    // the startup was its declaration: a second one is out of turn
    expect(() => attemptVoluntaryStartup(state, "hbk", [], scriptedRng())).toThrow(
      /not the current actor/,
    );
  });

  it("comes online at once: movement is spent, the attack phase is kept", () => {
    const state = startMovementTurn(hbkVsEnf());
    const hbk = requireUnit(state, "hbk");
    hbk.shutdown = "manual"; // shut down in an earlier turn
    attemptVoluntaryStartup(state, "hbk", [], scriptedRng());
    expect(hbk.shutdown).toBe("not");
    expect(state.actedThisPhase).toContain("hbk");
    expect(hbk.mpSpent).toBe(0);
    advancePhase(state, [], scriptedRng()); // movement -> weaponAttack
    const first = nextActor(state) as string;
    state.actedThisPhase.push(first);
    expect(new Set([first, nextActor(state)])).toEqual(new Set(["hbk", "enf"]));
  });
});

describe("movement pass for shut-down units", () => {
  it("marks a down unit as acted without changing state", () => {
    const state = startMovementTurn(hbkVsEnf());
    requireUnit(state, "hbk").shutdown = "manual"; // shut down in an earlier turn
    passMovement(state, "hbk");
    expect(requireUnit(state, "hbk").shutdown).toBe("manual");
    expect(state.actedThisPhase).toContain("hbk");
    expect(nextActor(state)).toBe("enf");
  });

  it("rejects an online unit", () => {
    const state = startMovementTurn(hbkVsEnf());
    expect(() => passMovement(state, "hbk")).toThrow(/not shut down/);
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
    executeMove(state, "enf", "walk", [], [], { rng: scriptedRng() });
    advancePhase(state, [], scriptedRng()); // movement -> weaponAttack
    expect(nextActor(state)).toBe("enf");
  });
});
