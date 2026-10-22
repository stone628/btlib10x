import { describe, expect, it } from "vitest";
import { isTorso, LOCATIONS, type Location } from "../src/core/types";
import { mechDef, mechDefFor } from "../src/data/index";
import { collectAmmoBins, loadAmmoBins, strandedShots, usableShots } from "../src/rules/ammo";
import {
  applyAmmoExplosion,
  crittedWeapons,
  destroyedSlots,
  emptyCritTable,
  isSlotDestroyed,
  markLocationCatastrophicallyDestroyed,
} from "../src/rules/critical";
import {
  applyDamage,
  canAttemptStandUp,
  canFireFromLocation,
  dealtOf,
  destroyedArms,
  destroyedLegs,
  isUnitDestroyed,
  isUnitImmobile,
  type LocationValue,
  type TorsoLocationValue,
  type UnitDamageState,
} from "../src/rules/damage";
import { buildUnitInit, type UnitInit, type UnitState } from "../src/rules/game";
import { resolveInitialDamage, type UnitInitDamage } from "../src/rules/initialDamage";
import { createTestBattle } from "./helpers";

/** Build a layered damage state; every location defaults to 10 armor / 10 IS. */
function mk(
  over: {
    armor?: Partial<LocationValue>;
    armorRear?: Partial<TorsoLocationValue>;
    is?: Partial<LocationValue>;
  } = {},
): UnitDamageState {
  const armor = {} as LocationValue;
  const is = {} as LocationValue;
  for (const loc of LOCATIONS) {
    armor[loc] = over.armor?.[loc] ?? 10;
    is[loc] = over.is?.[loc] ?? 10;
  }
  return { armor, armorRear: { ...over.armorRear } as TorsoLocationValue, internalStructure: is };
}

