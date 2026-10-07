/**
 * Physical-combat fixes (TW pp.38,144-151): push displacement legality,
 * levels fallen, shut-down push targets, missing actuators, simultaneous
 * physical-phase pilot damage, and declaration rules.
 */
import { describe, expect, it } from "vitest";
import type { HexCoord } from "../src/core/types";
import type { BattleState, UnitInit } from "../src/rules/game";
import {
  advancePhase,
  buildUnitInit,
  declareAttacks,
  type GameEvent,
  requireUnit,
  resolveAllAttacks,
  rollInitiativePhase,
} from "../src/rules/game";
import {
  pushDisplacementOutcome,
  resolvePhysicalAttack,
  validatePhysicalAttack,
} from "../src/rules/physical";
import { createTestBattle, scriptedRng } from "./helpers";

const HIGH_RNG = { d6: () => 6, snapshot: () => "", load: () => {} };

type Facing = "n" | "ne" | "se" | "s" | "sw" | "nw";
const mech = (id: string, team: number, pos: HexCoord, facing: Facing, model = "HBK-4G"): UnitInit =>
  buildUnitInit(id, model, team, pos, facing);

function toAttack(state: BattleState): void {
  rollInitiativePhase(state, scriptedRng(4, 4, 2, 2), []);
  advancePhase(state, []);
}

/** a (team 0) pushes b (team 1) toward the south edge of a 3x`height` board. */
function pushSetup(
  terrain: Parameters<typeof createTestBattle>[0],
  aRow: number,
  height: number,
  extra: UnitInit[] = [],
): BattleState {
  return createTestBattle(
    terrain,
    [mech("a", 0, { col: 2, row: aRow }, "s"), mech("b", 1, { col: 2, row: aRow + 1 }, "n"), ...extra],
    true,
    3,
    height,
  );
}

describe("push displacement (PHY-01)", () => {
  it("classifies off-board, occupied, too-high and cliff destinations", () => {
    const state = pushSetup(
      [
        { col: 2, row: 4, type: "clear", level: 3 },
        { col: 1, row: 3, type: "clear", level: -3 },
      ],
      2,
      4,
      [mech("c", 1, { col: 1, row: 1 }, "s")],
    );
    const b = requireUnit(state, "b");
    expect(pushDisplacementOutcome(state, b, { col: 2, row: 5 })).toEqual({ kind: "offBoard" });
    expect(pushDisplacementOutcome(state, b, { col: 1, row: 1 }).kind).toBe("blocked");
    expect(pushDisplacementOutcome(state, b, { col: 2, row: 4 }).kind).toBe("blocked");
    expect(pushDisplacementOutcome(state, b, { col: 1, row: 3 })).toEqual({
      kind: "cliff",
      levels: 3,
    });
  });

  it("a unit pushed off the map is destroyed as displacedOffBoard", () => {
    const state = pushSetup([], 3, 4);
    toAttack(state);
    declareAttacks(state, "b", [], [{ type: "punch", targetId: "a", limb: "rightArm" }], []);
    declareAttacks(state, "a", [], [{ type: "push", targetId: "b" }], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, HIGH_RNG, events);
    const b = requireUnit(state, "b");
    expect(b.removed).toBe("destroyed");
    expect(b.destroyed).toBe("displacedOffBoard");
  });

  it("an occupied destination blocks the push: neither unit moves", () => {
    const state = pushSetup([], 1, 4, [mech("c", 1, { col: 2, row: 3 }, "n")]);
    const res = resolvePhysicalAttack(state, "a", { type: "push", targetId: "b" }, HIGH_RNG);
    expect(res.targetDisplacedTo).toBeNull();
    expect(res.attackerDisplacedTo).toBeNull();
  });

  it("a drop of more than two levels is an automatic fall carrying the levels", () => {
    const state = pushSetup([{ col: 2, row: 3, type: "clear", level: -3 }], 1, 4);
    const res = resolvePhysicalAttack(state, "a", { type: "push", targetId: "b" }, HIGH_RNG);
    expect(res.hit).toBe(true);
    expect(res.targetDisplacedTo).toEqual({ col: 2, row: 3 });
    expect(res.targetFalls).toBe(true);
    expect(res.targetPsr).toBeNull();
    expect(res.displacementLevels).toBe(3);
  });
});

