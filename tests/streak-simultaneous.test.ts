import { describe, expect, it } from "vitest";
import { mechDef } from "../src/data/index";
import { pooledShotsLeft } from "../src/rules/ammo";
import type { AttackResolution } from "../src/rules/attack";
import type { BattleState, GameEvent, UnitInit } from "../src/rules/game";
import {
  advancePhase,
  buildUnitInit,
  declareAttacks,
  requireUnit,
  resolveAllAttacks,
  rollInitiativePhase,
} from "../src/rules/game";
import { createTestBattle, scriptedRng } from "./helpers";

// TW resolves weapon attacks simultaneously: a Streak launcher's ammo is read
// as the attacker's bins stood at phase start, so damage another unit deals
// to the bin's location earlier in the resolution order cannot void it.
const MC = buildUnitInit("mc", "MC-MKII-2", 1, { col: 2, row: 4 }, "ne");
const ENF = buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 4 }, "nw");

/** Attack phase with mc's only live Streak bin (RT:7) in a right torso the
 *  ENF's AC/10 (weapon 1, front arc, roll 6 = RT) destroys outright. */
function setup(units: UnitInit[], rtShots?: number): BattleState {
  const state = createTestBattle([], units, true);
  rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
  advancePhase(state, [], scriptedRng());
  const mc = requireUnit(state, "mc");
  mc.ammoBins["leftTorso:7"] = 0;
  if (rtShots !== undefined) mc.ammoBins["rightTorso:7"] = rtShots;
  mc.damage.armor.rightTorso = 0;
  mc.damage.internalStructure.rightTorso = 1;
  return state;
}

/** Declares in unit order (initiative ties keep it), which is also the
 *  resolution order. */
function declare(state: BattleState, streaks: number[]): void {
  for (const id of Object.keys(state.units)) {
    const decls =
      id === "enf"
        ? [{ weaponIndex: 1, targetId: "mc" }]
        : streaks.map((weaponIndex) => ({ weaponIndex, targetId: "enf" }));
    declareAttacks(state, id, decls, [], [], scriptedRng());
  }
}

/** All 3s: every to-hit is 6 (TN 4), every location roll 6 (front RT). */
function resolve(state: BattleState): AttackResolution[] {
  const events: GameEvent[] = [];
  resolveAllAttacks(state, scriptedRng(...Array<number>(32).fill(3)), events);
  return events.flatMap((e) =>
    e.kind === "attackResolved" && e.resolution.weapon === "CL Streak SRM 4" ? [e.resolution] : [],
  );
}

describe("streak ammo under simultaneous fire", () => {
  it("fires from a bin destroyed earlier in the same phase", () => {
    const state = setup([ENF, MC]);
    expect(requireUnit(state, "mc").ammoBins["rightTorso:7"]).toBe(25);
    declare(state, [3]);
    const [streak] = resolve(state);
    const mc = requireUnit(state, "mc");
    // Precondition: the AC/10 resolved first and destroyed the RT.
    expect(mc.damage.internalStructure.rightTorso).toBe(0);
    expect(streak!.ammoExhausted).toBe(false);
    expect(streak!.toHitRoll).toBe(6);
    expect(streak!.hit).toBe(true);
    expect(streak!.groups).toHaveLength(4);
    // One shot spent; the rest is stranded in the destroyed torso.
    expect(mc.ammoBins["rightTorso:7"]).toBe(24);
    expect(mc.heatPending).toBe(3);
  });

  it("gives the same volley and bins whichever unit resolves first", () => {
    const enfFirst = setup([ENF, MC]);
    const mcFirst = setup([MC, ENF]);
    declare(enfFirst, [3]);
    declare(mcFirst, [3]);
    const a = resolve(enfFirst);
    const b = resolve(mcFirst);
    expect(requireUnit(mcFirst, "mc").damage.internalStructure.rightTorso).toBe(0);
    expect(a).toEqual(b);
    expect(requireUnit(enfFirst, "mc").ammoBins).toEqual(requireUnit(mcFirst, "mc").ammoBins);
  });

  it("does not spend the last phase-start shot twice", () => {
    const state = setup([ENF, MC], 1);
    expect(
      pooledShotsLeft(mechDef("MC-MKII-2")!, requireUnit(state, "mc"), "CL Streak SRM 4"),
    ).toBe(1);
    declare(state, [3, 5]);
    const [first, second] = resolve(state);
    const mc = requireUnit(state, "mc");
    expect(mc.damage.internalStructure.rightTorso).toBe(0);
    expect(first!.hit).toBe(true);
    expect(first!.ammoExhausted).toBe(false);
    expect(second!.hit).toBe(false);
    expect(second!.ammoExhausted).toBe(true);
    expect(second!.toHitRoll).toBeNull();
    expect(mc.ammoBins["rightTorso:7"]).toBe(0);
    expect(mc.heatPending).toBe(3);
  });
});
