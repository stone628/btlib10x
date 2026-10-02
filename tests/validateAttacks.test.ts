import { describe, expect, it } from "vitest";
import type { BattleState } from "../src/rules/game";
import {
  advancePhase,
  requireUnit,
  rollInitiativePhase,
  validateAttacksImpl,
} from "../src/rules/game";
import { createTestBattle, scriptedRng } from "./helpers";

/** initiative -> weaponAttack with nobody moving. hbk acts first (team 0). */
function startAttackTurn(state: BattleState): BattleState {
  rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
  advancePhase(state, []); // initiative -> movement
  advancePhase(state, []); // movement -> weaponAttack
  return state;
}

function hbkVsEnf(): BattleState {
  const state = createTestBattle(
    [],
    [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 4 },
        facing: "n",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 3, row: 4 },
        facing: "sw",
      },
    ],
    true,
  );
  return startAttackTurn(state);
}

function snapshotUnit(state: BattleState, id: string) {
  const u = state.units[id]!;
  return {
    declaredAttacks: u.declaredWeaponAttacks,
    firedTargetId: u.firedTargetId,
    ammoBins: u.ammoBins,
    actedThisPhase: state.actedThisPhase,
    heat: u.heat,
  };
}

describe("validateAttacks — gate coverage", () => {
  it("accepts a legal volley and returns the resolved metadata", () => {
    const state = hbkVsEnf();
    const before = snapshotUnit(state, "hbk");
    const r = validateAttacksImpl(state, "hbk", [{ weaponIndex: 2, targetId: "enf" }], [], {})!;
    expect(r.targetId).toBe("enf");
    expect(typeof r.attackDirection).toBe("string");
    expect(r.attackDistance).toBe(1);
    expect(["short", "medium", "long"]).toContain(r.attackRangeBracket);
    expect(r.attackRangeMod).toBe(0);
    expect(r.arcs[2]).toBeDefined();
    // No-mutation contract: declareAttacks side effects absent.
    expect(snapshotUnit(state, "hbk")).toEqual(before);
  });

  it("throws on weaponIndex out of range", () => {
    const state = hbkVsEnf();
    expect(() =>
      validateAttacksImpl(state, "hbk", [{ weaponIndex: 99, targetId: "enf" }], [], {}),
    ).toThrow(/weaponIndex 99 out of range/);
  });

  it("throws on duplicate weaponIndex", () => {
    const state = hbkVsEnf();
    expect(() =>
      validateAttacksImpl(
        state,
        "hbk",
        [
          { weaponIndex: 2, targetId: "enf" },
          { weaponIndex: 2, targetId: "enf" },
        ],
        [],
        {},
      ),
    ).toThrow(/may only be declared once per turn/);
  });

  it("throws on friendly target", () => {
    const state = createTestBattle(
      [],
      [
        {
          id: "a",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          piloting: 5,
          position: { col: 2, row: 4 },
          facing: "n",
        },
        {
          id: "b",
          model: "ENF-4R",
          team: 0,
          gunnery: 4,
          piloting: 5,
          position: { col: 3, row: 4 },
          facing: "sw",
        },
        {
          id: "c",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          piloting: 5,
          position: { col: 5, row: 4 },
          facing: "sw",
        },
      ],
      true,
    );
    startAttackTurn(state);
    expect(() =>
      validateAttacksImpl(state, "a", [{ weaponIndex: 1, targetId: "b" }], [], {}),
    ).toThrow(/Target must belong to another team/);
  });

  it("throws on multi-target volley", () => {
    const state = createTestBattle(
      [],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          piloting: 5,
          position: { col: 2, row: 4 },
          facing: "n",
        },
        {
          id: "enf1",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          piloting: 5,
          position: { col: 3, row: 4 },
          facing: "sw",
        },
        {
          id: "enf2",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          piloting: 5,
          position: { col: 4, row: 4 },
          facing: "sw",
        },
      ],
      true,
    );
    startAttackTurn(state);
    // Order: weapon 2 (right arm, in-arc at rightSide target) first so the
    // single-target invariant throws before the arc check on weapon 1.
    expect(() =>
      validateAttacksImpl(
        state,
        "hbk",
        [
          { weaponIndex: 2, targetId: "enf1" },
          { weaponIndex: 1, targetId: "enf2" },
        ],
        [],
        {},
      ),
    ).toThrow(/only declare attacks against one target/);
  });

  it("throws on target outside firing arc", () => {
    // hbk at (2,4) facing n; weapon 1 = left-arm medium laser. Target SE
    // (3,5) lies in the rightSide template arc — outside leftArm's arc.
    const state = createTestBattle(
      [],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          piloting: 5,
          position: { col: 2, row: 4 },
          facing: "n",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          piloting: 5,
          position: { col: 3, row: 5 },
          facing: "sw",
        },
      ],
      true,
    );
    startAttackTurn(state);
    expect(() =>
      validateAttacksImpl(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], {}),
    ).toThrow(/cannot fire into the rightSide arc/);
  });

  it("accepts a volley through a boundary arc (altArc honored)", () => {
    // hbk at (2,4) facing n, target directly north at (2,3). Bearing is N
    // (front arc); a leftArm weapon can fire into front arc. Use weapon 1
    // and add a second weapon 2 (right arm). Both face front — accepts.
    const state = createTestBattle(
      [],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          piloting: 5,
          position: { col: 2, row: 4 },
          facing: "n",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          piloting: 5,
          position: { col: 2, row: 3 },
          facing: "s",
        },
      ],
      true,
    );
    startAttackTurn(state);
    const r = validateAttacksImpl(
      state,
      "hbk",
      [
        { weaponIndex: 1, targetId: "enf" },
        { weaponIndex: 2, targetId: "enf" },
      ],
      [],
      {},
    )!;
    expect(r.attackDistance).toBe(1);
    expect(r.arcs[1]).toBe("front");
    expect(r.arcs[2]).toBe("front");
  });

  it("throws when range exceeds weapon long", () => {
    // hbk weapon 1 (medium laser) has long = 9. Place target at distance 10
    // directly north (front arc) — well inside arc, beyond range.
    const state = createTestBattle(
      [],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          piloting: 5,
          position: { col: 5, row: 15 },
          facing: "n",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          piloting: 5,
          position: { col: 5, row: 5 },
          facing: "s",
        },
      ],
      true,
      7,
      17,
    );
    startAttackTurn(state);
    expect(() =>
      validateAttacksImpl(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], {}),
    ).toThrow(/exceeds long range/);
  });

  it("throws on rapid-fire without rapidFireShots", () => {
    const state = hbkVsEnf();
    expect(() =>
      validateAttacksImpl(
        state,
        "hbk",
        [{ weaponIndex: 1, targetId: "enf", rapidFire: true }],
        [],
        {},
      ),
    ).toThrow(/is not rapid-fire/);
  });

  it("throws on empty decls list", () => {
    const state = hbkVsEnf();
    expect(() => validateAttacksImpl(state, "hbk", [], [], {})).toThrow(
      /requires at least one declaration/,
    );
  });

  it("throws on unknown target", () => {
    const state = hbkVsEnf();
    expect(() =>
      validateAttacksImpl(state, "hbk", [{ weaponIndex: 2, targetId: "ghost" }], [], {}),
    ).toThrow();
  });

  it("throws on prone two-arm volley (both arms in either order)", () => {
    const state = createTestBattle(
      [],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          piloting: 5,
          position: { col: 2, row: 4 },
          facing: "n",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          piloting: 5,
          position: { col: 2, row: 3 },
          facing: "s",
        },
      ],
      true,
    );
    startAttackTurn(state);
    requireUnit(state, "hbk").prone = true;
    expect(() =>
      validateAttacksImpl(
        state,
        "hbk",
        [
          { weaponIndex: 1, targetId: "enf" },
          { weaponIndex: 2, targetId: "enf" },
        ],
        [],
        {},
      ),
    ).toThrow(/volley uses both arms/);
    // Order-independent: arms swapped still rejects.
    expect(() =>
      validateAttacksImpl(
        state,
        "hbk",
        [
          { weaponIndex: 2, targetId: "enf" },
          { weaponIndex: 1, targetId: "enf" },
        ],
        [],
        {},
      ),
    ).toThrow(/volley uses both arms/);
  });

  it("accepts a prone single-arm volley", () => {
    const state = createTestBattle(
      [],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          piloting: 5,
          position: { col: 2, row: 4 },
          facing: "n",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          piloting: 5,
          position: { col: 2, row: 3 },
          facing: "s",
        },
      ],
      true,
    );
    startAttackTurn(state);
    requireUnit(state, "hbk").prone = true;
    const r = validateAttacksImpl(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], {})!;
    expect(r.targetId).toBe("enf");
  });

  it("does not check phase, actor queue, or sensors (session-level gates)", () => {
    // Build a state still in initiative phase.
    const state = createTestBattle(
      [],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          piloting: 5,
          position: { col: 2, row: 4 },
          facing: "n",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          piloting: 5,
          position: { col: 2, row: 3 },
          facing: "s",
        },
      ],
      true,
    );
    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []); // now initiative phase, team 0 wins
    // Phase is "initiative" — validateAttacks should still run.
    expect(() =>
      validateAttacksImpl(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], {}),
    ).not.toThrow();
  });

  it("does not consume RNG — repeated calls with same input return same metadata", () => {
    const state = hbkVsEnf();
    const a = validateAttacksImpl(state, "hbk", [{ weaponIndex: 2, targetId: "enf" }], [], {});
    const b = validateAttacksImpl(state, "hbk", [{ weaponIndex: 2, targetId: "enf" }], [], {});
    expect(a).toEqual(b);
  });

  it("twist rotates the firing arc", () => {
    // hbk facing n; target NE (rightSide). Without twist, leftArm weapon 1
    // is rejected. With twist rightSide, target shifts into front arc and
    // weapon 1 (left arm, front-allowed) accepts.
    const state = hbkVsEnf();
    expect(() =>
      validateAttacksImpl(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], {
        twist: "rightSide",
      }),
    ).not.toThrow();
  });
});