describe("push PSR (PHY-03)", () => {
  it("a shut-down push target fails its piloting roll automatically", () => {
    const state = pushSetup([], 1, 4);
    requireUnit(state, "b").shutdown = "heat";
    const res = resolvePhysicalAttack(state, "a", { type: "push", targetId: "b" }, HIGH_RNG);
    expect(res.targetFalls).toBe(true);
    expect(res.targetPsr?.success).toBe(false);
  });
});

describe("missing arm actuators (PHY-05)", () => {
  it("an MC-MKII-2 punch ignores the lower arm and hand it does not have", () => {
    const state = createTestBattle(
      [],
      [
        mech("a", 0, { col: 2, row: 2 }, "s", "MC-MKII-2"),
        mech("b", 1, { col: 2, row: 3 }, "n"),
      ],
      true,
    );
    const res = resolvePhysicalAttack(
      state,
      "a",
      { type: "punch", targetId: "b", limb: "rightArm" },
      HIGH_RNG,
    );
    expect(res.toHit).toBe(8);
    expect(res.damageToTarget.reduce((n, g) => n + g.damage, 0)).toBe(4);
  });
});

describe("declaration rules (PHY-10, PHY-11)", () => {
  it("rejects a second push against the same target in one turn", () => {
    const state = createTestBattle(
      [],
      [
        mech("a", 1, { col: 2, row: 2 }, "s"),
        mech("c", 1, { col: 2, row: 4 }, "n"),
        mech("b", 0, { col: 2, row: 3 }, "n"),
      ],
      true,
    );
    toAttack(state);
    state.actorQueue = ["a", "c", "b"];
    declareAttacks(state, "a", [], [{ type: "push", targetId: "b" }], []);
    expect(() => declareAttacks(state, "c", [], [{ type: "push", targetId: "b" }], [])).toThrow(
      /already the target of a push/,
    );
  });

  it("allows two punches at two targets but not mixed types", () => {
    const state = createTestBattle(
      [],
      [
        mech("a", 1, { col: 2, row: 2 }, "s"),
        mech("b", 0, { col: 2, row: 3 }, "n"),
        mech("c", 0, { col: 3, row: 2 }, "n"),
      ],
      true,
    );
    expect(
      validatePhysicalAttack(state, "a", { type: "punch", targetId: "b", limb: "rightArm" }).ok,
    ).toBe(true);
    toAttack(state);
    state.actorQueue = ["a", "b", "c"];
    expect(() =>
      declareAttacks(
        state,
        "a",
        [],
        [
          { type: "punch", targetId: "b", limb: "leftArm" },
          { type: "kick", targetId: "c", limb: "rightLeg" },
        ],
        [],
      ),
    ).toThrow(/one type/);
    expect(() =>
      declareAttacks(
        state,
        "a",
        [],
        [
          { type: "punch", targetId: "b", limb: "rightArm" },
          { type: "punch", targetId: "c", limb: "leftArm" },
        ],
        [],
      ),
    ).not.toThrow();
  });
});

describe("simultaneous physical phase (PHY-07)", () => {
  it("a head hit does not stop the victim's own declared punch", () => {
    const state = createTestBattle(
      [],
      [mech("a", 0, { col: 2, row: 2 }, "s"), mech("b", 1, { col: 2, row: 3 }, "n")],
      true,
    );
    toAttack(state);
    declareAttacks(state, "b", [], [{ type: "punch", targetId: "a", limb: "rightArm" }], []);
    declareAttacks(state, "a", [], [{ type: "punch", targetId: "b", limb: "rightArm" }], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, HIGH_RNG, events);
    const resolved = events.filter((e) => e.kind === "physicalAttackResolved");
    expect(resolved).toHaveLength(2);
    for (const e of resolved) {
      if (e.kind === "physicalAttackResolved") expect(e.resolution.missReason).toBeUndefined();
    }
  });
});
