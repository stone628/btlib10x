/**
 * Movement and piloting fixes: jump path validation (MOV-02), no jump after a
 * stand (MOV-04), destroyed-gyro prone turning (MOV-08), fall position
 * (MOV-10), and combined phase PSR modifiers (PSR-01).
 */
import { describe, expect, it } from "vitest";
import { mechDef } from "../src/data/index";
import { buildUnitInit, executeMove, type GameEvent, requireUnit } from "../src/rules/game";
import { createTestBattle } from "./helpers";

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
      if (slot.kind === "structure" && slot.name === "gyro") a.critSlotsDestroyed.centerTorso[i] = true;
    });
    expect(() =>
      executeMove(state, "a", "walk", [{ kind: "turn", facings: 2 }], []),
    ).toThrow(/one hexside/);
    executeMove(state, "a", "walk", [{ kind: "turn", facings: 1 }], []);
    expect(a.facing).toBe("ne");
  });
});
