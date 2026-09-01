import { describe, expect, it } from "vitest";
import type { ResolvedMechDef } from "../src/data/index.js";
import { getAllMechDefs, getMechDef, resolveMechDef, validateMechDef } from "../src/data/index.js";
import { getWeaponOrThrow } from "../src/data/weapons.js";

describe("'Mech definitions", () => {
  it("ships more than one 'Mech and every model is registered", () => {
    expect(getAllMechDefs().length).toBeGreaterThan(1);
    for (const def of getAllMechDefs()) {
      expect(getMechDef(def.model)).toBe(def);
      expect(def.model).not.toBe("");
    }
  });

  it("re-validates every bundled definition", () => {
    for (const def of getAllMechDefs()) {
      expect(() => validateMechDef({ ...def, weapons: Object.values(def.weapons) })).not.toThrow();
    }
  });

  it("matches record-sheet stats for the Hunchback", () => {
    const hbk = getMechDef("HBK-4G")!;
    expect(hbk.name).toBe("Hunchback");
    expect(hbk.tonnage).toBe(50);
    expect(hbk.walking).toBe(4);
    expect(hbk.running).toBe(6);
    expect(hbk.jumping).toBe(0);
    expect(hbk.armor.centerTorso).toBe(26);
    expect(hbk.armor.head).toBe(9);
    expect(Object.values(hbk.weapons).map((w) => w.weapon)).toContain("Autocannon/20");
  });

  it("spot-checks remaining sheets", () => {
    expect(getMechDef("ENF-4R")!.armor.centerTorso).toBe(23);
    expect(getMechDef("GRF-1N")!.jumping).toBe(5);
    expect(getMechDef("GRF-1N")!.armor.centerTorso).toBe(20);
    expect(getMechDef("CDA-3MA")!.walking).toBe(8);
    expect(getMechDef("HER-5SA")!.running).toBe(9);
    const wvr = getMechDef("WVR-6R")!;
    expect(Object.values(wvr.weapons).find((w) => w.weapon === "SRM 6")?.shots).toBe(15);
    const atlas = getMechDef("AS7-D")!;
    expect(atlas.tonnage).toBe(100);
    expect(atlas.weightClass).toBe("Assault");
    expect(atlas.running).toBe(5);
    expect(Object.values(atlas.weapons).find((w) => w.weapon === "LRM 20")?.shots).toBe(12);
  });

  it("keeps MTF armor fidelity (front + rear) in JSON and splits it on resolve", () => {
    const json = {
      model: "TEST",
      name: "Test",
      tonnage: 50,
      weightClass: "Medium",
      techBase: "Inner Sphere",
      walking: 4,
      running: 6,
      jumping: 0,
      armor: {
        head: 9,
        centerTorso: 26,
        rightTorso: 20,
        leftTorso: 20,
        rightArm: 16,
        leftArm: 16,
        rightLeg: 20,
        leftLeg: 20,
        centerTorsoRear: 5,
        rightTorsoRear: 4,
        leftTorsoRear: 4,
      },
      weapons: [{ weapon: "Medium Laser", location: "centerTorso" }],
      critSlots: {
        head: new Array(6).fill({ kind: "empty" }),
        centerTorso: new Array(12).fill({ kind: "empty" }),
        rightTorso: new Array(12).fill({ kind: "empty" }),
        leftTorso: new Array(12).fill({ kind: "empty" }),
        rightArm: new Array(12).fill({ kind: "empty" }),
        leftArm: new Array(12).fill({ kind: "empty" }),
        rightLeg: new Array(6).fill({ kind: "empty" }),
        leftLeg: new Array(6).fill({ kind: "empty" }),
      },
      source: "test",
    };
    const raw = validateMechDef(json);
    expect(raw.armor.centerTorso).toBe(26);
    expect(raw.armor.centerTorsoRear).toBe(5);
    expect(raw.armor.rightTorsoRear).toBe(4);
    expect(raw.armor.leftTorsoRear).toBe(4);
    const resolved = resolveMechDef(raw);
    expect(resolved.armor.centerTorso).toBe(26);
    expect(resolved.armor.rightTorso).toBe(20);
    expect("centerTorsoRear" in resolved.armor).toBe(false);
    expect(resolved.armorRear.centerTorso).toBe(5);
    expect(resolved.armorRear.rightTorso).toBe(4);
    expect(resolved.armorRear.leftTorso).toBe(4);
    expect(resolved.internalStructure.centerTorso).toBe(16);
    expect(resolved.internalStructure.rightTorso).toBe(12);
    expect(resolved.internalStructure.rightArm).toBe(8);
  });

  it("derives internal structure from the tonnage table on resolve", () => {
    const toMechDef = (d: ResolvedMechDef) => ({
      ...d,
      weapons: Object.values(d.weapons),
    });
    expect(resolveMechDef(toMechDef(getMechDef("WVR-6R")!)).internalStructure.centerTorso).toBe(18);
    expect(resolveMechDef(toMechDef(getMechDef("AS7-D")!)).internalStructure.centerTorso).toBe(31);
    expect(resolveMechDef(toMechDef(getMechDef("AS7-D")!)).internalStructure.rightArm).toBe(17);
  });

  it("rejects invalid rear armor entries in the JSON schema", () => {
    const base = getMechDef("HBK-4G")!;
    const toMechDef = (d: typeof base) => ({ ...d, weapons: Object.values(d.weapons) });
    expect(() =>
      validateMechDef({
        ...toMechDef(base),
        armor: { ...base.armor, centerTorsoRear: -3 },
      }),
    ).toThrow(/armor\.centerTorsoRear must be a non-negative integer/);
    expect(() =>
      validateMechDef({
        ...toMechDef(base),
        armor: { ...base.armor, leftTorsoRear: 1.5 },
      }),
    ).toThrow(/armor\.leftTorsoRear must be a non-negative integer/);
  });

  it("rejects invalid definitions", () => {
    const base = getMechDef("HBK-4G")!;
    const toMechDef = (d: typeof base) => ({ ...d, weapons: Object.values(d.weapons) });
    expect(() => validateMechDef({ ...toMechDef(base), running: 7 })).toThrow(/running/);
    expect(() =>
      validateMechDef({ ...toMechDef(base), armor: { ...base.armor, head: -1 } }),
    ).toThrow(/armor\.head/);
    expect(() =>
      validateMechDef({
        ...toMechDef(base),
        armor: { ...base.armor, center: 10 },
      }),
    ).toThrow(/not a valid location/);
  });
});

