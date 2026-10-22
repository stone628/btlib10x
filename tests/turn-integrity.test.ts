import { describe, expect, it } from "vitest";
import type { BattleState, GameEvent, UnitInit } from "../src/rules/game";
import {
  abandonPilot,
  actorQueue,
  applyPilotHits,
  attemptVoluntaryStartup,
  buildUnitInit,
  ejectPilot,
  executeMove,
  nextActor,
  passMovement,
  requireUnit,
  rollInitiativePhase,
  voluntaryShutdown,
} from "../src/rules/game";
import { createTestBattle, scriptedRng } from "./helpers";

/** Winner = team 2 (rolls 6 against team 1's 2). Order string: L = loser, W = winner. */
function queueOrder(winners: number, losers: number): string {
  const units: UnitInit[] = [];
  for (let i = 0; i < losers; i++) {
    units.push(buildUnitInit(`l${i}`, "HBK-4G", 1, { col: i + 1, row: 1 }, "s"));
  }
  for (let i = 0; i < winners; i++) {
    units.push(buildUnitInit(`w${i}`, "HBK-4G", 2, { col: i + 1, row: 6 }, "n"));
  }
  const state = createTestBattle([], units, true);
  rollInitiativePhase(state, scriptedRng(1, 1, 3, 3), []);
  expect(state.initiativeWinnerTeam).toBe(2);
  return actorQueue(state)
    .pending.map((v) => (v.id.startsWith("w") ? "W" : "L"))
    .join("");
}

describe("unequal-force activation is recounted before every pair (TW p.39, INIT-01)", () => {
  it.each([
    [3, 2, "LWLWW"],
    [5, 3, "LWLWWLWW"],
    [8, 5, "LWLWLWWLWWLWW"],
    [4, 3, "LWLWLWW"],
    [5, 2, "LWWLWWW"],
    [2, 3, "LWLLW"],
    [2, 5, "LLWLLLW"],
    [2, 1, "LWW"],
    [4, 2, "LWWLWW"],
    [1, 1, "LW"],
  ])("%i winners v %i losers -> %s", (w, l, expected) => {
    expect(queueOrder(w as number, l as number)).toBe(expected);
  });
});

function hbkVsEnf(terrain: Parameters<typeof createTestBattle>[0] = []): BattleState {
  const state = createTestBattle(
    terrain,
    [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 6, row: 6 }, "n"),
    ],
    true,
  );
  rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
  return state;
}

describe("a move cut short still ends the activation (TW p.59, MOV-01)", () => {
  it("a fall entering water hands the turn to the next unit", () => {
    const state = hbkVsEnf([{ col: 2, row: 3, type: "water1", level: 0 }]);
    expect(nextActor(state)).toBe("hbk");
    executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 2, row: 3 } }], [], {
      rng: scriptedRng(1, 1, 1, 3, 3, 3, 3, 3, 3),
    });
    expect(requireUnit(state, "hbk").prone).toBe(true);
    expect(state.actedThisPhase).toContain("hbk");
    expect(nextActor(state)).toBe("enf");
  });

  it("a failed building roll damages but does not stop the move (TW p.167)", () => {
    const state = hbkVsEnf([{ col: 2, row: 3, type: "lightBuilding", level: 0 }]);
    const events: GameEvent[] = [];
    executeMove(
      state,
      "hbk",
      "walk",
      [
        { kind: "enter", to: { col: 2, row: 3 } },
        { kind: "enter", to: { col: 2, row: 4 } },
      ],
      events,
      { rng: scriptedRng(1, 1, 3, 3, 3, 3) },
    );
    expect(events.some((e) => e.kind === "buildingCrash")).toBe(true);
    expect(requireUnit(state, "hbk").position).toEqual({ col: 2, row: 4 });
    expect(nextActor(state)).toBe("enf");
  });
});

describe("heat shutdown restarts only in the Heat Phase (TW p.160, HEAT-01)", () => {
  it("refuses the movement-phase startup for a heat shutdown", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.shutdown = "heat";
    hbk.heat = 20;
    expect(() => attemptVoluntaryStartup(state, "hbk", [], scriptedRng())).toThrow(/Heat Phase/);
  });
});

describe("pilot hits never exceed the maximum (SALV-04)", () => {
  it("caps at pilotHitMax", () => {
    const state = hbkVsEnf();
    const hbk = requireUnit(state, "hbk");
    hbk.pilotHits = hbk.pilotHitMax - 1;
    applyPilotHits(state, hbk, 3, "fall", scriptedRng(6, 6, 6, 6, 6, 6), []);
    expect(hbk.pilotHits).toBe(hbk.pilotHitMax);
  });
});

describe("shutdown, startup, ejection and passes are movement declarations (API-09)", () => {
  it("refuses them out of turn", () => {
    const state = hbkVsEnf();
    expect(nextActor(state)).toBe("hbk");
    expect(() => ejectPilot(state, "enf", scriptedRng(6, 6), [])).toThrow(/not the current actor/);
    expect(() => voluntaryShutdown(state, "enf", [])).toThrow(/not the current actor/);
    expect(requireUnit(state, "enf").removed).toBe("not");
    expect(requireUnit(state, "enf").shutdown).toBe("not");
    expect(state.actedThisPhase).toEqual([]);
  });

  it("refuses them for a down unit that is not at the head of the queue", () => {
    const state = hbkVsEnf();
    requireUnit(state, "hbk").shutdown = "manual";
    requireUnit(state, "enf").shutdown = "manual";
    expect(nextActor(state)).toBe("hbk");
    expect(() => attemptVoluntaryStartup(state, "enf", [], scriptedRng())).toThrow(
      /not the current actor/,
    );
    expect(() => passMovement(state, "enf")).toThrow(/not the current actor/);
    expect(() => abandonPilot(state, "enf", [])).toThrow(/not the current actor/);
    expect(state.actedThisPhase).toEqual([]);
  });

  it("allows one declaration per unit: no shutdown or ejection after a move", () => {
    const state = hbkVsEnf();
    executeMove(state, "hbk", "walk", [], [], { rng: scriptedRng() });
    expect(() => voluntaryShutdown(state, "hbk", [])).toThrow(/not the current actor/);
    expect(() => ejectPilot(state, "hbk", scriptedRng(6, 6), [])).toThrow(/not the current actor/);
    expect(state.actedThisPhase).toEqual(["hbk"]);
    expect(requireUnit(state, "hbk").shutdown).toBe("not");
  });

  it("gives an unconscious pilot no manual ejection (TW p.42)", () => {
    const state = hbkVsEnf();
    requireUnit(state, "hbk").unconsciousSinceTurn = state.turn;
    expect(() => ejectPilot(state, "hbk", scriptedRng(6, 6), [])).toThrow(/not the current actor/);
    expect(requireUnit(state, "hbk").removed).toBe("not");
  });

  it("accepts them from the current actor", () => {
    const state = hbkVsEnf();
    ejectPilot(state, "hbk", scriptedRng(6, 6), []);
    expect(requireUnit(state, "hbk").removed).toBe("pilotEjected");
    expect(nextActor(state)).toBe("enf");
    voluntaryShutdown(state, "enf", []);
    expect(requireUnit(state, "enf").shutdown).toBe("manual");
  });
});
