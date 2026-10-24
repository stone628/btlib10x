import { describe, expect, it } from "vitest";
import { neighbor } from "../src/core/hex";
import type { Facing, MoveMode } from "../src/core/types";
import { mechDef } from "../src/data/index";
import type { RevealedLanding } from "../src/index";
import { setSlotDestroyed } from "../src/rules/critical";
import {
  attemptStandUp,
  buildUnitInit,
  executeMove,
  executePostureMove,
  type GameEvent,
  type PostureChange,
  postureMoveBudget,
  requireUnit,
  rollInitiativePhase,
  standUpCost,
} from "../src/rules/game";
import { pathMp } from "../src/rules/movement";
import {
  budgetFor,
  newSession,
  postureCostFor,
  requireMovementActor,
  type Session,
} from "../web/terminal/session";
import { createTestBattle, disableCritical, execute, scriptedRng } from "./helpers";

/**
 * Movement and piloting fixes: jump path validation (MOV-02), no jump after a
 * stand (MOV-04), destroyed-gyro prone turning (MOV-08), fall position
 * (MOV-10), combined phase PSR modifiers (PSR-01), stand-up free facing
 * (MOV-07, 261018), move legality (MOV-02, 261018) and the fall-back hex
 * when the origin is occupied (MOV-04, 261018).
 */

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
      if (slot.kind === "structure" && slot.type === "gyro")
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

describe("fall with the origin hex occupied (MOV-04, 261018)", () => {
  // a walks north through c (5,9) into rubble (5,8) held by d. A faller
  // that cannot share d's hex goes back the way it came; c holds the hex
  // it came from, so it ends one hex further back, in its start hex.
  function throughFriend() {
    const state = createTestBattle(
      [{ col: 5, row: 8, type: "rubble" }],
      [
        buildUnitInit("a", "HBK-4G", 1, { col: 5, row: 10 }, "n"),
        buildUnitInit("c", "HBK-4G", 1, { col: 5, row: 9 }, "n"),
        buildUnitInit("d", "HBK-4G", 1, { col: 5, row: 8 }, "n"),
        buildUnitInit("b", "HBK-4G", 2, { col: 1, row: 1 }, "s"),
      ],
      true,
      9,
      10,
    );
    state.phase = "movement";
    state.initiativeWinnerTeam = 1;
    state.actorQueue = ["a", "c", "d", "b"];
    state.actedThisPhase = [];
    return state;
  }
  const path = [
    { kind: "enter" as const, to: { col: 5, row: 9 } },
    { kind: "enter" as const, to: { col: 5, row: 8 } },
    { kind: "enter" as const, to: { col: 5, row: 7 } },
  ];

  it("goes back to the newest free hex of its path, never onto a friend", () => {
    const state = throughFriend();
    const events: GameEvent[] = [];
    // rubble PSR 1+1 fails; fall direction, location and seatbelt.
    executeMove(state, "a", "walk", path, events, {
      rng: scriptedRng(1, 1, 1, 3, 4, 6, 6, 6, 6, 6, 6, 6, 6),
    });
    const a = requireUnit(state, "a");
    expect(a.prone).toBe(true);
    expect(a.position).toEqual({ col: 5, row: 10 });
    expect(requireUnit(state, "c").position).toEqual({ col: 5, row: 9 });
    expect(requireUnit(state, "d").position).toEqual({ col: 5, row: 8 });
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "moved", unitId: "a", position: { col: 5, row: 10 } }),
    );
  });

  it("a crash fall in a building a friend stands in ends outside it", () => {
    const state = createTestBattle(
      [{ col: 2, row: 3, type: "heavyBuilding" }],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 8, row: 8 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 4 }, "n"),
        buildUnitInit("ally", "ENF-4R", 2, { col: 2, row: 3 }, "n"),
      ],
      true,
    );
    state.phase = "movement";
    state.initiativeWinnerTeam = 1;
    state.actorQueue = ["enf", "ally", "hbk"];
    state.actedThisPhase = [];
    const enf = requireUnit(state, "enf");
    enf.damage.armor.rightLeg = 0;
    enf.damage.internalStructure.rightLeg = 1;
    // Building entry PSR 1+1 fails; crash groups hit the right leg (1+4)
    // and right arm (1+3); the lost leg drops the 'Mech in the building.
    executeMove(
      state,
      "enf",
      "run",
      [
        { kind: "enter", to: { col: 2, row: 3 } },
        { kind: "enter", to: { col: 2, row: 2 } },
      ],
      [],
      { rng: scriptedRng(1, 1, 1, 4, 1, 3, 1, 3, 4, 4, 5, 6, 6) },
    );
    expect(enf.prone).toBe(true);
    expect(enf.position).toEqual({ col: 2, row: 4 });
    expect(requireUnit(state, "ally").position).toEqual({ col: 2, row: 3 });
  });
});

