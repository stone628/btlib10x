import { describe, expect, it } from "vitest";
import type { Location } from "../src/core/types";
import { destroyedSlots, isSlotDestroyed } from "../src/rules/critical";
import { canAttemptStandUp } from "../src/rules/damage";
import { buildUnitInit, type UnitInit, type UnitState } from "../src/rules/game";
import type { UnitInitDamage } from "../src/rules/initialDamage";
import { createTestBattle } from "./helpers";

function unitWith(damage?: UnitInitDamage, model = "HBK-4G", pilotHitMax = 6): UnitState {
  const a: UnitInit = {
    ...buildUnitInit("a", model, 0, { col: 1, row: 1 }, "n", 4, 5, pilotHitMax),
    ...(damage === undefined ? {} : { damage }),
  };
  const b = buildUnitInit("b", "ENF-4R", 1, { col: 3, row: 1 });
  return createTestBattle([], [a, b], true).units.a!;
}

/** Everything a location has, to take it all (armor + structure) in one go. */
function wipe(model: string, ...locs: Location[]): UnitInitDamage {
  const full = unitWith(undefined, model).damage;
  const damage: NonNullable<UnitInitDamage["damageTaken"]> = {
    armor: {},
    armorRear: {},
    internalStructure: {},
  };
  for (const loc of locs) {
    damage.armor![loc] = full.armor[loc];
    damage.internalStructure![loc] = full.internalStructure[loc];
    if (loc === "centerTorso" || loc === "leftTorso" || loc === "rightTorso") {
      damage.armorRear![loc] = full.armorRear[loc];
    }
  }
  return { damageTaken: damage };
}

