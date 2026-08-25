import { describe, expect, it } from "vitest";
import { MECH_DEFS, validateMechDef } from "../src/data/index.js";
import { getWeapon, WEAPONS } from "../src/data/weapons.js";

describe("'Mech definitions", () => {
  it("ships all six record-sheet 'Mechs", () => {
    expect(Object.keys(MECH_DEFS).sort()).toEqual([
      "CDA-3MA",
      "ENF-4R",
      "GRF-1N",
      "HBK-4G",
      "HER-5SA",
      "WVR-6R",
    ]);
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
  it("throws on unknown weapon names", () => {
    expect(() => getWeapon("Gauss Rifle")).toThrow();
    expect(getWeapon("PPC").name).toBe("PPC");
  });

  it("encodes missile and rapid-fire behavior used by the attack pipeline", () => {
    expect(getWeapon("LRM 10").missiles).toBe(10);
    expect(getWeapon("LRM 10").missileDamage).toBe(1);
    expect(getWeapon("SRM 6").missiles).toBe(6);
    expect(getWeapon("SRM 6").missileDamage).toBe(2);
    expect(getWeapon("Ultra AC/5").rapidFireShots).toBe(2);
    expect(getWeapon("Autocannon/20").rapidFireShots).toBeUndefined();
  });

  it("lists at least the quick-start arsenal", () => {
    const names = new Set(Object.values(WEAPONS).map((w) => w.name));
    for (const expected of [
      "Small Laser",
      "Medium Laser",
      "Large Laser",
      "PPC",
      "Snub-Nose PPC",
      "Flamer",
      "Machine Gun",
      "Autocannon/5",
      "Autocannon/10",
      "Autocannon/20",
      "Ultra AC/5",
      "Large Pulse Laser",
      "Small Pulse Laser",
      "LRM 5",
      "LRM 10",
      "SRM 6",
    ]) {
      expect(names.has(expected), expected).toBe(true);
    }
  });
});