describe("stand-up free facing (MOV-07, TW p.50)", () => {
  // GRF-1N walks 5: the stand takes 2, three MP remain.
  const south = { kind: "enter" as const, to: { col: 5, row: 6 } };

  it("turns for free before the first hex entry", () => {
    const state = movementBattle("GRF-1N", true);
    executePostureMove(state, "a", "standUp", "walk", [{ kind: "turn", facings: 3 }, south], [], {
      rng: scriptedRng(6, 6),
    });
    const a = requireUnit(state, "a");
    expect(a.position).toEqual({ col: 5, row: 6 });
    expect(a.facing).toBe("s");
    expect(a.mpSpent).toBe(3);
  });

  it("still charges turns after the first hex entry", () => {
    const state = movementBattle("GRF-1N", true);
    expect(() =>
      executePostureMove(
        state,
        "a",
        "standUp",
        "walk",
        [
          { kind: "enter", to: { col: 5, row: 4 } },
          { kind: "turn", facings: 3 },
        ],
        [],
        { rng: scriptedRng(6, 6) },
      ),
    ).toThrow(/costs 4 MP but only 3/);
  });

  it("gives a Minimum Movement stand its free facing but no hex", () => {
    const turned = movementBattle("GRF-1N", true);
    requireUnit(turned, "a").heat = 20; // walking 1: the stand uses it all
    executePostureMove(turned, "a", "standUp", "walk", [{ kind: "turn", facings: 3 }], [], {
      rng: scriptedRng(6, 6),
    });
    expect(requireUnit(turned, "a").facing).toBe("s");
    expect(requireUnit(turned, "a").mpSpent).toBe(1);

    const moved = movementBattle("GRF-1N", true);
    requireUnit(moved, "a").heat = 20;
    expect(() =>
      executePostureMove(moved, "a", "standUp", "walk", [{ kind: "turn", facings: 3 }, south], [], {
        rng: scriptedRng(6, 6),
      }),
    ).toThrow(/only 0 of the walk budget/);
  });
});

