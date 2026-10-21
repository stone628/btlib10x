/**
 * API-F02: a held club occupies both hands (TW p.146), so
 * `suggestFireTargets` blocks arm mounts with `clubHeld` exactly when
 * `validateAttacks` would refuse them, and `dropClub` lifts the block the
 * same way on both.
 */

import { describe, expect, it } from "vitest";
import {
  type BattleState,
  createBattle,
  type FireTarget,
  mechDefFor,
  suggestFireTargets,
  validateAttacks,
} from "../src";
import { isArm } from "../src/core/types";
import { buildUnitInit } from "../src/rules/game";

function faceToFace(): BattleState {
  const battle = createBattle({ name: "club", width: 12, height: 12, terrain: [], legends: [] }, [
    buildUnitInit("a", "HBK-4G", 1, { col: 5, row: 5 }, "n"),
    buildUnitInit("t", "HBK-4G", 2, { col: 5, row: 3 }, "s"),
  ]);
  battle.phase = "attack";
  battle.initiativeWinnerTeam = 2;
  battle.actorQueue = ["a", "t"];
  battle.actedThisPhase = [];
  return battle;
}

function holdClub(battle: BattleState): void {
  battle.units.a!.club = { kind: "limb", limb: "rightArm", model: "HBK-4G", ownerId: "x" };
}

function target(battle: BattleState, dropClub?: boolean): FireTarget {
  const t = suggestFireTargets(battle, "a", "front", dropClub).targets[0];
  expect(t?.targetId).toBe("t");
  return t!;
}

function armIndices(battle: BattleState): number[] {
  const def = mechDefFor(battle.units.a!);
  return Object.entries(def.weapons)
    .filter(([, m]) => isArm(m.location))
    .map(([k]) => Number(k));
}

describe("suggestFireTargets with a held club (API-F02)", () => {
  it("lists arm weapons when no club is held, with or without dropClub", () => {
    const battle = faceToFace();
    const arms = armIndices(battle);
    expect(arms.length).toBeGreaterThan(0);
    for (const drop of [undefined, true]) {
      const offered = target(battle, drop).weapons.map((w) => w.weaponIndex);
      for (const i of arms) expect(offered).toContain(i);
    }
  });

  it("blocks arm mounts with clubHeld while a club is held", () => {
    const battle = faceToFace();
    holdClub(battle);
    const t = target(battle);
    const arms = armIndices(battle);
    for (const list of [t.weaponsIfPropLeft, t.weaponsIfPropRight]) {
      expect(list.some((w) => isArm(w.location))).toBe(false);
      expect(list.length).toBeGreaterThan(0);
    }
    for (const list of [t.blockedIfPropLeft, t.blockedIfPropRight]) {
      const held = list.filter((b) => b.reason === "clubHeld").map((b) => b.weaponIndex);
      expect(held.sort()).toEqual([...arms].sort());
    }
  });

  it("every suggested volley is accepted by validateAttacks, with and without the drop", () => {
    const battle = faceToFace();
    holdClub(battle);
    for (const dropClub of [false, true]) {
      const t = target(battle, dropClub);
      const decls = t.weapons.map((w) => ({ targetId: t.targetId, weaponIndex: w.weaponIndex }));
      expect(() => validateAttacks(battle, "a", decls, [], { dropClub })).not.toThrow();
    }
    // The drop frees the hands: the arm weapons come back.
    const dropped = target(battle, true).weapons.map((w) => w.weaponIndex);
    for (const i of armIndices(battle)) expect(dropped).toContain(i);
  });
});
