import { describe, expect, it } from "vitest";
import { getMechDef, MECH_DEFS, validateMechDef } from "../src/data/index.js";
import { getWeapon } from "../src/data/weapons.js";

describe("'Mech definitions", () => {
  it("ships more than one 'Mech and every model is registered", () => {
    expect(Object.keys(MECH_DEFS).length).toBeGreaterThan(1);
    for (const model of Object.keys(MECH_DEFS)) {
      expect(getMechDef(model)).toBe(MECH_DEFS[model]);
      expect(model).not.toBe("");
    }
  });

  it("re-validates every bundled definition", () => {
    for (const def of Object.values(MECH_DEFS)) {
      expect(() => validateMechDef(def)).not.toThrow();
    }
  });
});

describe("weapon catalog", () => {
  it("resolves every weapon referenced by a bundled 'Mech", () => {
    for (const def of Object.values(MECH_DEFS)) {
      for (const mount of def.weapons) {
        expect(getWeapon(mount.weapon).name, `${def.model}: ${mount.weapon}`).toBe(mount.weapon);
      }
    }
  });

  it("throws on genuinely unknown weapon names", () => {
    expect(() => getWeapon("Not A Weapon")).toThrow();
  });
});