describe("layered damage resolution", () => {
  it("drains front armor first, then the same location's internal structure", () => {
    const s = mk({ armor: { centerTorso: 26 }, is: { centerTorso: 16 } });
    const app = applyDamage(s, "centerTorso", 30);
    expect(app.after.armor.centerTorso).toBe(0);
    expect(app.after.internalStructure.centerTorso).toBe(12);
    expect(app.mechDestroyed).toBe(false);
    expect(app.steps).toEqual([
      { location: "centerTorso", pool: "armor", damageApplied: 26, depleted: true },
      { location: "centerTorso", pool: "structure", damageApplied: 4, depleted: false },
    ]);
  });

  it("non-penetrating hits leave internal structure untouched", () => {
    const s = mk({ armor: { rightTorso: 12 }, is: { rightTorso: 7 } });
    const app = applyDamage(s, "rightTorso", 10);
    expect(app.after.armor.rightTorso).toBe(2);
    expect(app.after.internalStructure.rightTorso).toBe(7);
    expect(app.steps).toHaveLength(1);
  });

  it("rear-arc torso hits drain the rear pool, then that IS; front pool is untouched", () => {
    const s = mk({
      armor: { centerTorso: 10, rightTorso: 10 },
      armorRear: { centerTorso: 5, rightTorso: 5 },
      is: { centerTorso: 10, rightTorso: 7 },
    });
    const rear = applyDamage(s, "centerTorso", 8, "rear");
    expect(rear.after.armorRear.centerTorso).toBe(0);
    expect(rear.after.internalStructure.centerTorso).toBe(7);
    expect(rear.after.armor.centerTorso).toBe(10);

    const front = applyDamage(s, "rightTorso", 12, "front");
    expect(front.after.armor.rightTorso).toBe(0);
    expect(front.after.internalStructure.rightTorso).toBe(5);
    expect(front.after.armorRear.rightTorso).toBe(5);
  });

  it("rear overflow through the rear pool can kill the 'Mech", () => {
    const s = mk({
      armor: { centerTorso: 0 },
      armorRear: { centerTorso: 5 },
      is: { centerTorso: 4 },
    });
    const app = applyDamage(s, "centerTorso", 9, "rear");
    expect(app.mechDestroyed).toBe(true);
    expect(app.after.armorRear.centerTorso).toBe(0);
    expect(app.after.internalStructure.centerTorso).toBe(0);
  });

  it("blows the arm off when its side torso structure is destroyed", () => {
    const s = mk({ armor: { leftTorso: 0, leftArm: 10 }, is: { leftTorso: 8, leftArm: 9 } });
    const app = applyDamage(s, "leftTorso", 8);
    expect(app.newlyDestroyed).toContain("leftTorso");
    expect(app.blownOffLimbs).toEqual(["leftArm"]);
    expect(app.after.internalStructure.leftArm).toBe(0);
    expect(app.after.armor.leftArm).toBe(0);
    expect(canFireFromLocation(app.after, "leftArm")).toBe(false);
    expect(canFireFromLocation(app.after, "leftTorso")).toBe(false);
  });

  it("arm IS destruction transfers overflow inward to the side torso", () => {
    const s = mk({ armor: { leftArm: 0 }, is: { leftArm: 4, leftTorso: 10 } });
    const app = applyDamage(s, "leftArm", 4);
    expect(app.newlyDestroyed).toContain("leftArm");
    expect(app.after.internalStructure.leftArm).toBe(0);
    expect(app.after.internalStructure.leftTorso).toBe(10);

    const app2 = applyDamage(app.after, "leftArm", 7);
    expect(app2.after.armor.leftTorso).toBe(3);
    expect(app2.after.internalStructure.leftTorso).toBe(10);
    expect(app2.newlyDestroyed).not.toContain("leftArm");
  });

  it("transfers immediately through a location drained to zero", () => {
    const s = mk({ armor: { rightArm: 0 }, is: { rightArm: 0, rightTorso: 10 } });
    const app = applyDamage(s, "rightArm", 4);
    expect(app.steps[0]?.location).toBe("rightTorso");
    expect(app.steps[0]?.pool).toBe("armor");
    expect(app.after.armor.rightTorso).toBe(6);
  });

  it("destroys the 'Mech when center torso or head structure is depleted", () => {
    const ct = mk({ armor: { centerTorso: 0 }, is: { centerTorso: 4 } });
    expect(applyDamage(ct, "centerTorso", 4).mechDestroyed).toBe(true);

    const head = mk({ armor: { head: 0 }, is: { head: 2 } });
    const headApp = applyDamage(head, "head", 2);
    expect(headApp.mechDestroyed).toBe(true);
    expect(isUnitDestroyed(headApp.after)).toBe(true);
  });

  it("one destroyed leg: not immobile, survives (TW p.122)", () => {
    const s = mk({ armor: { leftLeg: 2 }, is: { leftLeg: 5 } });
    const app = applyDamage(s, "leftLeg", 7);
    expect(app.after.armor.leftLeg).toBe(0);
    expect(isUnitImmobile(app.after)).toBe(false);
    expect(isUnitDestroyed(app.after)).toBe(false);
  });

  it("both legs and both arms destroyed: immobile target (TW p.122)", () => {
    const s = mk({
      armor: { leftLeg: 2, rightLeg: 2, leftArm: 2, rightArm: 2 },
      is: { leftLeg: 5, rightLeg: 5, leftArm: 4, rightArm: 4 },
    });
    const app = applyDamage(s, "leftLeg", 7);
    expect(app.after.internalStructure.leftLeg).toBe(0);
    const app2 = applyDamage(app.after, "rightLeg", 7);
    expect(app2.after.internalStructure.rightLeg).toBe(0);
    const app3 = applyDamage(app2.after, "leftArm", 6);
    const app4 = applyDamage(app3.after, "rightArm", 6);
    expect(isUnitImmobile(app4.after)).toBe(true);
    expect(isUnitDestroyed(app4.after)).toBe(false);
  });

  it("canAttemptStandUp: one leg + both arms = cannot stand (TW p.50)", () => {
    const s = mk({
      armor: { leftLeg: 0, rightLeg: 5, leftArm: 0, rightArm: 0 },
      is: { leftLeg: 0, rightLeg: 5, leftArm: 0, rightArm: 0 },
    });
    expect(destroyedLegs(s)).toBe(1);
    expect(destroyedArms(s)).toBe(2);
    expect(canAttemptStandUp(s)).toBe(false);
  });

  it("canAttemptStandUp: one leg + arms intact = can stand", () => {
    const s = mk({ armor: { leftLeg: 0 }, is: { leftLeg: 0 } });
    expect(destroyedLegs(s)).toBe(1);
    expect(destroyedArms(s)).toBe(0);
    expect(canAttemptStandUp(s)).toBe(true);
  });

  it("snapshots `pre` as the layered damage state before any mutation", () => {
    const s = mk({ armor: { centerTorso: 26 }, is: { centerTorso: 16 } });
    const app = applyDamage(s, "centerTorso", 30);
    expect(app.before.armor.centerTorso).toBe(26);
    expect(app.before.internalStructure.centerTorso).toBe(16);
    expect(app.before.armorRear).toEqual(s.armorRear);
  });

  it("leaves `pre` untouched when later mutating `damage` downstream", () => {
    const s = mk({ armor: { leftArm: 4 }, is: { leftArm: 4 } });
    const app = applyDamage(s, "leftArm", 4);
    app.after.armor.leftArm = -99;
    expect(app.before.armor.leftArm).toBe(4);
  });

  it("bypassArmor: armor survives where IS survives; a destroyed location loses it (TW p.122 step 5)", () => {
    const s = mk({ armor: { leftTorso: 10 }, is: { leftTorso: 7 } });
    const app = applyDamage(s, "leftTorso", 12, "front", { bypassArmor: true });
    expect(app.after.internalStructure.leftTorso).toBe(0);
    expect(app.after.armor.leftTorso).toBe(0);
    expect(app.newlyDestroyed).toContain("leftTorso");
  });

  it("bypassArmor: overflow transfers to the next location's IS, skipping its armor too", () => {
    const s = mk({
      armor: { leftTorso: 10, centerTorso: 10 },
      armorRear: { leftTorso: 10, centerTorso: 10 },
      is: { leftTorso: 5, centerTorso: 10 },
    });
    const app = applyDamage(s, "leftTorso", 12, "front", { bypassArmor: true });
    // LT IS 5 -> 0; the remaining 7 lands on CT IS directly, CT armor (front
    // and rear) untouched — TW ammo-explosion overflow goes to IS only.
    // The destroyed LT itself loses its remaining armor with it (TW p.122).
    expect(app.after.internalStructure.leftTorso).toBe(0);
    expect(app.after.armor.leftTorso).toBe(0);
    expect(app.after.armorRear.leftTorso).toBe(0);
    expect(app.after.internalStructure.centerTorso).toBe(3);
    expect(app.after.armor.centerTorso).toBe(10);
    expect(app.after.armorRear.centerTorso).toBe(10);
    expect(app.mechDestroyed).toBe(false);
  });

  it("bypassArmor: rear-arc damage also skips the rear armor pool", () => {
    const s = mk({
      armor: { centerTorso: 10 },
      armorRear: { centerTorso: 10 },
      is: { centerTorso: 6 },
    });
    const app = applyDamage(s, "centerTorso", 4, "rear", { bypassArmor: true });
    expect(app.after.armorRear.centerTorso).toBe(10);
    expect(app.after.internalStructure.centerTorso).toBe(2);
  });

  it("bypassArmor: a location the blast destroys loses its remaining armor (TW p.122 step 5)", () => {
    const s = mk({
      armor: { centerTorso: 10 },
      is: { centerTorso: 5 },
    });
    const app = applyDamage(s, "centerTorso", 5, "front", { bypassArmor: true });
    expect(app.mechDestroyed).toBe(true);
    expect(app.after.armor.centerTorso).toBe(0);
    expect(app.after.internalStructure.centerTorso).toBe(0);
  });

  it("plain destruction wipes the opposite-arc armor: front kill zeroes the rear pool", () => {
    const s = mk({
      armor: { rightTorso: 10 },
      armorRear: { rightTorso: 6 },
      is: { rightTorso: 4 },
    });
    const app = applyDamage(s, "rightTorso", 14, "front");
    expect(app.newlyDestroyed).toContain("rightTorso");
    expect(app.after.armor.rightTorso).toBe(0);
    expect(app.after.armorRear.rightTorso).toBe(0);
    expect(app.after.internalStructure.rightTorso).toBe(0);
    // Marked points exclude the wiped rear pool: 10 front + 4 IS, not 20.
    expect(dealtOf(app)).toBe(14);
  });

  it("plain destruction wipes the opposite-arc armor: rear kill zeroes the front pool", () => {
    const s = mk({
      armor: { leftTorso: 10 },
      armorRear: { leftTorso: 6 },
      is: { leftTorso: 4 },
    });
    const app = applyDamage(s, "leftTorso", 10, "rear");
    expect(app.newlyDestroyed).toContain("leftTorso");
    expect(app.after.armor.leftTorso).toBe(0);
    expect(app.after.armorRear.leftTorso).toBe(0);
    expect(app.after.internalStructure.leftTorso).toBe(0);
  });

  it("side-torso destruction zeroes its rear pool and the blown-off arm's armor", () => {
    const s = mk({
      armor: { rightTorso: 10, rightArm: 8 },
      armorRear: { rightTorso: 6 },
      is: { rightTorso: 4, rightArm: 9 },
    });
    const app = applyDamage(s, "rightTorso", 14, "front");
    expect(app.newlyDestroyed).toContain("rightTorso");
    expect(app.after.armorRear.rightTorso).toBe(0);
    expect(app.blownOffLimbs).toEqual(["rightArm"]);
    expect(app.after.armor.rightArm).toBe(0);
    expect(app.after.internalStructure.rightArm).toBe(0);
  });
});

