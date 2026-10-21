import { describe, expect, it } from "vitest";
import { secondaryTargetModifier } from "../src/rules/arcs";
import type { GameEvent, WeaponAttackDecl } from "../src/rules/game";
import {
  advancePhase,
  buildUnitInit,
  declareAttacks,
  resolveAllAttacks,
  rollInitiativePhase,
  validateAttacksImpl,
} from "../src/rules/game";
import { toHitTotal } from "../src/rules/tohit";
import { createTestBattle, scriptedRng, seededRng } from "./helpers";

// HBK-4G weapons (1-based): 1 = left-arm ML, 2 = right-arm ML, 3 = head SL, 4 = RT AC/20.
// Attacker at (4,6) facing north. Target hexes (verified against
// classifyFiringArc): (4,3) and (5,3) front, (2,6) leftSide, (6,6) rightSide.
const FRONT_A = { col: 4, row: 3 };
const FRONT_B = { col: 5, row: 3 };
const LEFT = { col: 2, row: 6 };
const RIGHT = { col: 6, row: 6 };

function setup() {
  const state = createTestBattle(
    [],
    [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 4, row: 6 }, "n"),
      buildUnitInit("fa", "ENF-4R", 2, FRONT_A, "s"),
      buildUnitInit("fb", "ENF-4R", 2, FRONT_B, "s"),
      buildUnitInit("l", "ENF-4R", 2, LEFT, "s"),
      buildUnitInit("r", "ENF-4R", 2, RIGHT, "s"),
    ],
    true,
  );
  rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
  advancePhase(state, [], scriptedRng());
  return state;
}

const w = (weaponIndex: number, targetId: string): WeaponAttackDecl => ({ weaponIndex, targetId });

