import { describe, expect, it } from "vitest";
import { LOCATIONS } from "../src/core/types.js";
import type { ArmorState } from "../src/rules/damage.js";
import { applyDamage, canFireFromLocation, isImmobile, isKilled } from "../src/rules/damage.js";

function fullArmor(hp: number): ArmorState {
  const armor = {} as ArmorState;
  for (const loc of LOCATIONS) armor[loc] = hp;
  return armor;
}

describe("damage resolution", () => {
  // CBT-QS p.17 example: Hunchback left arm (16 armor) takes AC/10,
  // large laser (8), small laser (3). Arm destroyed by laser; 2 points
  // transfer to left torso; small laser then reduces LT 20 -> 15.
  it("reproduces the Hunchback damage-transfer example", () => {
    let armor: ArmorState = fullArmor(10);
    armor.leftArm = 16;
    armor.leftTorso = 20;

    let app = applyDamage(armor, "leftArm", 10);
    armor = app.armor;
    expect(armor.leftArm).toBe(6);

    app = applyDamage(armor, "leftArm", 8);
    armor = app.armor;
    expect(app.newlyDestroyed).toContain("leftArm");
    expect(armor.leftArm).toBe(0);
    expect(armor.leftTorso).toBe(18);

    app = applyDamage(armor, "leftArm", 3);
    armor = app.armor;
    expect(app.steps[0]).toMatchObject({ location: "leftTorso", damageApplied: 3 });
    expect(armor.leftTorso).toBe(15);
    expect(isKilled(armor)).toBe(false);
  });

  // Beginner Box p.8 example: Wolverine LA with 11 remaining takes PPC (10),
  // then LRM lots of 5 and 3 -> arm destroyed, 4 overflow to LT, +3 more.
  it("reproduces the Wolverine damage-transfer example", () => {
    let armor: ArmorState = fullArmor(30);
    armor.leftArm = 11;
    armor.leftTorso = 20;

    let app = applyDamage(armor, "leftArm", 10);
    armor = app.armor;
    expect(armor.leftArm).toBe(1);

    app = applyDamage(armor, "leftArm", 5);
    armor = app.armor;
    expect(app.newlyDestroyed).toContain("leftArm");
    expect(armor.leftTorso).toBe(16);

    app = applyDamage(armor, "leftArm", 3);
    armor = app.armor;
    expect(armor.leftTorso).toBe(13);
  });

  it("transfers fully when hitting an already-destroyed location", () => {
    const armor = fullArmor(10);
    armor.rightArm = 0;
    const app = applyDamage(armor, "rightArm", 4);
    expect(app.steps[0]?.location).toBe("rightTorso");
    expect(app.armor.rightTorso).toBe(6);
  });

  it("blows off the arm when its side torso is destroyed", () => {
    const armor = fullArmor(10);
    armor.rightTorso = 5;
    const app = applyDamage(armor, "rightTorso", 8);
    expect(app.blownOffArms).toEqual(["rightArm"]);
    expect(app.armor.rightArm).toBe(0);
    expect(canFireFromLocation(app.armor, "rightArm")).toBe(false);
    expect(canFireFromLocation(app.armor, "rightTorso")).toBe(false);
  });

  it("kills via center torso or head and stops transferring there", () => {
    const a = fullArmor(10);
    const ctHit = applyDamage(a, "centerTorso", 25);
    expect(ctHit.killed).toBe(true);

    const b = fullArmor(10);
    b.head = 3;
    const headHit = applyDamage(b, "head", 3);
    expect(headHit.killed).toBe(true);
    expect(isKilled(headHit.armor)).toBe(true);
  });

  it("immobilizes when either leg is destroyed but the 'Mech survives", () => {
    const armor = fullArmor(10);
    armor.leftLeg = 2;
    const app = applyDamage(armor, "leftLeg", 5);
    expect(app.armor.leftLeg).toBe(0);
    expect(isImmobile(app.armor)).toBe(true);
    expect(isKilled(app.armor)).toBe(false);
  });
});
