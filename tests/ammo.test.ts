import { describe, expect, it } from "vitest";
import { allAmmo, ammoDefFor, shotsPerBinFor } from "../src/data/ammo.schema";
import { weaponDefFor } from "../src/data/weapon.schema";

describe("ammo catalog", () => {
  it("every ammo weapon resolves as a catalog weapon", () => {
    for (const ammo of allAmmo()) {
      expect(weaponDefFor({ weapon: ammo.weapon }).name).toBe(ammo.weapon);
    }
  });

  it("getShotsPerBinFor returns undefined for non-ammo weapons", () => {
    expect(shotsPerBinFor({ weapon: "Medium Laser" })).toBeUndefined();
    expect(shotsPerBinFor({ weapon: "Flamer" })).toBeUndefined();
    expect(shotsPerBinFor({ weapon: "Not A Weapon" })).toBeUndefined();
  });

  it("getAmmoDefFor throws on an unknown weapon", () => {
    expect(() => ammoDefFor({ weapon: "Not A Weapon" })).toThrow();
  });
});
