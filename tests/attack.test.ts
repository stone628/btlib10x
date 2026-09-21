import { describe, expect, it } from "vitest";
import type { Location } from "../src/core/types.js";
import { LOCATIONS } from "../src/core/types.js";
import { getMechDef } from "../src/data/index.js";
import { loadAmmoBins } from "../src/rules/ammo.js";
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

function freshFlags(def = getMechDef("HBK-4G")!) {
  const out: Record<Location, boolean[]> = {} as Record<Location, boolean[]>;
  for (const loc of Object.keys(def.critSlots) as Location[]) {
    out[loc] = new Array(def.critSlots[loc].length).fill(false);
  }
  return out;
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
    expect(res.groups).toEqual([{ location: "centerTorso", damage: 3, throughArmor: false }]);
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
      { location: "rightLeg", damage: 5, throughArmor: false },
      { location: "centerTorso", damage: 5, throughArmor: false },
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
      { location: "centerTorso", damage: 5, throughArmor: true },
      { location: "rightArm", damage: 3, throughArmor: false },
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

  it("lands full tube count on streak hits with no cluster roll", () => {
    const rng = scriptedRng(
      3,
      3, // to-hit 6 >= 4
      3,
      4, // missile 1 -> center torso (7)
      3,
      4, // missile 2 -> center torso (7)
      3,
      4, // missile 3 -> center torso (7)
      3,
      4, // missile 4 -> center torso (7)
    );
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "CL Streak SRM 4",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(true);
    expect(res.clusterRoll).toBeNull();
    expect(res.groups).toEqual([
      { location: "centerTorso", damage: 2, throughArmor: false },
      { location: "centerTorso", damage: 2, throughArmor: false },
      { location: "centerTorso", damage: 2, throughArmor: false },
      { location: "centerTorso", damage: 2, throughArmor: false },
    ]);
    expect(res.application?.after.armor.centerTorso).toBe(2);
    expect(rng.remaining()).toBe(0);
  });

  it("records streak misses without consuming further rolls", () => {
    const rng = scriptedRng(1, 2); // total 3 < TN 4
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "CL Streak SRM 4",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(false);
    expect(res.clusterRoll).toBeNull();
    expect(res.groups).toHaveLength(0);
    expect(res.application).toBeNull();
    expect(rng.remaining()).toBe(0);
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

  it("partial cover: +1 TN and leg location hits strike the cover", () => {
    const rng = scriptedRng(3, 3, 2, 3); // to-hit 6 >= TN 5; location 5 -> rightLeg -> cover
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      targetTerrain: "water1",
      weapon: "Small Laser",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(true);
    expect(res.breakdown.terrainMod).toBe(1);
    expect(res.groups).toHaveLength(0);
    expect(res.application).toBeNull();
    expect(rng.remaining()).toBe(0);
  });

  it("partial cover does not block non-leg locations", () => {
    const rng = scriptedRng(3, 3, 3, 4); // to-hit 6 >= TN 5; location 7 -> CT
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      targetTerrain: "mediumBuilding",
      weapon: "Small Laser",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(true);
    expect(res.breakdown.terrainMod).toBe(1);
    expect(res.groups).toEqual([{ location: "centerTorso", damage: 3, throughArmor: false }]);
  });

  it("no partial cover when attacker stands higher than target", () => {
    const rng = scriptedRng(3, 3, 2, 3); // to-hit 6 >= TN 4; location 5 -> rightLeg (no cover)
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      targetTerrain: "water1",
      attackerLevel: 2,
      targetLevel: 0,
      weapon: "Small Laser",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(true);
    expect(res.breakdown.terrainMod).toBe(0);
    expect(res.groups).toEqual([{ location: "rightLeg", damage: 3, throughArmor: false }]);
  });
});

describe("through-armor criticals (hit-location roll of 2)", () => {
  const def = getMechDef("HBK-4G")!;

  function critInput(rng: ReturnType<typeof scriptedRng>) {
    return {
      ...BASE,
      rng,
      weapon: "Small Laser",
      targetDamage: freshState(),
      targetDef: def,
      targetCritSlotsDestroyed: freshFlags(def),
      targetDestroyedWeapons: [] as number[],
      targetAmmoBins: loadAmmoBins(def),
    };
  }

  it("rolls once on the determining table with armor unbreached (front CT)", () => {
    const rng = scriptedRng(
      2,
      3, // to-hit 5 >= TN 4
      1,
      1, // location 2 -> centerTorso, through-armor
      3,
      5, // determining 8 -> one crit
      1,
      1, // CT slot 1 (engine)
    );
    const res = resolveWeaponAttack(critInput(rng));
    expect(res.hit).toBe(true);
    expect(res.groups).toEqual([{ location: "centerTorso", damage: 3, throughArmor: true }]);
    // Damage lands on armor normally; structure untouched.
    expect(res.application?.after.armor.centerTorso).toBe(7);
    expect(res.application?.after.internalStructure.centerTorso).toBe(10);
    expect(res.crits).toHaveLength(1);
    expect(res.crits[0]!.throughArmor).toBe(true);
    expect(res.crits[0]!.determiningRoll).toBe(8);
    expect(res.crits[0]!.rows).toHaveLength(1);
    expect(rng.remaining()).toBe(0);
  });

  it("applies to the near torso on side columns (rightSide roll of 2)", () => {
    const rng = scriptedRng(
      2,
      3, // to-hit 5 >= TN 4
      1,
      1, // location 2 -> rightTorso on the right-side table, through-armor
      3,
      5, // determining 8 -> one crit
      1,
      1, // rightTorso slot 1 (AC/20)
    );
    const res = resolveWeaponAttack({ ...critInput(rng), arc: "rightSide" });
    expect(res.hit).toBe(true);
    expect(res.groups).toEqual([{ location: "rightTorso", damage: 3, throughArmor: true }]);
    expect(res.application?.after.armor.rightTorso).toBe(7);
    expect(res.crits).toHaveLength(1);
    expect(res.crits[0]!.throughArmor).toBe(true);
    expect(rng.remaining()).toBe(0);
  });

  it("rolls no determining table on other locations with armor unbreached", () => {
    const rng = scriptedRng(
      2,
      3, // to-hit 5 >= TN 4
      3,
      4, // location 7 -> centerTorso, ordinary
    );
    const res = resolveWeaponAttack(critInput(rng));
    expect(res.hit).toBe(true);
    expect(res.groups).toEqual([{ location: "centerTorso", damage: 3, throughArmor: false }]);
    expect(res.crits).toHaveLength(0);
    expect(rng.remaining()).toBe(0);
  });

  it("rolls twice when hit-location 2 also strips IS (TW p.124, in addition to)", () => {
    // Pre-armor CT = 2, IS CT = 10; 3pt Small Laser breaches armor + strips 1 IS.
    // Roll of 2 -> through-armor crit in addition to structure-damage crit (2 rolls).
    const rng = scriptedRng(
      2,
      3, // to-hit 5 >= TN 4
      1,
      1, // location 2 -> centerTorso, through-armor
      3,
      5, // determining 8 -> 1 crit (structure breach)
      1,
      1, // CT slot 1 (engine)
      3,
      5, // determining 8 -> 1 crit (through-armor)
      1,
      2, // CT slot 2 (engine)
    );
    const res = resolveWeaponAttack({
      ...critInput(rng),
      targetDamage: freshState(2),
    });
    expect(res.hit).toBe(true);
    expect(res.groups).toEqual([{ location: "centerTorso", damage: 3, throughArmor: true }]);
    expect(res.application?.after.armor.centerTorso).toBe(0);
    expect(res.application?.after.internalStructure.centerTorso).toBe(1);
    expect(res.crits).toHaveLength(2);
    expect(res.crits[0]!.throughArmor).toBe(false);
    expect(res.crits[0]!.determiningRoll).toBe(8);
    expect(res.crits[0]!.rows[0]!.kind).toBe("componentDestroyed");
    expect(res.crits[1]!.throughArmor).toBe(true);
    expect(res.crits[1]!.determiningRoll).toBe(8);
    // Second roll must not re-hit slot 1 (already destroyed by first call).
    expect(res.crits[1]!.rows[0]!.kind).toBe("componentDestroyed");
    expect(rng.remaining()).toBe(0);
  });
});