describe("move legality (MOV-02, 261018)", () => {
  function crowdedBattle() {
    const state = createTestBattle(
      [],
      [
        buildUnitInit("a", "GRF-1N", 1, { col: 5, row: 5 }, "n"),
        buildUnitInit("c", "GRF-1N", 1, { col: 5, row: 4 }, "n"),
        buildUnitInit("b", "GRF-1N", 2, { col: 5, row: 2 }, "s"),
      ],
      true,
      9,
      9,
    );
    state.phase = "movement";
    state.initiativeWinnerTeam = 1;
    state.actorQueue = ["a", "c", "b"];
    state.actedThisPhase = [];
    return state;
  }
  const enter = (col: number, row: number) => ({ kind: "enter" as const, to: { col, row } });

  it("refuses a walk or jump off the board", () => {
    const north = [enter(5, 4), enter(5, 3), enter(5, 2), enter(5, 1), enter(5, 0)];
    expect(() =>
      executeMove(movementBattle(), "a", "walk", north, [], { rng: scriptedRng() }),
    ).toThrow(/off the board/);
    expect(() =>
      executeMove(movementBattle(), "a", "jump", north, [], { rng: scriptedRng() }),
    ).toThrow(/off the board/);
    const state = movementBattle();
    executeMove(state, "a", "walk", north.slice(0, 4), [], { rng: scriptedRng() });
    expect(requireUnit(state, "a").position).toEqual({ col: 5, row: 1 });
  });

  it("checks stacking in the last hex entered, even when a turn follows", () => {
    expect(() =>
      executeMove(crowdedBattle(), "a", "walk", [enter(5, 4), { kind: "turn", facings: 1 }], [], {
        rng: scriptedRng(),
      }),
    ).toThrow(/occupied by c/);
    const state = crowdedBattle();
    executeMove(state, "a", "walk", [enter(5, 4), enter(5, 3), { kind: "turn", facings: 1 }], [], {
      rng: scriptedRng(),
    });
    expect(requireUnit(state, "a").position).toEqual({ col: 5, row: 3 });
  });

  it("refuses steps after the hex that declares a charge", () => {
    const steps = [enter(5, 4), enter(5, 3), enter(5, 2), { kind: "turn" as const, facings: 1 }];
    expect(() =>
      executeMove(crowdedBattle(), "a", "walk", steps, [], { rng: scriptedRng() }),
    ).toThrow(/A charge or DFA ends the move/);
  });

  it("allows finalFacing only for a jump landing or a stand-up facing pick", () => {
    expect(() =>
      executeMove(movementBattle(), "a", "walk", [enter(5, 4)], [], {
        finalFacing: "s",
        rng: scriptedRng(),
      }),
    ).toThrow(/finalFacing applies only/);
    const prone = movementBattle("GRF-1N", true);
    expect(() =>
      executePostureMove(prone, "a", "standUp", "walk", [enter(5, 4)], [], {
        finalFacing: "s",
        rng: scriptedRng(6, 6),
      }),
    ).toThrow(/finalFacing applies only/);
    const state = movementBattle();
    executeMove(state, "a", "jump", [enter(5, 4)], [], { finalFacing: "s", rng: scriptedRng() });
    expect(requireUnit(state, "a").facing).toBe("s");
  });
});

describe("move input validation (MOV-08, 261022)", () => {
  const north = { kind: "enter" as const, to: { col: 5, row: 4 } };

  it("refuses an unknown movement mode instead of dropping the MP budget", () => {
    for (const mode of ["fly", undefined, "WALK"]) {
      const state = movementBattle();
      expect(() =>
        executeMove(state, "a", mode as unknown as MoveMode, [north], [], { rng: scriptedRng() }),
      ).toThrow(/Unknown movement mode/);
      expect(requireUnit(state, "a").position).toEqual({ col: 5, row: 5 });
    }
  });

  it("refuses a finalFacing outside the six facings", () => {
    for (const bad of ["x", "N", 2]) {
      const state = movementBattle();
      expect(() =>
        executeMove(state, "a", "jump", [north], [], {
          finalFacing: bad as unknown as Facing,
          rng: scriptedRng(),
        }),
      ).toThrow(/Invalid finalFacing/);
      expect(requireUnit(state, "a").facing).toBe("n");
    }
  });

  it("refuses a bad posture move before the stand or drop resolves", () => {
    const cases: [string, string, Facing | undefined][] = [
      ["crouch", "walk", undefined],
      ["standUp", "fly", undefined],
      ["standUp", "walk", "zz" as Facing],
    ];
    for (const [posture, locomotion, finalFacing] of cases) {
      const state = movementBattle("GRF-1N", true);
      expect(() =>
        executePostureMove(
          state,
          "a",
          posture as PostureChange,
          locomotion as MoveMode,
          [],
          [],
          finalFacing === undefined
            ? { rng: scriptedRng(6, 6) }
            : { finalFacing, rng: scriptedRng(6, 6) },
        ),
      ).toThrow(/Unknown posture change|Unknown movement mode|Invalid finalFacing/);
      const a = requireUnit(state, "a");
      expect(a.prone).toBe(true);
      expect(a.heat).toBe(0);
    }
    const standing = movementBattle();
    expect(() =>
      executePostureMove(standing, "a", undefined as unknown as PostureChange, "walk", [], [], {
        rng: scriptedRng(),
      }),
    ).toThrow(/Unknown posture change/);
    expect(requireUnit(standing, "a").prone).toBe(false);
  });
});

