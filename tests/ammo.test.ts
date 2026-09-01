import { describe, expect, it } from "vitest";
import {
  getAllAmmo,
  getAmmoOrThrow,
  getShotsPerBin,
  listAmmoWeapons,
} from "../src/data/ammo.schema.js";
import { getAllMechDefs, getMechDef, validateMechDef } from "../src/data/index.js";
import { getWeaponOrThrow } from "../src/data/weapon.schema.js";

describe("ammo catalog", () => {
  it("ships every ammo-bearing weapon in the catalog", () => {
    expect(getAllAmmo().length).toBeGreaterThan(0);
  });

  it("has no duplicate weapon names", () => {
    const names = listAmmoWeapons();
    expect(new Set(names).size).toBe(names.length);
  });

  it("every ammo weapon resolves as a catalog weapon", () => {
    for (const ammo of getAllAmmo()) {
      expect(getWeaponOrThrow(ammo.weapon).name).toBe(ammo.weapon);
    }
  });

  it("getShotsPerBin returns the catalog value for known ammo weapons", () => {
    for (const ammo of getAllAmmo()) {
      expect(getShotsPerBin(ammo.weapon)).toBe(ammo.shotsPerBin);
    }
  });

  it("getShotsPerBin returns undefined for non-ammo weapons", () => {
    expect(getShotsPerBin("Medium Laser")).toBeUndefined();
    expect(getShotsPerBin("Flamer")).toBeUndefined();
    expect(getShotsPerBin("Not A Weapon")).toBeUndefined();
  });

  it("getAmmoOrThrow throws on an unknown weapon", () => {
    expect(() => getAmmoOrThrow("Not A Weapon")).toThrow();
  });
});

describe("ammo validation in MechDef", () => {
  it("re-validates every bundled definition with the ammo rule", () => {
    for (const def of getAllMechDefs()) {
      expect(() => validateMechDef({ ...def, weapons: Object.values(def.weapons) })).not.toThrow();
    }
  });

  it("rejects a mount.shots that is not a multiple of shotsPerBin", () => {
    const base = getMechDef("HBK-4G")!;
    expect(() =>
      validateMechDef({
        ...base,
        weapons: Object.values(base.weapons).map((w) =>
          w.weapon === "Autocannon/20" ? { ...w, shots: 7 } : w,
        ),
      }),
    ).toThrow(/must be a multiple/);
  });

  it("rejects an ammo crit slot whose weapon has no ammo definition", () => {
    const base = getMechDef("HBK-4G")!;
    expect(() =>
      validateMechDef({
        ...base,
        critSlots: {
          ...base.critSlots,
          head: base.critSlots.head.map((s, i) =>
            i === 0 ? { kind: "ammo" as const, weapon: "Medium Laser" } : s,
          ),
        },
      }),
    ).toThrow(/has no ammo definition/);
  });
});