describe("initialDamage", () => {
  function unitWith(damage?: UnitInitDamage, model = "HBK-4G", pilotHitMax = 6): UnitState {
    const a: UnitInit = {
      ...buildUnitInit("a", model, 1, { col: 1, row: 1 }, "n", 4, 5, pilotHitMax),
      ...(damage === undefined ? {} : { damage }),
    };
    const b = buildUnitInit("b", "ENF-4R", 2, { col: 3, row: 1 });
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
      expect(crittedWeapons(mechDefFor(u), u.critSlotsDestroyed)).toEqual([2, 3, 4]);
      expect(u.ammoBins["leftTorso:1"]!).toBe(loaded - 3);
      expect(u.ammoBins["leftTorso:2"]!).toBe(0); // destroyed bin is empty
      expect(u.jammedWeapons).toEqual([]);
    });

    it("keeps 'structure gone, crit slots alive' as given; the location's bins read as stranded", () => {
      const u = unitWith(wipe("HBK-4G", "leftTorso", "leftArm"));
      expect(u.damage.internalStructure.leftTorso).toBe(0);
      // Plain damage never flags slots (see damage.ts); neither do we.
      expect(u.critSlotsDestroyed.leftTorso).toBe(0);
      expect(u.critSlotsDestroyed.leftArm).toBe(0);
      // Bins keep their shots; the dead location (IS 0) makes them stranded.
      const loaded = unitWith().ammoBins;
      const def = mechDefFor(u);
      for (const id of ["leftTorso:1", "leftTorso:2"]) {
        const bin = collectAmmoBins(def).find((b) => b.id === id)!;
        expect(u.ammoBins[id]).toBe(loaded[id]!);
        expect(usableShots(u, bin)).toBe(0);
        expect(strandedShots(u, bin)).toBe(loaded[id]!);
      }
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
      expect(v.ammoBins["leftTorso:1"]).toBe(loaded["leftTorso:1"]!);
      expect(v.ammoBins["leftTorso:2"]).toBe(0); // destroyed slot: nothing left
    });

    it("a destroyed location with ammo used keeps its remaining shots as a stranded count", () => {
      const loaded = unitWith().ammoBins["leftTorso:1"]!;
      const u = unitWith({
        ...wipe("HBK-4G", "leftTorso", "leftArm"),
        ammoUsed: { "leftTorso:1": 3 },
      });
      expect(u.ammoBins["leftTorso:1"]).toBe(loaded - 3);
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
      const bad = (damage: UnitInitDamage, re: RegExp) =>
        expect(() => unitWith(damage)).toThrow(re);
      it("damage beyond the model", () => {
        bad({ damageTaken: { armor: { rightArm: 99 } } }, /exceeds/);
        bad({ damageTaken: { armorRear: { centerTorso: 99 } } }, /exceeds/);
        bad({ damageTaken: { internalStructure: { rightArm: 99 } } }, /exceeds/);
        bad({ damageTaken: { armor: { rightArm: -1 } } }, />= 0/);
      });
      it("structure behind intact armor is legal (ammo-explosion bypass)", () => {
        // Ammo-explosion overflow bypasses armor at every location in the
        // chain (TW p.123 Step 8, p.125), e.g. arm blast -> side torso.
        const full = unitWith().damage;
        const arm = unitWith({ damageTaken: { internalStructure: { rightArm: 1 } } });
        expect(arm.damage.internalStructure.rightArm).toBe(full.internalStructure.rightArm - 1);
        expect(arm.damage.armor.rightArm).toBe(full.armor.rightArm);
        const torso = unitWith({
          damageTaken: { armor: { centerTorso: 3 }, internalStructure: { centerTorso: 1 } },
        });
        expect(torso.damage.internalStructure.centerTorso).toBe(
          full.internalStructure.centerTorso - 1,
        );
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
      it("a destroyed location keeps no armor (TW p.122 step 5)", () => {
        const full = unitWith().damage;
        // Arm IS gone but its armor intact.
        bad(
          { damageTaken: { internalStructure: { rightArm: full.internalStructure.rightArm } } },
          /rightArm is destroyed but still has armor/,
        );
        // Side torso + arm IS gone, torso rear armor intact.
        const rear = full.armorRear.leftTorso;
        bad(
          {
            damageTaken: {
              armor: {
                leftTorso: full.armor.leftTorso,
                leftArm: full.armor.leftArm,
              },
              internalStructure: {
                leftTorso: full.internalStructure.leftTorso,
                leftArm: full.internalStructure.leftArm,
              },
            },
          },
          /leftTorso is destroyed but still has rear armor/,
        );
        expect(rear).toBeGreaterThan(0);
        // Fully wiped locations (armor and rear included) stay legal.
        expect(() => unitWith(wipe("HBK-4G", "leftTorso", "leftArm"))).not.toThrow();
      });
      it("bad crit slots", () => {
        bad({ critsDestroyed: { head: [99] } }, /no crit slot/);
        bad({ critsDestroyed: { head: [4, 4] } }, /listed twice/);
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

  describe("starting damage: empty crit slots", () => {
    it("drops a listed empty slot silently instead of failing", () => {
      // HBK-4G left arm slots 6-12 are empty.
      const u = unitWith({ critsDestroyed: { leftArm: [5, 12] } });
      expect(destroyedSlots(u.critSlotsDestroyed, "leftArm")).toEqual([4]);
      expect(() => unitWith({ critsDestroyed: { leftArm: [12] } })).not.toThrow();
    });

    it("keeps a listed soak slot (its gear is lost and needs refit)", () => {
      // TBR-Prime left torso: 9 endo steel, 10-11 ferro-fibrous, 12 empty.
      const u = unitWith({ critsDestroyed: { leftTorso: [3, 9, 10, 11, 12] } }, "TBR-Prime");
      expect(destroyedSlots(u.critSlotsDestroyed, "leftTorso")).toEqual([2, 8, 9, 10]);
    });

    it("carries over a Timber Wolf whose CASE'd LRM-20 ammo blew the left torso", () => {
      const def = mechDef("TBR-Prime")!;
      const damage: UnitDamageState = {
        armor: { ...def.armor },
        armorRear: { ...def.armorRear },
        internalStructure: { ...def.internalStructure },
      };
      const destroyed = emptyCritTable(def);
      const _ammoBins = loadAmmoBins(def);
      const ammoSlot = def.critSlots.leftTorso.findIndex((slot) => slot.kind === "ammo");
      const app = applyAmmoExplosion(damage, def, "leftTorso", 120);
      expect(app.newlyDestroyed).toContain("leftTorso");
      Object.assign(damage, app.after);
      for (const lost of app.newlyDestroyed) {
        markLocationCatastrophicallyDestroyed(def, damage, destroyed, lost);
      }
      // Slots 9-11 of the left torso are soak (marked, gear lost), 12 is empty (clear).
      expect(def.critSlots.leftTorso.slice(8).map((slot) => slot.kind)).toEqual([
        "soak",
        "soak",
        "soak",
        "empty",
      ]);
      expect(destroyedSlots(destroyed, "leftTorso")).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(isSlotDestroyed(destroyed, "leftTorso", ammoSlot)).toBe(true);

      // The end state written back as starting damage loads cleanly.
      const carry: UnitInitDamage = { damageTaken: {}, critsDestroyed: {} };
      for (const loc of LOCATIONS) {
        const taken = carry.damageTaken!;
        taken.armor = { ...taken.armor, [loc]: def.armor[loc] - damage.armor[loc] };
        taken.internalStructure = {
          ...taken.internalStructure,
          [loc]: def.internalStructure[loc] - damage.internalStructure[loc],
        };
        if (isTorso(loc)) {
          taken.armorRear = {
            ...taken.armorRear,
            [loc]: def.armorRear[loc] - damage.armorRear[loc],
          };
        }
        carry.critsDestroyed![loc] = destroyedSlots(destroyed, loc).map((i) => i + 1);
      }
      const start = resolveInitialDamage(def, "tbr", carry, 6);
      expect(start.critSlotsDestroyed).toEqual(destroyed);
      expect(start.damage.internalStructure.leftTorso).toBe(0);

      // A carry-over written by the old wipe (all 12 bits set) loads the same.
      const legacy: UnitInitDamage = {
        ...carry,
        critsDestroyed: {
          ...carry.critsDestroyed,
          leftTorso: def.critSlots.leftTorso.map((_, i) => i + 1),
        },
      };
      expect(resolveInitialDamage(def, "tbr", legacy, 6).critSlotsDestroyed).toEqual(destroyed);
    });

    it("reports a fully wrecked unit as starting destroyed, not as malformed", () => {
      const def = mechDef("HBK-4G")!;
      const everySlot: UnitInitDamage["critsDestroyed"] = {};
      for (const loc of LOCATIONS) everySlot[loc] = def.critSlots[loc].map((_, i) => i + 1);
      expect(() => resolveInitialDamage(def, "x", { critsDestroyed: everySlot }, 6)).toThrow(
        /would start destroyed \(cockpitDestroyed\)/,
      );
    });
  });
});
