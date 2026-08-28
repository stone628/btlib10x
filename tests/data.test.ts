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

  it("matches record-sheet stats for the Hunchback", () => {
    const hbk = MECH_DEFS["HBK-4G"]!;
    expect(hbk.name).toBe("Hunchback");
    expect(hbk.tonnage).toBe(50);
    expect(hbk.walking).toBe(4);
    expect(hbk.running).toBe(6);
    expect(hbk.jumping).toBe(0);
    expect(hbk.armor.centerTorso).toBe(26);
    expect(hbk.armor.head).toBe(9);
    expect(hbk.weapons.map((w) => w.weapon)).toContain("Autocannon/20");
  });

  it("spot-checks remaining sheets", () => {
    expect(MECH_DEFS["ENF-4R"]!.armor.centerTorso).toBe(23);
    expect(MECH_DEFS["GRF-1N"]!.jumping).toBe(5);
    expect(MECH_DEFS["GRF-1N"]!.armor.centerTorso).toBe(24);
    expect(MECH_DEFS["CDA-3MA"]!.walking).toBe(8);
    expect(MECH_DEFS["HER-5SA"]!.running).toBe(9);
    const wvr = MECH_DEFS["WVR-6R"]!;
    expect(wvr.weapons.find((w) => w.weapon === "SRM 6")?.ammoShots).toBe(15);
    const atlas = MECH_DEFS["AS7-D"]!;
    expect(atlas.tonnage).toBe(100);
    expect(atlas.weightClass).toBe("Assault");
    expect(atlas.running).toBe(5);
    expect(atlas.weapons.find((w) => w.weapon === "LRM 20")?.ammoShots).toBe(12);
  });

  it("rejects invalid definitions", () => {
    const base = MECH_DEFS["HBK-4G"]!;
    expect(() => validateMechDef({ ...base, running: 7 })).toThrow(/running/);
    expect(() => validateMechDef({ ...base, armor: { ...base.armor, head: -1 } })).toThrow(
      /armor\.head/,
    );
    expect(() =>
      validateMechDef({
        ...base,
        armor: { ...base.armor, center: 10 },
      }),
    ).toThrow(/not a valid location/);
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

  it("encodes missile and rapid-fire behavior used by the attack pipeline", () => {
    expect(getWeapon("LRM 10").missiles).toBe(10);
    expect(getWeapon("LRM 10").missileDamage).toBe(1);
    expect(getWeapon("SRM 6").missiles).toBe(6);
    expect(getWeapon("SRM 6").missileDamage).toBe(2);
    expect(getWeapon("Ultra AC/5").rapidFireShots).toBe(2);
    expect(getWeapon("Autocannon/20").rapidFireShots).toBeUndefined();
  });

  it("encodes Clan weapons added for the Mad Cat Mk II", () => {
    expect(getWeapon("CL ER Medium Laser").damage).toBe(7);
    expect(getWeapon("CL Gauss Rifle").damage).toBe(15);
    expect(getWeapon("CL LB 20-X AC").damage).toBe(20);
    expect(getWeapon("CL Streak SRM 4").missiles).toBe(4);
    expect(getWeapon("CL Streak SRM 4").missileDamage).toBe(2);
  });
});
