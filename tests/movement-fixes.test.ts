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
  type GameEvent,
  requireUnit,
} from "../src/rules/game";
import { createTestBattle, scriptedRng } from "./helpers";

function movementBattle(model = "GRF-1N", prone = false) {
  const state = createTestBattle(
    [],
    [
      buildUnitInit("a", model, 0, { col: 5, row: 5 }, "n"),
      buildUnitInit("b", model, 1, { col: 1, row: 1 }, "s"),
    ],
    true,
    9,
    9,
  );
  state.phase = "movement";
  state.initiativeWinnerTeam = 0;
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
      ),
    ).toThrow(/shortest path|at least 1 hex/);
  });

  it("accepts a straight jump", () => {
    const state = movementBattle();
    executeMove(state, "a", "jump", [{ kind: "enter", to: { col: 5, row: 4 } }], []);
    expect(requireUnit(state, "a").position).toEqual({ col: 5, row: 4 });
  });
});

describe("jump height cap (MOV-02, TW p.53)", () => {
  it("cannot cross a level higher than Jumping MP plus the starting level", () => {
    const state = createTestBattle(
      [{ col: 5, row: 4, type: "clear", level: 6 }],
      [
        buildUnitInit("a", "GRF-1N", 0, { col: 5, row: 5 }, "n"),
        buildUnitInit("b", "GRF-1N", 1, { col: 1, row: 1 }, "s"),
      ],
      true,
      9,
      9,
    );
    state.phase = "movement";
    state.initiativeWinnerTeam = 0;
    state.actorQueue = ["a", "b"];
    state.actedThisPhase = [];
    expect(() =>
      executeMove(state, "a", "jump", [{ kind: "enter", to: { col: 5, row: 4 } }], []),
    ).toThrow(/higher than Jumping MP/);
  });

  it("clears a hill exactly as high as Jumping MP", () => {
    const state = createTestBattle(
      [{ col: 5, row: 4, type: "clear", level: 5 }],
      [
        buildUnitInit("a", "GRF-1N", 0, { col: 5, row: 5 }, "n"),
        buildUnitInit("b", "GRF-1N", 1, { col: 1, row: 1 }, "s"),
      ],
      true,
      9,
      9,
    );
    state.phase = "movement";
    state.initiativeWinnerTeam = 0;
    state.actorQueue = ["a", "b"];
    state.actedThisPhase = [];
    executeMove(state, "a", "jump", [{ kind: "enter", to: { col: 5, row: 4 } }], []);
    expect(requireUnit(state, "a").position).toEqual({ col: 5, row: 4 });
  });
});

describe("posture and jump (MOV-04)", () => {
  it("refuses a jump chained after a stand-up (spentMP carried)", () => {
    const state = movementBattle();
    expect(() =>
      executeMove(state, "a", "jump", [{ kind: "enter", to: { col: 5, row: 4 } }], [], {
        spentMP: 2,
      }),
    ).toThrow(/cannot jump/);
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
    expect(() => executeMove(state, "a", "walk", [{ kind: "turn", facings: 2 }], [])).toThrow(
      /one hexside/,
    );
    executeMove(state, "a", "walk", [{ kind: "turn", facings: 1 }], []);
    expect(a.facing).toBe("ne");
  });
});

describe("stand-up retries (MOV-06)", () => {
  it("a failed stand with MP left keeps the unit active and accumulates MP", () => {
    const state = movementBattle("HBK-4G", true);
    const a = requireUnit(state, "a");
    // stand PSR 1+1 fails; fall direction, fall location and seatbelt follow.
    const cost = attemptStandUp(state, "a", [], scriptedRng(1, 1, 1, 3, 4, 6, 6));
    expect(cost).toBe(2);
    expect(a.prone).toBe(true);
    expect(state.actedThisPhase).not.toContain("a");
    // second attempt succeeds (6+6) and the total is carried forward.
    const total = attemptStandUp(state, "a", [], scriptedRng(6, 6));
    expect(total).toBe(4);
    expect(a.prone).toBe(false);
    expect(state.actedThisPhase).toContain("a");
  });

  it("a failed stand with less than a full attempt left ends the activation", () => {
    const state = movementBattle("HBK-4G", true);
    requireUnit(state, "a").mpSpent = 1; // the stand then leaves only 1 of 4 MP
    attemptStandUp(state, "a", [], scriptedRng(1, 1, 1, 3, 4, 6, 6));
    expect(state.actedThisPhase).toContain("a");
  });
});

