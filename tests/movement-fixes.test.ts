/**
 * Movement and piloting fixes: jump path validation (MOV-02), no jump after a
 * stand (MOV-04), destroyed-gyro prone turning (MOV-08), fall position
 * (MOV-10), and combined phase PSR modifiers (PSR-01).
 */

import { describe, expect, it } from "vitest";
import { mechDef } from "../src/data/index";
import { setSlotDestroyed } from "../src/rules/critical";
import {
  attemptStandUp,
  buildUnitInit,
  executeMove,
  executePostureMove,
  type GameEvent,
  postureMoveBudget,
  requireUnit,
  standUpCost,
} from "../src/rules/game";
import { createTestBattle, scriptedRng } from "./helpers";

function movementBattle(model = "GRF-1N", prone = false) {
  const state = createTestBattle(
    [],
    [
      buildUnitInit("a", model, 1, { col: 5, row: 5 }, "n"),
      buildUnitInit("b", model, 2, { col: 1, row: 1 }, "s"),
    ],
    true,
    9,
    9,
  );
  state.phase = "movement";
  state.initiativeWinnerTeam = 1;
  state.actorQueue = ["a", "b"];
  state.actedThisPhase = [];
  requireUnit(state, "a").prone = prone;
  return state;
}

describe("jump path validation (MOV-02)", () => {
  it("rejects a jump whose path is not a shortest path to the landing hex", () => {
    const state = movementBattle();
    const sink: GameEvent[] = [];
    // n, then back s: ends where it began after two steps.
    expect(() =>
      executeMove(
        state,
        "a",
        "jump",
        [
          { kind: "enter", to: { col: 5, row: 4 } },
          { kind: "enter", to: { col: 5, row: 5 } },
        ],
        sink,
        { rng: scriptedRng() },
      ),
    ).toThrow(/shortest path|at least 1 hex/);
  });

  it("accepts a straight jump", () => {
    const state = movementBattle();
    executeMove(state, "a", "jump", [{ kind: "enter", to: { col: 5, row: 4 } }], [], {
      rng: scriptedRng(),
    });
    expect(requireUnit(state, "a").position).toEqual({ col: 5, row: 4 });
  });
});

describe("jump height cap (MOV-02, TW p.53)", () => {
  it("cannot cross a level higher than Jumping MP plus the starting level", () => {
    const state = createTestBattle(
      [{ col: 5, row: 4, type: "clear", level: 6 }],
      [
        buildUnitInit("a", "GRF-1N", 1, { col: 5, row: 5 }, "n"),
        buildUnitInit("b", "GRF-1N", 2, { col: 1, row: 1 }, "s"),
      ],
      true,
      9,
      9,
    );
    state.phase = "movement";
    state.initiativeWinnerTeam = 1;
    state.actorQueue = ["a", "b"];
    state.actedThisPhase = [];
    expect(() =>
      executeMove(state, "a", "jump", [{ kind: "enter", to: { col: 5, row: 4 } }], [], {
        rng: scriptedRng(),
      }),
    ).toThrow(/higher than Jumping MP/);
  });

  it("clears a hill exactly as high as Jumping MP", () => {
    const state = createTestBattle(
      [{ col: 5, row: 4, type: "clear", level: 5 }],
      [
        buildUnitInit("a", "GRF-1N", 1, { col: 5, row: 5 }, "n"),
        buildUnitInit("b", "GRF-1N", 2, { col: 1, row: 1 }, "s"),
      ],
      true,
      9,
      9,
    );
    state.phase = "movement";
    state.initiativeWinnerTeam = 1;
    state.actorQueue = ["a", "b"];
    state.actedThisPhase = [];
    executeMove(state, "a", "jump", [{ kind: "enter", to: { col: 5, row: 4 } }], [], {
      rng: scriptedRng(),
    });
    expect(requireUnit(state, "a").position).toEqual({ col: 5, row: 4 });
  });
});

describe("posture and jump (MOV-04)", () => {
  it("refuses a jump chained after a stand-up", () => {
    const state = movementBattle("GRF-1N", true);
    expect(() =>
      executePostureMove(
        state,
        "a",
        "standUp",
        "jump",
        [{ kind: "enter", to: { col: 5, row: 4 } }],
        [],
        { rng: scriptedRng() },
      ),
    ).toThrow(/cannot jump/);
    // Refused before the stand: no roll, still prone, activation open.
    expect(requireUnit(state, "a").prone).toBe(true);
    expect(state.actedThisPhase).toEqual([]);
  });
});