describe("weapon catalog", () => {
  it("resolves every weapon referenced by a bundled 'Mech", () => {
    for (const def of getAllMechDefs()) {
      for (const mount of Object.values(def.weapons)) {
        expect(getWeaponOrThrow(mount.weapon).name, `${def.model}: ${mount.weapon}`).toBe(
          mount.weapon,
        );
      }
    }
  });

  it("throws on genuinely unknown weapon names", () => {
    expect(() => getWeaponOrThrow("Not A Weapon")).toThrow();
  });

  it("encodes missile and rapid-fire behavior used by the attack pipeline", () => {
    expect(getWeaponOrThrow("LRM 10").missiles).toBe(10);
    expect(getWeaponOrThrow("LRM 10").missileDamage).toBe(1);
    expect(getWeaponOrThrow("SRM 6").missiles).toBe(6);
    expect(getWeaponOrThrow("SRM 6").missileDamage).toBe(2);
    expect(getWeaponOrThrow("Ultra AC/5").rapidFireShots).toBe(2);
    expect(getWeaponOrThrow("Autocannon/20").rapidFireShots).toBeUndefined();
  });

  it("encodes Clan weapons added for the Mad Cat Mk II", () => {
    expect(getWeaponOrThrow("CL ER Medium Laser").damage).toBe(7);
    expect(getWeaponOrThrow("CL Gauss Rifle").damage).toBe(15);
    expect(getWeaponOrThrow("CL LB 20-X AC").damage).toBe(20);
    expect(getWeaponOrThrow("CL Streak SRM 4").missiles).toBe(4);
    expect(getWeaponOrThrow("CL Streak SRM 4").missileDamage).toBe(2);
  });
});
