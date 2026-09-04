import { describe, expect, it } from "vitest";
import {
  getAllAmmo,
  getAmmoDefFor,
  getShotsPerBinFor,
  listAmmoWeapons,
} from "../src/data/ammo.schema.js";
import { getAllMechDefs, getMechDef, validateMechDef } from "../src/data/index.js";
import { getWeaponDefFor } from "../src/data/weapon.schema.js";

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
      expect(getWeaponDefFor({ weapon: ammo.weapon }).name).toBe(ammo.weapon);
    }
  });

  it("getShotsPerBinFor returns the catalog value for known ammo weapons", () => {
    for (const ammo of getAllAmmo()) {
      expect(getShotsPerBinFor({ weapon: ammo.weapon })).toBe(ammo.shotsPerBin);
    }
  });

  it("getShotsPerBinFor returns undefined for non-ammo weapons", () => {
    expect(getShotsPerBinFor({ weapon: "Medium Laser" })).toBeUndefined();
    expect(getShotsPerBinFor({ weapon: "Flamer" })).toBeUndefined();
    expect(getShotsPerBinFor({ weapon: "Not A Weapon" })).toBeUndefined();
  });

  it("getAmmoDefFor throws on an unknown weapon", () => {
    expect(() => getAmmoDefFor({ weapon: "Not A Weapon" })).toThrow();
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