describe("posture MP pool (TW pp.49-50)", () => {
  const north = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      kind: "enter" as const,
      to: { col: 5, row: 4 - i },
    }));

  it("charges the stand against the walk budget", () => {
    // GRF-1N walks 5: the stand takes 2, three hexes remain.
    const state = movementBattle("GRF-1N", true);
    expect(() =>
      executePostureMove(state, "a", "standUp", "walk", north(4), [], {
        rng: scriptedRng(6, 6),
      }),
    ).toThrow(/costs 4 MP but only 3 of the walk budget 5 is left/);
  });

  it("moves on the remainder and records the combined MP", () => {
    const state = movementBattle("GRF-1N", true);
    const sink: GameEvent[] = [];
    const stood = executePostureMove(state, "a", "standUp", "walk", north(3), sink, {
      rng: scriptedRng(6, 6),
    });
    expect(stood).toBe(true);
    const a = requireUnit(state, "a");
    expect(a.position).toEqual({ col: 5, row: 2 });
    expect(a.mpSpent).toBe(5);
    // The stand charged the walk heat; the move adds none (TW p.159).
    expect(sink.filter((e) => e.kind === "heatMove")).toHaveLength(1);
  });

  it("marks the activation once and refuses a re-sent move", () => {
    const state = movementBattle("GRF-1N", true);
    executePostureMove(state, "a", "standUp", "walk", north(1), [], {
      rng: scriptedRng(6, 6),
    });
    expect(state.actedThisPhase).toEqual(["a"]);
    expect(() => executeMove(state, "a", "walk", north(1), [], { rng: scriptedRng() })).toThrow(
      /not the current actor/,
    );
  });

  it("takes no steps after a failed stand", () => {
    const state = movementBattle("GRF-1N", true);
    const stood = executePostureMove(state, "a", "standUp", "walk", north(1), [], {
      rng: scriptedRng(1, 1, 3, 3, 3, 3, 3, 3, 3, 3),
    });
    expect(stood).toBe(false);
    const a = requireUnit(state, "a");
    expect(a.prone).toBe(true);
    expect(a.position).toEqual({ col: 5, row: 5 });
  });

  it("leaves nothing after a Minimum Movement stand (TW p.49)", () => {
    const state = movementBattle("GRF-1N", true);
    const a = requireUnit(state, "a");
    a.heat = 20; // walking 5 - 4 = 1 MP
    expect(standUpCost(a)).toBe(1);
    expect(postureMoveBudget(a, "standUp", 2)).toBe(0);
    expect(() =>
      executePostureMove(state, "a", "standUp", "run", north(1), [], {
        rng: scriptedRng(6, 6),
      }),
    ).toThrow(/only 0 of the run budget/);
  });

  it("allows the free facing pick after a Minimum Movement stand (TW p.50)", () => {
    const state = movementBattle("GRF-1N", true);
    requireUnit(state, "a").heat = 20;
    executePostureMove(state, "a", "standUp", "walk", [], [], {
      finalFacing: "s",
      rng: scriptedRng(6, 6),
    });
    const a = requireUnit(state, "a");
    expect(a.facing).toBe("s");
    expect(a.mpSpent).toBe(1);
  });

  it("charges the drop against the walk budget", () => {
    // Walk 5, drop 1: four hexsides of prone turning remain.
    const over = movementBattle();
    expect(() =>
      executePostureMove(
        over,
        "a",
        "drop",
        "walk",
        [
          { kind: "turn", facings: 3 },
          { kind: "turn", facings: 2 },
        ],
        [],
        { rng: scriptedRng() },
      ),
    ).toThrow(/costs 5 MP but only 4/);
    const state = movementBattle();
    executePostureMove(state, "a", "drop", "walk", [{ kind: "turn", facings: 3 }], [], {
      rng: scriptedRng(),
    });
    const a = requireUnit(state, "a");
    expect(a.prone).toBe(true);
    expect(a.mpSpent).toBe(4);
    expect(state.actedThisPhase).toEqual(["a"]);
  });
});

describe("destroyed gyro while prone (MOV-08)", () => {
  it("allows only one hexside of facing change per turn", () => {
    const state = movementBattle("HBK-4G", true);
    const a = requireUnit(state, "a");
    const layout = mechDef("HBK-4G")!.critSlots.centerTorso;
    layout.forEach((slot, i) => {
      if (slot.kind === "structure" && slot.name === "gyro")
        setSlotDestroyed(a.critSlotsDestroyed, "centerTorso", i);
    });
    expect(() =>
      executeMove(state, "a", "walk", [{ kind: "turn", facings: 2 }], [], { rng: scriptedRng() }),
    ).toThrow(/one hexside/);
    executeMove(state, "a", "walk", [{ kind: "turn", facings: 1 }], [], { rng: scriptedRng() });
    expect(a.facing).toBe("ne");
  });
});

