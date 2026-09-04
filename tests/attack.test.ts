import { describe, expect, it } from "vitest";
import { LOCATIONS } from "../src/core/types.js";
import { resolveWeaponAttack } from "../src/rules/attack.js";
import type { LocationValue, UnitDamageState } from "../src/rules/damage.js";
import { scriptedRng } from "./helpers.js";

function freshState(hp = 10): UnitDamageState {
  const armor = {} as LocationValue;
  const is = {} as LocationValue;
  for (const loc of LOCATIONS) {
    armor[loc] = hp;
    is[loc] = hp;
  }
  return { armor, armorRear: {}, internalStructure: is };
}

/** Stationary gunnery-4 shooter at range 1 vs stationary target in the clear: TN 4. */
const BASE = {
  gunnery: 4,
  attackerMoved: "standStill",
  targetHexesMoved: 0,
  targetJumped: false,
  targetTerrain: "clear",
  interveningTerrains: [],
  distance: 1,
} as const;

describe("resolveWeaponAttack", () => {
  it("resolves a direct-fire hit end-to-end", () => {
    const rng = scriptedRng(2, 3, 3, 4); // to-hit 5 >= 4; location 7 -> CT
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "Small Laser",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(true);
    expect(res.jammed).toBe(false);
    expect(res.toHitRoll).toBe(5);
    expect(res.clusterRoll).toBeNull();
    expect(res.groups).toEqual([{ location: "centerTorso", damage: 3 }]);
    expect(res.application?.after.armor.centerTorso).toBe(7);
    expect(rng.remaining()).toBe(0);
  });

  it("records misses without consuming further rolls", () => {
    const rng = scriptedRng(1, 2); // total 3 < TN 4
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "Small Laser",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(false);
    expect(res.groups).toHaveLength(0);
    expect(res.application).toBeNull();
    expect(rng.remaining()).toBe(0);
  });

  it("jams multi-shot rapid fire on a natural 2 and stops there", () => {
    const rng = scriptedRng(1, 1);
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "Ultra AC/5",
      shots: 2,
      targetDamage: freshState(),
    });
    expect(res.jammed).toBe(true);
    expect(res.hit).toBe(false);
    expect(res.groups).toHaveLength(0);
    expect(rng.remaining()).toBe(0);
  });

  it("uses the rapid-fire cluster table for Ultra AC/5 double taps", () => {
    const rng = scriptedRng(
      3,
      4, // to-hit 7 >= 4
      4,
      5, // cluster roll 9, 2-shot column -> 2 hits
      2,
      3, // location 5 -> rightLeg
      3,
      4, // location 7 -> center torso
    );
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "Ultra AC/5",
      shots: 2,
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(true);
    expect(res.clusterRoll).toBe(9);
    expect(res.groups).toEqual([
      { location: "rightLeg", damage: 5 },
      { location: "centerTorso", damage: 5 },
    ]);
    expect(res.application?.after.armor.rightLeg).toBe(5);
  });

  it("rolls LRM missiles in lots of five", () => {
    const rng = scriptedRng(
      5,
      6, // to-hit 11
      4,
      5, // cluster roll 9: 10-missile column -> 8 missiles
      1,
      1, // lot of 5 -> head (2)
      2,
      2, // lot of 3 -> left torso (4)
    );
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "LRM 10",
      targetDamage: freshState(),
    });
    expect(res.clusterRoll).toBe(9);
    expect(res.groups).toEqual([
      { location: "centerTorso", damage: 5 },
      { location: "rightArm", damage: 3 },
    ]);
    expect(res.application?.after.armor.centerTorso).toBe(5);
    expect(res.application?.after.armor.rightArm).toBe(7);
  });

  it("locates every SRM missile individually", () => {
    const rng = scriptedRng(
      5,
      5, // to-hit 10
      5,
      5, // cluster roll 10: SRM-6 column -> 5 missiles
      ...[2, 2, 3, 3, 4, 4, 5, 5, 6, 6], // ten d6 -> five locations
    );
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "SRM 6",
      targetDamage: freshState(),
    });
    expect(res.groups).toHaveLength(5);
    for (const group of res.groups) expect(group.damage).toBe(2);
  });

  it("auto-fails out-of-range shots without rolling", () => {
    const rng = scriptedRng();
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      distance: 999,
      weapon: "Medium Laser",
      targetDamage: freshState(),
    });
    expect(res.breakdown.outOfRange).toBe(true);
    expect(res.toHitRoll).toBeNull();
    expect(rng.remaining()).toBe(0);
  });
});