describe("starting damage (UnitInit.damage)", () => {
  it("leaves a unit without damage pristine", () => {
    const u = unitWith();
    expect(u.pilotHits).toBe(0);
    expect(u.prone).toBe(false);
    expect(u.destroyedWeapons).toEqual([]);
    expect(u.jammedWeapons).toEqual([]);
    expect(Object.values(u.critSlotsDestroyed).flat().some(Boolean)).toBe(false);
  });

  it("applies damage taken, crits, ammo used and pilot hits", () => {
    const full = unitWith();
    const loaded = full.ammoBins["leftTorso:1"]!;
    const u = unitWith({
      pilotHits: 2,
      damageTaken: {
        armor: { rightArm: 5, centerTorso: 26 },
        armorRear: { centerTorso: 5 },
        internalStructure: { centerTorso: 4 },
      },
      critsDestroyed: { head: [4], rightArm: [5], rightTorso: [1, 2], leftTorso: [2] },
      ammoUsed: { "leftTorso:1": 3 },
    });
    expect(u.pilotHits).toBe(2);
    expect(u.damage.armor.rightArm).toBe(full.damage.armor.rightArm - 5);
    expect(u.damage.armor.centerTorso).toBe(0);
    expect(u.damage.armorRear.centerTorso).toBe(0);
    expect(u.damage.internalStructure.centerTorso).toBe(
      full.damage.internalStructure.centerTorso - 4,
    );
    expect(isSlotDestroyed(u.critSlotsDestroyed, "head", 3)).toBe(true);
    expect(isSlotDestroyed(u.critSlotsDestroyed, "rightArm", 4)).toBe(true);
    // Weapon slots map to mounts (1-based); a multi-slot mount counts once.
    expect([...u.destroyedWeapons].sort()).toEqual([2, 3, 4]);
    expect(u.ammoBins["leftTorso:1"]!).toBe(loaded - 3);
    expect(u.ammoBins["leftTorso:2"]!).toBe(0); // destroyed bin is empty
    expect(u.jammedWeapons).toEqual([]);
  });

  it("keeps 'structure gone, crit slots alive' as given, but strips the location's bins", () => {
    const u = unitWith(wipe("HBK-4G", "leftTorso", "leftArm"));
    expect(u.damage.internalStructure.leftTorso).toBe(0);
    // Plain damage never flags slots (see damage.ts); neither do we.
    expect(u.critSlotsDestroyed.leftTorso).toBe(0);
    expect(u.critSlotsDestroyed.leftArm).toBe(0);
    expect(u.destroyedWeapons).toEqual([]);
    // Play strands the bins of a destroyed location (negative = salvage), so do we.
    const loaded = unitWith().ammoBins;
    expect(u.ammoBins["leftTorso:1"]).toBe(-loaded["leftTorso:1"]!);
    expect(u.ammoBins["leftTorso:2"]).toBe(-loaded["leftTorso:2"]!);
    const intact = unitWith();
    for (const id of Object.keys(intact.ammoBins).filter((b) => !b.startsWith("leftTorso:"))) {
      expect(u.ammoBins[id]).toBe(intact.ammoBins[id]);
    }
    // Listing a slot of the dead location flags just that slot.
    const v = unitWith({
      ...wipe("HBK-4G", "leftTorso", "leftArm"),
      critsDestroyed: { leftTorso: [2] },
    });
    expect(destroyedSlots(v.critSlotsDestroyed, "leftTorso")).toHaveLength(1);
    expect(v.ammoBins["leftTorso:1"]).toBe(-loaded["leftTorso:1"]!);
    expect(v.ammoBins["leftTorso:2"]).toBe(0); // destroyed slot: nothing left
  });

  it("a destroyed location with ammo used keeps its remaining shots as a stranded count", () => {
    const loaded = unitWith().ammoBins["leftTorso:1"]!;
    const u = unitWith({
      ...wipe("HBK-4G", "leftTorso", "leftArm"),
      ammoUsed: { "leftTorso:1": 3 },
    });
    expect(u.ammoBins["leftTorso:1"]).toBe(-(loaded - 3));
  });

  describe("gates: states that would start destroyed", () => {
    it("head structure gone", () => {
      expect(() => unitWith(wipe("HBK-4G", "head"))).toThrow(/headDestroyed/);
    });
    it("center torso structure gone", () => {
      expect(() => unitWith(wipe("HBK-4G", "centerTorso"))).toThrow(/centerTorsoDestroyed/);
    });
    it("cockpit slot destroyed", () => {
      expect(() => unitWith({ critsDestroyed: { head: [3] } })).toThrow(/cockpitDestroyed/);
    });
    it("three engine slots destroyed (two are fine)", () => {
      expect(() => unitWith({ critsDestroyed: { centerTorso: [1, 2, 3] } })).toThrow(
        /engineDestroyed/,
      );
      expect(() => unitWith({ critsDestroyed: { centerTorso: [1, 2] } })).not.toThrow();
    });
    it("engine slots lost with a destroyed side torso count (XL engine)", () => {
      expect(() => unitWith(wipe("CDA-3MA", "leftTorso", "leftArm"), "CDA-3MA")).toThrow(
        /engineDestroyed/,
      );
    });
    it("a dead pilot", () => {
      expect(() => unitWith({ pilotHits: 6 })).toThrow(/pilotHits/);
      expect(unitWith({ pilotHits: 5 }).pilotHits).toBe(5);
      expect(unitWith({ pilotHits: 2 }, "HBK-4G", 3).pilotHits).toBe(2);
      expect(() => unitWith({ pilotHits: 3 }, "HBK-4G", 3)).toThrow(/pilotHits/);
    });
  });

  describe("consistency errors", () => {
    const bad = (damage: UnitInitDamage, re: RegExp) => expect(() => unitWith(damage)).toThrow(re);
    it("damage beyond the model", () => {
      bad({ damageTaken: { armor: { rightArm: 99 } } }, /exceeds/);
      bad({ damageTaken: { armorRear: { centerTorso: 99 } } }, /exceeds/);
      bad({ damageTaken: { internalStructure: { rightArm: 99 } } }, /exceeds/);
      bad({ damageTaken: { armor: { rightArm: -1 } } }, />= 0/);
    });
    it("structure lost behind intact armor", () => {
      bad({ damageTaken: { internalStructure: { rightArm: 1 } } }, /armor is not depleted/);
      bad(
        { damageTaken: { armor: { centerTorso: 3 }, internalStructure: { centerTorso: 1 } } },
        /armor is not depleted/,
      );
    });
    it("a torso structure hit through the rear pool is fine", () => {
      expect(() =>
        unitWith({
          damageTaken: { armorRear: { centerTorso: 5 }, internalStructure: { centerTorso: 1 } },
        }),
      ).not.toThrow();
    });
    it("a destroyed side torso needs its arm destroyed", () => {
      bad(wipe("HBK-4G", "leftTorso"), /leftArm is not/);
      expect(() => unitWith(wipe("HBK-4G", "leftTorso", "leftArm"))).not.toThrow();
    });
    it("bad crit slots", () => {
      bad({ critsDestroyed: { head: [99] } }, /no crit slot/);
      bad({ critsDestroyed: { head: [4, 4] } }, /listed twice/);
      bad({ critsDestroyed: { leftArm: [12] } }, /is empty/);
    });
    it("bad ammo", () => {
      bad({ ammoUsed: { "leftTorso:9": 1 } }, /no ammo bin/);
      bad({ ammoUsed: { "leftTorso:1": 999 } }, /exceeds/);
    });
  });

  describe("posture (a lost leg or gyro means the unit has fallen)", () => {
    it("one destroyed leg: prone, may still try to stand", () => {
      const u = unitWith(wipe("HBK-4G", "rightLeg"));
      expect(u.prone).toBe(true);
      expect(canAttemptStandUp(u.damage)).toBe(true);
    });
    it("both legs: prone and cannot stand", () => {
      const u = unitWith(wipe("HBK-4G", "rightLeg", "leftLeg"));
      expect(u.prone).toBe(true);
      expect(canAttemptStandUp(u.damage)).toBe(false);
    });
    it("destroyed gyro: prone; one gyro hit: standing", () => {
      expect(unitWith({ critsDestroyed: { centerTorso: [4, 5] } }).prone).toBe(true);
      expect(unitWith({ critsDestroyed: { centerTorso: [4] } }).prone).toBe(false);
    });
    it("blinded sensors, a lost arm and spent ammo leave it standing", () => {
      expect(unitWith({ critsDestroyed: { head: [2, 5] } }).prone).toBe(false);
      expect(unitWith(wipe("HBK-4G", "rightArm")).prone).toBe(false);
    });
    it("crippled but alive is accepted (no legs, no arms)", () => {
      const u = unitWith(wipe("HBK-4G", "rightLeg", "leftLeg", "rightArm", "leftArm"));
      expect(u.prone).toBe(true);
      expect(u.destroyed).toBe("not");
      expect(u.removed).toBe("not");
    });
  });
});