describe("failed stand-up (MOV-06)", () => {
  it("a failed stand leaves the unit prone and ends its activation", () => {
    const state = movementBattle("HBK-4G", true);
    const a = requireUnit(state, "a");
    // stand PSR 1+1 fails; fall direction, fall location and seatbelt follow.
    const cost = attemptStandUp(state, "a", [], scriptedRng(1, 1, 1, 3, 4, 6, 6));
    expect(cost).toBe(2);
    expect(a.prone).toBe(true);
    expect(a.mpSpent).toBe(2);
    expect(state.actedThisPhase).toContain("a");
    expect(() => attemptStandUp(state, "a", [], scriptedRng(6, 6))).toThrow();
  });
});

describe("movement fall onto an occupied hex (MOV-09)", () => {
  function occupiedBattle() {
    const state = createTestBattle(
      [{ col: 5, row: 8, type: "rubble" }],
      [
        buildUnitInit("a", "HBK-4G", 1, { col: 5, row: 9 }, "n"),
        buildUnitInit("c", "HBK-4G", 1, { col: 5, row: 8 }, "n"),
        buildUnitInit("b", "HBK-4G", 2, { col: 1, row: 1 }, "s"),
      ],
      true,
      9,
      10,
    );
    state.phase = "movement";
    state.initiativeWinnerTeam = 1;
    state.actorQueue = ["a", "c", "b"];
    state.actedThisPhase = [];
    return state;
  }
  const walkThrough = [
    { kind: "enter" as const, to: { col: 5, row: 8 } },
    { kind: "enter" as const, to: { col: 5, row: 7 } },
  ];

  it("never displaces the occupant: the faller stays in the hex it came from", () => {
    const state = occupiedBattle();
    const events: GameEvent[] = [];
    // rubble PSR 1+1 fails; fall direction, location and seatbelt.
    executeMove(state, "a", "walk", walkThrough, events, {
      rng: scriptedRng(1, 1, 1, 3, 4, 6, 6, 6, 6, 6, 6, 6, 6),
    });
    expect(requireUnit(state, "a").prone).toBe(true);
    expect(requireUnit(state, "a").position).toEqual({ col: 5, row: 9 });
    expect(requireUnit(state, "c").position).toEqual({ col: 5, row: 8 });
  });

  describe("accidental fall from above (TW p.152)", () => {
    function highBattle() {
      const state = createTestBattle(
        [
          { col: 5, row: 9, type: "clear", level: 2 },
          { col: 5, row: 8, type: "rubble", level: 0 },
        ],
        [
          buildUnitInit("a", "HBK-4G", 1, { col: 5, row: 9 }, "n"),
          buildUnitInit("c", "HBK-4G", 1, { col: 5, row: 8 }, "n"),
          buildUnitInit("b", "HBK-4G", 2, { col: 1, row: 1 }, "s"),
        ],
        true,
        9,
        10,
      );
      state.phase = "movement";
      state.initiativeWinnerTeam = 1;
      state.actorQueue = ["a", "c", "b"];
      state.actedThisPhase = [];
      return state;
    }
    // rubble PSR fails (1,1); fall facing; three damage groups; seatbelt.
    const fall = [1, 1, 1, 3, 4, 3, 4, 3, 4, 6, 6];
    const step = [
      { kind: "enter" as const, to: { col: 5, row: 8 } },
      { kind: "enter" as const, to: { col: 5, row: 7 } },
    ];

    it("a miss lands the faller back in the hex it fell from", () => {
      const state = highBattle();
      const events: GameEvent[] = [];
      executeMove(state, "a", "run", step, events, {
        rng: scriptedRng(...fall, 1, 1, 6, 6, 6, 6, 6, 6),
      });
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "accidentalFall", hit: false }),
      );
      expect(requireUnit(state, "a").position).toEqual({ col: 5, row: 9 });
      expect(requireUnit(state, "c").position).toEqual({ col: 5, row: 8 });
    });

    it("a hit damages the occupant without moving it", () => {
      const state = highBattle();
      const events: GameEvent[] = [];
      executeMove(state, "a", "run", step, events, {
        rng: scriptedRng(...fall, 6, 6, 3, 3, 6, 6, 6, 6, 6, 6),
      });
      expect(events).toContainEqual(expect.objectContaining({ kind: "accidentalFall", hit: true }));
      expect(requireUnit(state, "a").position).toEqual({ col: 5, row: 9 });
      expect(requireUnit(state, "c").position).toEqual({ col: 5, row: 8 });
    });
  });
});