describe("domino effect on a movement fall (MOV-09)", () => {
  function dominoBattle() {
    const state = createTestBattle(
      [{ col: 5, row: 8, type: "rubble" }],
      [
        buildUnitInit("a", "HBK-4G", 0, { col: 5, row: 9 }, "n"),
        buildUnitInit("c", "HBK-4G", 0, { col: 5, row: 8 }, "n"),
        buildUnitInit("b", "HBK-4G", 1, { col: 1, row: 1 }, "s"),
      ],
      true,
      9,
      10,
    );
    state.phase = "movement";
    state.initiativeWinnerTeam = 0;
    state.actorQueue = ["a", "c", "b"];
    state.actedThisPhase = [];
    return state;
  }
  const walkThrough = [
    { kind: "enter" as const, to: { col: 5, row: 8 } },
    { kind: "enter" as const, to: { col: 5, row: 7 } },
  ];

  it("shoves the occupant one hex along the line of travel", () => {
    const state = dominoBattle();
    const events: GameEvent[] = [];
    // rubble PSR 1+1 fails; fall direction, location and seatbelt; then the
    // shoved unit's own piloting roll passes.
    executeMove(state, "a", "walk", walkThrough, events, {
      rng: scriptedRng(1, 1, 1, 3, 4, 6, 6, 6, 6, 6, 6, 6, 6),
    });
    const a = requireUnit(state, "a");
    const c = requireUnit(state, "c");
    expect(a.prone).toBe(true);
    expect(a.position).toEqual({ col: 5, row: 8 });
    expect(c.position).toEqual({ col: 5, row: 7 });
    expect(events).toContainEqual(expect.objectContaining({ kind: "unitDisplaced", unitId: "c" }));
  });

  it("a shoved unit that lands on a third unit shoves it in turn (chain)", () => {
    const state = createTestBattle(
      [{ col: 5, row: 8, type: "rubble" }],
      [
        buildUnitInit("a", "HBK-4G", 0, { col: 5, row: 9 }, "n"),
        buildUnitInit("c", "HBK-4G", 0, { col: 5, row: 8 }, "n"),
        buildUnitInit("d", "HBK-4G", 0, { col: 5, row: 7 }, "n"),
        buildUnitInit("b", "HBK-4G", 1, { col: 1, row: 1 }, "s"),
      ],
      true,
      9,
      10,
    );
    state.phase = "movement";
    state.initiativeWinnerTeam = 0;
    state.actorQueue = ["a", "c", "d", "b"];
    state.actedThisPhase = [];
    // The walk's second step is blocked by d, so the fall happens on the first.
    executeMove(
      state,
      "a",
      "walk",
      [
        { kind: "enter", to: { col: 5, row: 8 } },
        { kind: "enter", to: { col: 5, row: 7 } },
        { kind: "enter", to: { col: 5, row: 6 } },
      ],
      [],
      {
        rng: scriptedRng(1, 1, 1, 3, 4, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6),
      },
    );
    expect(requireUnit(state, "c").position).toEqual({ col: 5, row: 7 });
    expect(requireUnit(state, "d").position).toEqual({ col: 5, row: 6 });
    const all = Object.values(state.units).map((u) => `${u.position.col},${u.position.row}`);
    expect(new Set(all).size).toBe(all.length);
  });

  describe("accidental fall from above (TW p.152)", () => {
    function highBattle() {
      const state = createTestBattle(
        [
          { col: 5, row: 9, type: "clear", level: 2 },
          { col: 5, row: 8, type: "rubble", level: 0 },
        ],
        [
          buildUnitInit("a", "HBK-4G", 0, { col: 5, row: 9 }, "n"),
          buildUnitInit("c", "HBK-4G", 0, { col: 5, row: 8 }, "n"),
          buildUnitInit("b", "HBK-4G", 1, { col: 1, row: 1 }, "s"),
        ],
        true,
        9,
        10,
      );
      state.phase = "movement";
      state.initiativeWinnerTeam = 0;
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

    it("a hit damages the occupant and pushes it one hex away", () => {
      const state = highBattle();
      const events: GameEvent[] = [];
      executeMove(state, "a", "run", step, events, {
        rng: scriptedRng(...fall, 6, 6, 3, 3, 6, 6, 6, 6, 6, 6),
      });
      expect(events).toContainEqual(expect.objectContaining({ kind: "accidentalFall", hit: true }));
      expect(requireUnit(state, "a").position).toEqual({ col: 5, row: 8 });
      expect(requireUnit(state, "c").position).toEqual({ col: 5, row: 7 });
    });
  });
});
