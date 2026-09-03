import { describe, expect, it } from "vitest";
import { LOCATIONS } from "../src/core/types.js";
import { resolveWeaponAttack } from "../src/rules/attack.js";
import type { LocationValue, UnitDamageState } from "../src/rules/damage.js";
import { transferDetail } from "../web/format.js";
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

const BASE = {
  gunnery: 4,
  attackerMoved: "standStill",
  targetHexesMoved: 0,
  targetJumped: false,
  targetTerrain: "clear",
  interveningTerrains: [],
  distance: 1,
} as const;

function strike(
  targetDamage: UnitDamageState,
  rng: ReturnType<typeof scriptedRng>,
  weaponName = "Small Laser",
  arc?: "front" | "rear",
) {
  return resolveWeaponAttack({
    ...BASE,
    rng,
    weaponName,
    targetDamage,
    ...(arc === undefined ? {} : { arc }),
  });
}

describe("transferDetail", () => {
  it("shows armor-only `before→after` for a non-penetrating hit", () => {
    const s = freshState();
    const rng = scriptedRng(6, 6, 3, 3); // to-hit 12, location 6 -> RT, dmg 3
    const res = strike(s, rng);
    expect(res.application?.before.armor.rightTorso).toBe(10);
    const text = transferDetail("en", res);
    expect(text).not.toBeNull();
    expect(text).toMatch(/RTA 10->7\b/);
    expect(text).not.toMatch(/RTI/);
  });

  it("shows armor-then-structure at the same location for a penetrating hit", () => {
    const armor = {} as LocationValue;
    const is = {} as LocationValue;
    for (const loc of LOCATIONS) {
      armor[loc] = loc === "rightTorso" ? 2 : 10;
      is[loc] = 10;
    }
    const s: UnitDamageState = { armor, armorRear: {}, internalStructure: is };
    const rng = scriptedRng(6, 6, 3, 3); // to-hit 12, location 6 -> RT, dmg 3
    const res = strike(s, rng);
    const text = transferDetail("en", res);
    expect(text).not.toBeNull();
    expect(text).toMatch(/RTA 2->0\*?/);
    expect(text).toMatch(/RTI 10->9\b/);
  });

  it("uses `app.before` as the snapshot, not a reconstruction from `after`", () => {
    const s = freshState();
    const rng = scriptedRng(6, 6, 3, 3); // to-hit 12, location 6 -> RT
    const res = strike(s, rng);
    expect(res.application?.before).toBeDefined();
    if (res.application) {
      const beforeRear = res.application.before.armorRear;
      const beforeArmor = res.application.before.armor;
      expect(beforeRear).toEqual({});
      expect(beforeArmor.rightTorso).toBe(10);
    }
  });

  it("never emits NaN for a step at a fresh location", () => {
    const s = freshState();
    const rng = scriptedRng(6, 6, 3, 3);
    const res = strike(s, rng);
    const text = transferDetail("en", res) ?? "";
    expect(text).not.toMatch(/NaN/);
  });

  it("labels torso armor as front-armor F when a rear pool is present", () => {
    const s: UnitDamageState = {
      ...freshState(),
      armorRear: { rightTorso: 5 },
    };
    const rng = scriptedRng(6, 6, 3, 3); // to-hit 12, location 6 -> RT, dmg 3
    const res = strike(s, rng);
    expect(res.application?.before.armorRear.rightTorso).toBe(5);
    const text = transferDetail("en", res) ?? "";
    expect(text).toMatch(/RTF 10->7\b/);
    expect(text).not.toMatch(/RTA/);
  });

  it("labels non-torso armor as plain armor A (no rear pool)", () => {
    const s = freshState();
    const rng = scriptedRng(6, 6, 4, 5); // to-hit 12, location 9 -> leftLeg, dmg 3
    const res = strike(s, rng);
    expect(res.application?.before.armor.leftLeg).toBe(10);
    const text = transferDetail("en", res) ?? "";
    expect(text).toMatch(/LLA 10->7\b/);
    expect(text).not.toMatch(/LLF/);
  });

  it("labels rear-arc torso hits on the rear pool as R", () => {
    const s: UnitDamageState = {
      ...freshState(),
      armorRear: { rightTorso: 5 },
    };
    const rng = scriptedRng(6, 6, 3, 3); // to-hit 12, location 6 -> RT, rear arc
    const res = strike(s, rng, "Small Laser", "rear");
    expect(res.application?.before.armorRear.rightTorso).toBe(5);
    const text = transferDetail("en", res) ?? "";
    expect(text).toMatch(/RTR 5->2\b/);
    expect(text).not.toMatch(/RT[AFI]/);
  });
});
