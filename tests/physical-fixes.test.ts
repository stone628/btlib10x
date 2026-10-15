/**
 * Physical-combat fixes (TW pp.38,144-151): missing actuators, simultaneous
 * physical-phase pilot damage, and declaration rules.
 */
import { describe, expect, it } from "vitest";
import type { HexCoord } from "../src/core/types";
import type { BattleState, TeamId, UnitInit } from "../src/rules/game";
import {
  advancePhase,
  buildUnitInit,
  declareAttacks,
  type GameEvent,
  resolveAllAttacks,
  rollInitiativePhase,
  validateAttacks,
} from "../src/rules/game";
import { resolvePhysicalAttack, validatePhysicalAttack } from "../src/rules/physical";
import { createTestBattle, scriptedRng } from "./helpers";

const HIGH_RNG = { d6: () => 6, snapshot: () => "", load: () => {} };

type Facing = "n" | "ne" | "se" | "s" | "sw" | "nw";
const mech = (
  id: string,
  team: TeamId,
  pos: HexCoord,
  facing: Facing,
  model = "HBK-4G",
): UnitInit => buildUnitInit(id, model, team, pos, facing);

function toAttack(state: BattleState): void {
  rollInitiativePhase(state, scriptedRng(4, 4, 2, 2), []);
  advancePhase(state, [], scriptedRng());
}

describe("missing arm actuators (PHY-05)", () => {
  it("an MC-MKII-2 punch ignores the lower arm and hand it does not have", () => {
    const state = createTestBattle(
      [],
      [mech("a", 1, { col: 2, row: 2 }, "s", "MC-MKII-2"), mech("b", 2, { col: 2, row: 3 }, "n")],
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
  it("allows two punches at two targets but not mixed types", () => {
    const state = createTestBattle(
      [],
      [
        mech("a", 2, { col: 2, row: 2 }, "s"),
        mech("b", 1, { col: 2, row: 3 }, "n"),
        mech("c", 1, { col: 3, row: 2 }, "n"),
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
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
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
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      ),
    ).not.toThrow();
  });
});

describe("one physical attack per turn", () => {
  it("rejects a second kick, with either leg", () => {
    const state = createTestBattle(
      [],
      [mech("a", 2, { col: 2, row: 2 }, "s"), mech("b", 1, { col: 2, row: 3 }, "n")],
      true,
    );
    const kick = (limb: "leftLeg" | "rightLeg") => ({ type: "kick" as const, targetId: "b", limb });
    expect(() => validateAttacks(state, "a", [], [kick("leftLeg")])).not.toThrow();
    expect(() => validateAttacks(state, "a", [], [kick("leftLeg"), kick("leftLeg")])).toThrow(
      /only one kick/,
    );
    expect(() => validateAttacks(state, "a", [], [kick("leftLeg"), kick("rightLeg")])).toThrow(
      /only one kick/,
    );
  });
});

describe("simultaneous physical phase (PHY-07)", () => {
  it("a head hit does not stop the victim's own declared punch", () => {
    const state = createTestBattle(
      [],
      [mech("a", 1, { col: 2, row: 2 }, "s"), mech("b", 2, { col: 2, row: 3 }, "n")],
      true,
    );
    toAttack(state);
    declareAttacks(
      state,
      "b",
      [],
      [{ type: "punch", targetId: "a", limb: "rightArm" }],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    declareAttacks(
      state,
      "a",
      [],
      [{ type: "punch", targetId: "b", limb: "rightArm" }],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    const events: GameEvent[] = [];
    resolveAllAttacks(state, HIGH_RNG, events);
    const resolved = events.filter((e) => e.kind === "physicalAttackResolved");
    expect(resolved).toHaveLength(2);
    for (const e of resolved) {
      if (e.kind === "physicalAttackResolved") expect(e.resolution.missReason).toBeUndefined();
    }
  });
});
