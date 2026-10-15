import { describe, expect, it } from "vitest";
import { isTorso, LOCATIONS, type Location } from "../src/core/types";
import { mechDef, mechDefFor } from "../src/data/index";
import { collectAmmoBins, loadAmmoBins, strandedShots, usableShots } from "../src/rules/ammo";
import {
  applyAmmoExplosion,
  checkCASE,
  crittedWeapons,
  destroyedSlots,
  emptyCritTable,
  isSlotDestroyed,
  markLocationCatastrophicallyDestroyed,
} from "../src/rules/critical";
import { canAttemptStandUp, type UnitDamageState } from "../src/rules/damage";
import { buildUnitInit, type UnitInit, type UnitState } from "../src/rules/game";
import { resolveInitialDamage, type UnitInitDamage } from "../src/rules/initialDamage";
import { createTestBattle } from "./helpers";

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
    const bad = (damage: UnitInitDamage, re: RegExp) => expect(() => unitWith(damage)).toThrow(re);
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
    const app = applyAmmoExplosion(damage, "leftTorso", 120, checkCASE(def, "leftTorso"));
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
        taken.armorRear = { ...taken.armorRear, [loc]: def.armorRear[loc] - damage.armorRear[loc] };
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