describe("multiple targets (TW p.108)", () => {
  it("defaults the primary to the first target; a forward-arc secondary is +1", () => {
    const r = validateAttacksImpl(setup(), "hbk", [w(1, "fa"), w(2, "fb")]);
    expect(r.primaryTargetId).toBe("fa");
    expect(r.targets.map((t) => t.secondaryMod)).toEqual([0, 1]);
  });

  it("makes a forward-arc target primary when the first target is not", () => {
    const r = validateAttacksImpl(setup(), "hbk", [w(1, "l"), w(3, "fa")]);
    expect(r.primaryTargetId).toBe("fa");
    expect(r.targets.find((t) => t.targetId === "l")!.secondaryMod).toBe(2);
  });

  it("applies +2 to a side-arc secondary and does not stack on later targets", () => {
    const r = validateAttacksImpl(setup(), "hbk", [w(3, "fa"), w(1, "l"), w(2, "r")]);
    expect(r.targets.map((t) => t.secondaryMod)).toEqual([0, 2, 2]);
  });

  it("lets any target be primary when none is in the forward arc", () => {
    const decls = [w(1, "l"), w(2, "r")];
    expect(validateAttacksImpl(setup(), "hbk", decls).primaryTargetId).toBe("l");
    const r = validateAttacksImpl(setup(), "hbk", decls, [], { primaryTargetId: "r" });
    expect(r.primaryTargetId).toBe("r");
    expect(r.targets.map((t) => t.secondaryMod)).toEqual([2, 0]);
  });

  it("rejects a non-forward primary when a forward target exists", () => {
    expect(() =>
      validateAttacksImpl(setup(), "hbk", [w(1, "l"), w(3, "fa")], [], { primaryTargetId: "l" }),
    ).toThrow(/forward arc/);
  });

  it("rejects a primary that is not a declared target", () => {
    expect(() =>
      validateAttacksImpl(setup(), "hbk", [w(1, "fa"), w(2, "fb")], [], { primaryTargetId: "r" }),
    ).toThrow(/not a declared weapon target/);
  });

  it("groups weapons per target and exposes the status on events", () => {
    const state = setup();
    const events: GameEvent[] = [];
    declareAttacks(state, "hbk", [w(1, "fa"), w(3, "fa"), w(2, "fb")], [], events, seededRng(7));
    const declared = events.find((e) => e.kind === "attacksDeclared");
    expect(declared?.kind === "attacksDeclared" && declared.weapons).toMatchObject([
      { targetId: "fa", count: 2, secondaryMod: 0 },
      { targetId: "fb", count: 1, secondaryMod: 1 },
    ]);
    const decls = state.units.hbk!.declaredWeaponAttacks;
    expect(decls.map((d) => d.secondaryMod)).toEqual([undefined, undefined, 1]);

    const resolved: GameEvent[] = [];
    resolveAllAttacks(state, seededRng(7), resolved);
    const attacks = resolved.filter((e) => e.kind === "attackResolved");
    expect(attacks).toHaveLength(3);
    for (const e of attacks) {
      if (e.kind !== "attackResolved") continue;
      const secondary = e.targetId === "fb";
      expect(e.secondaryMod).toBe(secondary ? 1 : 0);
      expect(e.resolution.breakdown.secondaryTargetMod).toBe(secondary ? 1 : 0);
    }
  });

  it("raises the to-hit number of a secondary shot by the modifier", () => {
    const solo = setup();
    const both = setup();
    const a: GameEvent[] = [];
    const b: GameEvent[] = [];
    declareAttacks(solo, "hbk", [w(2, "fb")], [], a, seededRng(3));
    declareAttacks(both, "hbk", [w(1, "fa"), w(2, "fb")], [], b, seededRng(3));
    resolveAllAttacks(solo, seededRng(3), a);
    resolveAllAttacks(both, seededRng(3), b);
    const total = (evs: GameEvent[]) =>
      evs.flatMap((e) =>
        e.kind === "attackResolved" && e.targetId === "fb"
          ? [toHitTotal(e.resolution.breakdown)]
          : [],
      )[0];
    expect(total(b)).toBe(total(a)! + 1);
  });

  it("classifies the modifier against the twisted facing", () => {
    const hbk = { col: 4, row: 6 };
    expect(secondaryTargetModifier(hbk, FRONT_B, "n")).toBe(1);
    expect(secondaryTargetModifier(hbk, LEFT, "n")).toBe(2);
    expect(secondaryTargetModifier(hbk, RIGHT, "n")).toBe(2);
    // Twisting left swings the torso one hexside counter-clockwise: the left
    // target comes into the forward arc, the right one moves further away.
    expect(secondaryTargetModifier(hbk, LEFT, "n", "leftSide")).toBe(1);
  });

  it("stamps the twisted-facing modifier on the decl and resolves with it", () => {
    const state = setup();
    const events: GameEvent[] = [];
    // Twist left: 'fa' and 'l' are both forward, so the secondary is +1
    // (untwisted it would be +2 for the left target).
    const decls = [w(2, "fa"), w(1, "l")];
    const v = validateAttacksImpl(state, "hbk", decls, [], { twist: "leftSide" });
    const declared = Object.fromEntries(v.targets.map((t) => [t.targetId, t.secondaryMod]));
    declareAttacks(state, "hbk", decls, [], events, seededRng(5), { twist: "leftSide" });
    expect(state.units.hbk!.declaredWeaponAttacks.map((d) => d.secondaryMod)).toEqual([
      undefined,
      1,
    ]);
    resolveAllAttacks(state, seededRng(5), events);
    const resolved = events.flatMap((e) => (e.kind === "attackResolved" ? [e] : []));
    expect(resolved).toHaveLength(2);
    for (const e of resolved) {
      expect(e.secondaryMod).toBe(declared[e.targetId]);
      expect(e.resolution.breakdown.secondaryTargetMod).toBe(declared[e.targetId]);
    }
    expect(Object.values(declared).some((m) => m === 1)).toBe(true);
  });
});
