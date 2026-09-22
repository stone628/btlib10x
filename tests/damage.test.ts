import { describe, expect, it } from "vitest";
import { LOCATIONS } from "../src/core/types.js";
import type { LocationValue, TorsoLocationValue, UnitDamageState } from "../src/rules/damage.js";
import {
  applyDamage,
  canAttemptStandUp,
  canFireFromLocation,
  destroyedArms,
  destroyedLegs,
  isUnitDestroyed,
  isUnitImmobile,
} from "../src/rules/damage.js";

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
    expect(app.killed).toBe(false);
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
    expect(app.killed).toBe(true);
    expect(app.after.armorRear.centerTorso).toBe(0);
    expect(app.after.internalStructure.centerTorso).toBe(0);
  });

  it("blows the arm off when its side torso structure is destroyed", () => {
    const s = mk({ armor: { leftTorso: 0, leftArm: 10 }, is: { leftTorso: 8, leftArm: 9 } });
    const app = applyDamage(s, "leftTorso", 8);
    expect(app.newlyDestroyed).toContain("leftTorso");
    expect(app.blownOffArms).toEqual(["leftArm"]);
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
    expect(applyDamage(ct, "centerTorso", 4).killed).toBe(true);

    const head = mk({ armor: { head: 0 }, is: { head: 2 } });
    const headApp = applyDamage(head, "head", 2);
    expect(headApp.killed).toBe(true);
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

  it("bypassArmor: damage hits IS directly at the initial location, armor untouched", () => {
    const s = mk({ armor: { leftTorso: 10 }, is: { leftTorso: 7 } });
    const app = applyDamage(s, "leftTorso", 12, "front", { bypassArmor: true });
    expect(app.after.armor.leftTorso).toBe(10);
    expect(app.after.internalStructure.leftTorso).toBe(0);
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
    expect(app.after.internalStructure.leftTorso).toBe(0);
    expect(app.after.internalStructure.centerTorso).toBe(3);
    expect(app.after.armor.centerTorso).toBe(10);
    expect(app.after.armorRear.centerTorso).toBe(10);
    expect(app.killed).toBe(false);
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

  it("bypassArmor: preserves armor even when the 'Mech is killed by the blast", () => {
    const s = mk({
      armor: { centerTorso: 10 },
      is: { centerTorso: 5 },
    });
    const app = applyDamage(s, "centerTorso", 5, "front", { bypassArmor: true });
    expect(app.killed).toBe(true);
    expect(app.after.armor.centerTorso).toBe(10);
    expect(app.after.internalStructure.centerTorso).toBe(0);
  });
});