describe("postureMove", () => {
  /** Started quickstart battle; returns session plus acting-unit id. */
  function started(piloting?: number, model = "HBK-4G"): { s: Session; actor: string } {
    const s = newSession(7);
    expect(execute(s, "map quickstart")[0]).toContain("15x16");
    const pilotArg = piloting === undefined ? "" : ` ${piloting}`;
    // NB: facing token before piloting per `add` arg parsing. Both units share
    // model + piloting so either initiative winner can run the script.
    expect(execute(s, `add hunchy ${model} 9 9 n${pilotArg}`)).toHaveLength(1);
    expect(execute(s, `add cicada ${model} 9 8 s${pilotArg}`)).toHaveLength(1);
    expect(execute(s, "start")[0]).toContain("BATTLE STARTED");
    disableCritical(s);
    return { s, actor: requireMovementActor(s).id };
  }

  function forceProne(s: Session, id: string): void {
    s.battle!.units[id]!.prone = true;
  }

  /** First candidate landing with actual steps (skips the in-place facing set). */
  function steppedLanding(s: Session): { col: number; row: number; facing: string; spent: number } {
    const landings = s.move!.moveCandidate!.revealed;
    const landing = landings.find((l: { path: readonly unknown[] }) => l.path.length > 0)!;
    expect(landing).toBeDefined();
    return {
      col: landing.hex.col,
      row: landing.hex.row,
      facing: landing.facing,
      spent: pathMp(landing.path),
    };
  }

  describe("posture-change then move", () => {
    it("rejects unknown and standing-only modes while prone with the valid-modes hint", async () => {
      const { s } = await started();
      forceProne(s, requireMovementActor(s).id);
      expect(execute(s, "mode standup foo")[0]).toMatch(/^error:/);
      expect(execute(s, "mode walk")[0]).toMatch(/valid modes:/);
    });

    it("bare mode standup + done stands in place with no candidate map", async () => {
      // Piloting 0 → PSR target 0 → auto-success, no RNG drawn.
      const { s, actor } = await started(0);
      forceProne(s, actor);
      const from = { ...s.battle!.units[actor]!.position };
      const facing = s.battle!.units[actor]!.facing;
      execute(s, "mode standup");
      expect(s.move!.moveMode).toBe("standup");
      expect(s.move!.postureMove).toBe("standStill");
      expect(s.move!.moveCandidate?.revealed).toStrictEqual([] as RevealedLanding[]);
      expect(execute(s, "place 9 9 n")[0]).toMatch(/^error:/);
      execute(s, "done");
      const unit = s.battle!.units[actor]!;
      expect(unit.prone).toBe(false);
      expect(unit.position).toEqual(from);
      expect(unit.facing).toBe(facing);
      expect(unit.moveMode).toBe("walk");
      expect(unit.mpSpent).toBe(2);
    });

    it("bare mode prone defaults to turn; prone turn + place turns sharing one walk budget", async () => {
      const { s, actor } = await started();
      execute(s, "mode prone");
      expect(s.move!.moveMode).toBe("prone");
      expect(s.move!.postureMove).toBe("walk");
      expect(s.move!.moveCandidate).not.toBeNull();
      // Turn-only map: every landing stays in place.
      for (const l of s.move!.moveCandidate!.revealed) {
        expect(l.hex).toEqual(s.battle!.units[actor]!.position);
      }
      const before = s.battle!.units[actor]!;
      const landing = s.move!.moveCandidate!.revealed.find((l) => l.facing !== before.facing)!;
      expect(landing).toBeDefined();
      const spent = pathMp(landing.path);
      execute(s, `place ${landing.hex.col} ${landing.hex.row} ${landing.facing}`);
      const heatBefore = s.battle!.units[actor]!.heat;
      execute(s, "done");
      const unit = s.battle!.units[actor]!;
      expect(unit.prone).toBe(true);
      expect(unit.position).toEqual(before.position);
      expect(unit.facing).toBe(landing.facing);
      expect(unit.moveMode).toBe("walk");
      expect(unit.mpSpent).toBe(1 + spent); // drop 1 + turn fragments
      expect(unit.heat).toBe(heatBefore); // deferred until heat phase
      expect(unit.heatPending).toBe(1); // drop 0 + turn 1
    });

    it("mode prone pronestill drops in place with no candidate map", async () => {
      const { s, actor } = await started();
      execute(s, "mode prone pronestill");
      expect(s.move!.moveMode).toBe("prone");
      expect(s.move!.postureMove).toBe("standStill");
      expect(s.move!.moveCandidate?.revealed).toStrictEqual([] as RevealedLanding[]);
      expect(execute(s, `place 9 9 n`)[0]).toMatch(/^error:/);
      const heatBefore = s.battle!.units[actor]!.heat;
      execute(s, "done");
      const unit = s.battle!.units[actor]!;
      expect(unit.prone).toBe(true);
      expect(unit.mpSpent).toBe(1);
      expect(unit.heat).toBe(heatBefore); // drop only, no heat
    });

    it("prone mode turn + place turns in place with +1 heat", async () => {
      const { s, actor } = await started();
      forceProne(s, actor);
      const before = s.battle!.units[actor]!;
      execute(s, "mode turn");
      expect(s.move!.moveMode).toBe("turn");
      expect(s.move!.moveCandidate).not.toBeNull();
      const landing = s.move!.moveCandidate!.revealed.find((l) => l.facing !== before.facing)!;
      expect(landing).toBeDefined();
      expect(landing.hex).toEqual(before.position);
      execute(s, `place ${landing.hex.col} ${landing.hex.row} ${landing.facing}`);
      const heatBefore = s.battle!.units[actor]!.heat;
      execute(s, "done");
      const unit = s.battle!.units[actor]!;
      expect(unit.prone).toBe(true);
      expect(unit.position).toEqual(before.position);
      expect(unit.facing).toBe(landing.facing);
      expect(unit.moveMode).toBe("walk");
      expect(unit.heat).toBe(heatBefore);
      expect(unit.heatPending).toBe(1);
    });

    it("prone mode pronestill holds with no heat and no candidate", async () => {
      const { s, actor } = await started();
      forceProne(s, actor);
      execute(s, "mode pronestill");
      expect(s.move!.moveMode).toBe("pronestill");
      expect(s.move!.moveCandidate?.revealed).toStrictEqual([] as RevealedLanding[]);
      expect(execute(s, "place 9 9 n")[0]).toMatch(/^error:/);
      const heatBefore = s.battle!.units[actor]!.heat;
      execute(s, "done");
      const unit = s.battle!.units[actor]!;
      expect(unit.prone).toBe(true);
      expect(unit.heat).toBe(heatBefore);
    });

    it("standing mode turn/pronestill are rejected with the valid-modes hint", async () => {
      const { s } = await started();
      expect(execute(s, "mode turn")[0]).toMatch(/valid modes:/);
      expect(execute(s, "mode pronestill")[0]).toMatch(/valid modes:/);
    });

    it("mode prone + done without place just drops in place", async () => {
      const { s, actor } = await started();
      const from = { ...s.battle!.units[actor]!.position };
      execute(s, "mode prone");
      execute(s, "done");
      const unit = s.battle!.units[actor]!;
      expect(unit.prone).toBe(true);
      expect(unit.position).toEqual(from);
      expect(unit.mpSpent).toBe(1);
    });

    it("in-place turn via place covers the old turn command", async () => {
      const { s, actor } = await started();
      const before = s.battle!.units[actor]!;
      const from = { ...before.position };
      execute(s, "mode prone");
      const landing = s.move!.moveCandidate!.revealed.find(
        (l) => l.hex.col === from.col && l.hex.row === from.row && l.facing !== before.facing,
      )!;
      expect(landing).toBeDefined();
      const spent = pathMp(landing.path);
      execute(s, `place ${landing.hex.col} ${landing.hex.row} ${landing.facing}`);
      execute(s, "done");
      const unit = s.battle!.units[actor]!;
      expect(unit.prone).toBe(true);
      expect(unit.position).toEqual(from);
      expect(unit.facing).toBe(landing.facing);
      expect(unit.mpSpent).toBe(1 + spent); // drop 1 + turn fragments
      expect(execute(s, "turn left")[0]).toMatch(/^error:/);
    });

    it("mode standup walk + place stands then moves (stand 2 + steps)", async () => {
      // Piloting 0 → PSR target 0 → auto-success, no RNG drawn.
      const { s, actor } = await started(0);
      forceProne(s, actor);
      execute(s, "mode standup walk");
      expect(s.move!.moveMode).toBe("standup");
      expect(s.move!.postureMove).toBe("walk");
      expect(s.move!.moveCandidate).not.toBeNull();
      const target = steppedLanding(s);
      execute(s, `place ${target.col} ${target.row} ${target.facing}`);
      s.rng = scriptedRng(...Array.from({ length: 40 }, () => 6));
      execute(s, "done");
      const unit = s.battle!.units[actor]!;
      expect(unit.prone).toBe(false);
      expect(unit.position).toEqual({ col: target.col, row: target.row });
      expect(unit.moveMode).toBe("walk");
      expect(unit.mpSpent).toBe(2 + target.spent);
    });

    it("mode standup jump is rejected: a 'Mech that stood cannot jump (TW p.49)", async () => {
      const { s, actor } = await started(0, "GRF-1N");
      forceProne(s, actor);
      expect(execute(s, "mode standup jump")[0]).toMatch(/^error:/);
      expect(s.battle!.units[actor]!.prone).toBe(true);
    });

    it("standing up to walk charges the stand heat plus the walk heat (HEAT-03)", async () => {
      const { s, actor } = await started(0);
      forceProne(s, actor);
      execute(s, "mode standup walk");
      const target = steppedLanding(s);
      execute(s, `place ${target.col} ${target.row} ${target.facing}`);
      s.rng = scriptedRng(...Array.from({ length: 40 }, () => 6));
      execute(s, "done");
      expect(s.battle!.units[actor]!.heatPending).toBe(2);
    });

    it("failed standup discards the queued place and ends the activation", async () => {
      const { s, actor } = await started(4);
      forceProne(s, actor);
      const from = { ...s.battle!.units[actor]!.position };
      execute(s, "mode standup walk");
      const target = steppedLanding(s);
      execute(s, `place ${target.col} ${target.row} ${target.facing}`);
      expect(s.move!.moveSteps.length).toBeGreaterThan(0);
      // Natural 2 on the PSR always fails; over-provision fall dice.
      s.rng = scriptedRng(1, 1, ...Array.from({ length: 30 }, () => 3));
      execute(s, "done");
      const unit = s.battle!.units[actor]!;
      expect(unit.prone).toBe(true);
      expect(unit.position).toEqual(from);
      expect(s.move!.moveMode).toBeNull();
      expect(s.move!.moveSteps).toHaveLength(0);
      expect(s.move!.placedLanding).toBeNull();
    });

    it("candidate landings fit the shared (reduced) budget", async () => {
      const { s, actor } = await started(0);
      forceProne(s, actor);
      execute(s, "mode standup walk");
      const budget = budgetFor(requireMovementActor(s), s.move!);
      for (const landing of s.move!.moveCandidate!.revealed) {
        expect(pathMp(landing.path)).toBeLessThanOrEqual(budget);
      }
    });

    it("a 1-MP stand charges only the walking budget it has (TW p.50)", async () => {
      const { s, actor } = await started(0);
      forceProne(s, actor);
      // HBK-4G walks 4; heat 15 cuts walking to 1, running to 2 (TW p.159).
      s.battle!.units[actor]!.heat = 15;
      execute(s, "mode standup run");
      expect(postureCostFor(s)).toBe(1);
      // A Minimum Movement stand is the turn's only MP expenditure (TW p.49):
      // nothing is left of the running budget.
      expect(budgetFor(requireMovementActor(s), s.move!)).toBe(0);
    });

    it("standup offers the start hex in every facing for free (TW p.50)", async () => {
      const { s, actor } = await started(0);
      forceProne(s, actor);
      const from = { ...s.battle!.units[actor]!.position };
      execute(s, "mode standup walk");
      const revealed = s.move!.moveCandidate!.revealed;
      const startEntries = revealed.filter(
        (l: { hex: { col: number; row: number } }) =>
          l.hex.col === from.col && l.hex.row === from.row,
      );
      const facings = new Set(startEntries.map((l: { facing: string }) => l.facing));
      for (const f of ["n", "ne", "se", "s", "sw", "nw"]) {
        expect(facings.has(f)).toBe(true);
        const entry = startEntries.find((l: { facing: string }) => l.facing === f);
        expect(entry?.path).toEqual([]);
      }
    });

    it("standup + place picks a free facing: no MP turn, no steps (TW p.50)", async () => {
      const { s, actor } = await started(0);
      forceProne(s, actor);
      const from = { ...s.battle!.units[actor]!.position };
      const unitFacing = s.battle!.units[actor]!.facing;
      // Pick a non-unit facing — otherwise it's the stay-in-place pick (no
      // facing change) and `moveFinalFacing` stays null.
      const freeFacing = unitFacing === "n" ? "s" : "n";
      execute(s, "mode standup walk");
      execute(s, `place ${from.col} ${from.row} ${freeFacing}`);
      expect(s.move!.moveSteps).toEqual([]);
      expect(s.move!.moveFinalFacing).toBe(freeFacing);
      s.rng = scriptedRng(...Array.from({ length: 40 }, () => 6));
      execute(s, "done");
      const unit = s.battle!.units[actor]!;
      expect(unit.prone).toBe(false);
      expect(unit.position).toEqual(from);
      expect(unit.facing).toBe(freeFacing);
      // 2 MP for standing; no MP charged for the free facing pick.
      expect(unit.mpSpent).toBe(2);
    });

    it("standup + place leaves the hex in a free facing (MOV-07, TW p.50)", async () => {
      const { s, actor } = await started(0);
      forceProne(s, actor);
      execute(s, "mode standup walk");
      // A landing off the start hex whose path opens with the free turn.
      const landing = s.move!.moveCandidate!.revealed.find(
        (l) =>
          l.melee === undefined &&
          l.path.length > 1 &&
          l.path[0]!.baseMp === 0 &&
          l.path.some((step) => step.fragment === "F"),
      )!;
      expect(landing).toBeDefined();
      execute(s, `place ${landing.hex.col} ${landing.hex.row} ${landing.facing}`);
      expect(s.move!.moveFinalFacing).toBeNull();
      s.rng = scriptedRng(...Array.from({ length: 40 }, () => 6));
      execute(s, "done");
      const unit = s.battle!.units[actor]!;
      expect(unit.position).toEqual(landing.hex);
      expect(unit.facing).toBe(landing.facing);
      const paid = landing.path.reduce((n, step) => n + step.baseMp, 0);
      expect(unit.mpSpent).toBe(2 + paid);
    });
  });

  describe("engine prone turn", () => {
    function proneBattle(): ReturnType<typeof createTestBattle> {
      const state = createTestBattle(
        [],
        [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 3, row: 3 }, "n"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 5, row: 5 }, "s"),
        ],
        true,
      );
      rollInitiativePhase(state, scriptedRng(3, 3, 4, 4), []);
      return state;
    }

    it("turns in place for 1 MP per hexside, multiple turns allowed", async () => {
      const state = proneBattle();
      requireUnit(state, "hbk").prone = true;
      executeMove(
        state,
        "hbk",
        "walk",
        [
          { kind: "turn", facings: 1 },
          { kind: "turn", facings: 1 },
        ],
        [],
        { rng: scriptedRng() },
      );
      const unit = state.units.hbk!;
      expect(unit.prone).toBe(true);
      expect(unit.position).toEqual({ col: 3, row: 3 });
      expect(unit.facing).toBe("se");
      expect(unit.mpSpent).toBe(2);
      expect(unit.hexesMovedThisTurn).toBe(0);
    });

    it("rejects hex enters while prone", async () => {
      const state = proneBattle();
      const to = neighbor({ col: 3, row: 3 }, "n");
      requireUnit(state, "hbk").prone = true;
      expect(() =>
        executeMove(state, "hbk", "walk", [{ kind: "enter", to }], [], { rng: scriptedRng() }),
      ).toThrow(/turn or pronestill only/);
    });

    it("rejects zero-hex jump declarations", async () => {
      const state = proneBattle();
      expect(() => executeMove(state, "hbk", "jump", [], [], { rng: scriptedRng() })).toThrow(
        /at least 1 hex/,
      );
    });
  });
});
