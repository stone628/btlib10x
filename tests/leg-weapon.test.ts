/**
 * Leg-mounted weapons need only their leg: a destroyed side torso takes the
 * arm on that side (TW p.122) but not the leg, so the leg mount still fires.
 * Crusader CRD-3R carries an SRM 6 in each leg.
 */

import { describe, expect, it } from "vitest";
import { createBattle, suggestFireTargets } from "../src";
import type { HexCoord } from "../src/core/types";
import { canFireFromLocation } from "../src/rules/damage";
import { type BattleState, buildUnitInit, validateAttacksImpl } from "../src/rules/game";

const CRD = "CRD-3R";
const RA_MEDIUM_LASER = 2;
const RL_SRM6 = 6;

/** CRD-3R at (5,5) facing north and a target two hexes ahead, in the attack phase. */
function crusaderBattle(targetHex: HexCoord = { col: 5, row: 3 }): BattleState {
  const battle = createBattle(
    { name: "leg", width: 20, height: 20, terrain: [], legends: [] },
    [
      buildUnitInit("a", CRD, 1, { col: 5, row: 5 }, "n"),
      buildUnitInit("t", "HBK-4G", 2, targetHex, "s"),
    ],
    { critsDisabled: true },
  );
  battle.phase = "attack";
  battle.initiativeWinnerTeam = 2;
  battle.actorQueue = ["a", "t"];
  battle.actedThisPhase = [];
  return battle;
}

function withRightTorsoGone(): BattleState {
  const battle = crusaderBattle();
  const damage = battle.units.a!.damage;
  damage.internalStructure.rightTorso = 0;
  damage.internalStructure.rightArm = 0;
  return battle;
}

describe("leg-mounted weapons with the side torso destroyed", () => {
  it("canFireFromLocation: the leg stays usable, the arm does not", () => {
    const damage = withRightTorsoGone().units.a!.damage;
    expect(canFireFromLocation(damage, "rightLeg")).toBe(true);
    expect(canFireFromLocation(damage, "rightArm")).toBe(false);
    damage.internalStructure.rightLeg = 0;
    expect(canFireFromLocation(damage, "rightLeg")).toBe(false);
  });

  it("an arm still needs its side torso even with arm structure left", () => {
    const damage = crusaderBattle().units.a!.damage;
    damage.internalStructure.rightTorso = 0;
    expect(canFireFromLocation(damage, "rightArm")).toBe(false);
  });

  it("validateAttacksImpl accepts the leg SRM and rejects the arm laser", () => {
    const battle = withRightTorsoGone();
    expect(() =>
      validateAttacksImpl(battle, "a", [{ weaponIndex: RL_SRM6, targetId: "t" }]),
    ).not.toThrow();
    expect(() =>
      validateAttacksImpl(battle, "a", [{ weaponIndex: RA_MEDIUM_LASER, targetId: "t" }]),
    ).toThrow(/destroyed or its support torso is gone/);
  });

  // With the arm gone a prone 'Mech cannot prop up to fire at all, so the
  // leg mount stays silenced while prone.
  it("the leg SRM still cannot fire while prone", () => {
    const battle = withRightTorsoGone();
    battle.units.a!.prone = true;
    expect(() =>
      validateAttacksImpl(battle, "a", [{ weaponIndex: RL_SRM6, targetId: "t" }]),
    ).toThrow(/cannot fire while prone/);
  });

  it("suggestFireTargets lists the leg SRM and blocks the arm laser as destroyed", () => {
    const target = suggestFireTargets(withRightTorsoGone(), "a").targets.find(
      (t) => t.targetId === "t",
    )!;
    expect(target.weapons.some((w) => w.weaponIndex === RL_SRM6)).toBe(true);
    expect(target.blocked).toContainEqual(
      expect.objectContaining({ weaponIndex: RA_MEDIUM_LASER, reason: "destroyed" }),
    );
  });
});
