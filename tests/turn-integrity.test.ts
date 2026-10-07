import { describe, expect, it } from "vitest";
import type { BattleState, GameEvent, UnitInit } from "../src/rules/game";
import {
  actorQueue,
  applyPilotHits,
  attemptVoluntaryStartup,
  buildUnitInit,
  executeMove,
  nextActor,
  requireUnit,
  rollInitiativePhase,
} from "../src/rules/game";
import { createTestBattle, scriptedRng } from "./helpers";

/** Winner = team 1 (rolls 6 against team 0's 2). Order string: L = loser, W = winner. */
function queueOrder(winners: number, losers: number): string {
  const units: UnitInit[] = [];
  for (let i = 0; i < losers; i++) {
    units.push(buildUnitInit(`l${i}`, "HBK-4G", 0, { col: i, row: 0 }, "s"));
  }
  for (let i = 0; i < winners; i++) {
    units.push(buildUnitInit(`w${i}`, "HBK-4G", 1, { col: i, row: 5 }, "n"));
  }
  const state = createTestBattle([], units, true);
  rollInitiativePhase(state, scriptedRng(1, 1, 3, 3), []);
  expect(state.initiativeWinnerTeam).toBe(1);
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
      buildUnitInit("hbk", "HBK-4G", 0, { col: 2, row: 2 }, "s"),
      buildUnitInit("enf", "ENF-4R", 1, { col: 6, row: 6 }, "n"),
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
