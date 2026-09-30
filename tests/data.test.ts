import { describe, expect, it } from "vitest";
import type { MechDef, ResolvedMechDef } from "../src/data/index";
import { allMechDefs, mechDef, resolveMechDef, validateMechDef } from "../src/data/index";
import { WEAPON_DATA } from "../src/data/weapon.data";
import { parseWeaponsData, weaponDefFor } from "../src/data/weapon.schema";

/** Strip engine-resolved fields to recover a MechDef (for testing). */
function toMechDef(d: ResolvedMechDef): MechDef {
  const { armorRear: _ar, internalStructure: _is, weapons: rw, ...rest } = d;
  return { ...rest, weapons: Object.values(rw) };
}

describe("'Mech definitions", () => {
  it("ships more than one 'Mech and every model is registered", () => {
    expect(allMechDefs().length).toBeGreaterThan(1);
    for (const def of allMechDefs()) {
      expect(mechDef(def.model)).toBe(def);
      expect(def.model).not.toBe("");
    }
  });

  it("re-validates every bundled definition", () => {
    for (const def of allMechDefs()) {
      expect(() => validateMechDef(toMechDef(def))).not.toThrow();
    }
  });

  it("matches record-sheet stats for the Hunchback", () => {
    const hbk = mechDef("HBK-4G")!;
    expect(hbk.name).toBe("Hunchback");
    expect(hbk.tonnage).toBe(50);
    expect(hbk.walking).toBe(4);
    expect(hbk.running).toBe(6);
    expect(hbk.jumping).toBe(0);
    expect(hbk.armor.centerTorso).toBe(31);
    expect(hbk.armor.head).toBe(9);
    expect(Object.values(hbk.weapons).map((w) => w.weapon)).toContain("AC/20");
  });

  it("spot-checks remaining sheets", () => {
    expect(mechDef("ENF-4R")!.armor.centerTorso).toBe(27);
    expect(mechDef("GRF-1N")!.jumping).toBe(5);
    expect(mechDef("GRF-1N")!.armor.centerTorso).toBe(27);
    expect(mechDef("CDA-3MA")!.walking).toBe(8);
    expect(mechDef("HER-5SA")!.running).toBe(9);
    const wvr = mechDef("WVR-6R")!;
    expect(Object.values(wvr.weapons).find((w) => w.weapon === "SRM 6")?.shots).toBe(15);
    const atlas = mechDef("AS7-D")!;
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
      walking: 5,
      running: 8,
      jumping: 0,
      heatsink: { type: "single" as const, count: 10 },
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
      weapons: [{ weapon: "Medium Laser", location: "centerTorso" as const }],
      critSlots: {
        head: new Array(6).fill({ kind: "empty" as const }),
        centerTorso: new Array(12).fill({ kind: "empty" as const }),
        rightTorso: new Array(12).fill({ kind: "empty" as const }),
        leftTorso: new Array(12).fill({ kind: "empty" as const }),
        rightArm: new Array(12).fill({ kind: "empty" as const }),
        leftArm: new Array(12).fill({ kind: "empty" as const }),
        rightLeg: new Array(6).fill({ kind: "empty" as const }),
        leftLeg: new Array(6).fill({ kind: "empty" as const }),
      },
      source: "test",
    } satisfies MechDef;
    expect(() => validateMechDef(json)).not.toThrow();
    expect(json.armor.centerTorso).toBe(26);
    expect(json.armor.centerTorsoRear).toBe(5);
    expect(json.armor.rightTorsoRear).toBe(4);
    expect(json.armor.leftTorsoRear).toBe(4);
    const resolved = resolveMechDef(json);
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
    expect(resolveMechDef(toMechDef(mechDef("WVR-6R")!)).internalStructure.centerTorso).toBe(18);
    expect(resolveMechDef(toMechDef(mechDef("AS7-D")!)).internalStructure.centerTorso).toBe(31);
    expect(resolveMechDef(toMechDef(mechDef("AS7-D")!)).internalStructure.rightArm).toBe(17);
  });

  it("rejects invalid rear armor entries in the JSON schema", () => {
    const base = toMechDef(mechDef("HBK-4G")!);
    expect(() =>
      validateMechDef({ ...base, armor: { ...base.armor, centerTorsoRear: -3 } } as MechDef),
    ).toThrow(/armor\.centerTorsoRear must be a non-negative integer/);
    expect(() =>
      validateMechDef({ ...base, armor: { ...base.armor, leftTorsoRear: 1.5 } } as MechDef),
    ).toThrow(/armor\.leftTorsoRear must be a non-negative integer/);
  });

  it("marks the Atlas rear-facing CT lasers (MTF (R)) and validates rearFacing", () => {
    const atlas = toMechDef(mechDef("AS7-D")!);
    const ctLasers = atlas.weapons.filter(
      (w) => w.weapon === "Medium Laser" && w.location === "centerTorso",
    );
    expect(ctLasers).toHaveLength(2);
    for (const m of ctLasers) expect(m.rearFacing).toBe(true);
    const base = toMechDef(mechDef("HBK-4G")!);
    expect(() =>
      validateMechDef({
        ...base,
        weapons: [
          ...base.weapons,
          { weapon: "Medium Laser", location: "leftArm", rearFacing: true },
        ],
      } as MechDef),
    ).toThrow(/only valid on torso mounts/);
    expect(() =>
      validateMechDef({
        ...base,
        weapons: base.weapons.map((m, i) => (i === 3 ? { ...m, rearFacing: true } : m)),
      } as MechDef),
    ).not.toThrow();
  });

  it("CASE can mount in any location (TW p.133)", () => {
    const base = toMechDef(mechDef("HBK-4G")!);
    const withCase = (
      loc: "leftTorso" | "rightTorso" | "centerTorso" | "head" | "rightArm",
      slotIndex: number,
    ) =>
      ({
        ...base,
        critSlots: {
          ...base.critSlots,
          [loc]: base.critSlots[loc].map((s, i) =>
            i === slotIndex ? { kind: "soak" as const, name: "case" as const } : s,
          ),
        },
      }) as MechDef;
    expect(() => validateMechDef(withCase("leftTorso", 2))).not.toThrow();
    expect(() => validateMechDef(withCase("rightTorso", 10))).not.toThrow();
    expect(() => validateMechDef(withCase("centerTorso", 11))).not.toThrow();
    expect(() => validateMechDef(withCase("head", 0))).not.toThrow();
    expect(() => validateMechDef(withCase("rightArm", 5))).not.toThrow();
  });

  it("rejects invalid definitions", () => {
    const base = toMechDef(mechDef("HBK-4G")!);
    expect(() => validateMechDef({ ...base, running: 7 } as MechDef)).toThrow(/running/);
    expect(() =>
      validateMechDef({ ...base, armor: { ...base.armor, head: -1 } } as MechDef),
    ).toThrow(/armor\.head/);
    expect(() =>
      validateMechDef({ ...base, armor: { ...base.armor, center: 10 } } as MechDef),
    ).toThrow(/not a valid location/);
  });
});

describe("weapon catalog", () => {
  it("resolves every weapon referenced by a bundled 'Mech", () => {
    for (const def of allMechDefs()) {
      for (const mount of Object.values(def.weapons)) {
        expect(weaponDefFor(mount).name, `${def.model}: ${mount.weapon}`).toBe(mount.weapon);
      }
    }
  });

  it("throws on genuinely unknown weapon names", () => {
    expect(() => weaponDefFor({ weapon: "Not A Weapon" })).toThrow();
  });

  it("encodes missile and rapid-fire behavior used by the attack pipeline", () => {
    expect(weaponDefFor({ weapon: "LRM 10" }).missiles).toBe(10);
    expect(weaponDefFor({ weapon: "LRM 10" }).missileDamage).toBe(1);
    expect(weaponDefFor({ weapon: "SRM 6" }).missiles).toBe(6);
    expect(weaponDefFor({ weapon: "SRM 6" }).missileDamage).toBe(2);
    expect(weaponDefFor({ weapon: "Ultra AC/5" }).rapidFireShots).toBe(2);
    expect(weaponDefFor({ weapon: "AC/20" }).rapidFireShots).toBeUndefined();
  });

  it("encodes Clan weapons added for the Mad Cat Mk II", () => {
    expect(weaponDefFor({ weapon: "CL ER Medium Laser" }).damage).toBe(7);
    expect(weaponDefFor({ weapon: "CL Gauss Rifle" }).damage).toBe(15);
    expect(weaponDefFor({ weapon: "CL LB 20-X AC" }).damage).toBe(20);
    expect(weaponDefFor({ weapon: "CL Streak SRM 4" }).missiles).toBe(4);
    expect(weaponDefFor({ weapon: "CL Streak SRM 4" }).missileDamage).toBe(2);
    expect(weaponDefFor({ weapon: "CL Streak SRM 4" }).streak).toBe(true);
  });

  it("encodes streak launchers on both tech bases", () => {
    for (const name of [
      "Streak SRM 2",
      "Streak SRM 4",
      "Streak SRM 6",
      "CL Streak SRM 2",
      "CL Streak SRM 6",
    ]) {
      const def = weaponDefFor({ weapon: name });
      expect(def.streak).toBe(true);
      expect(def.missileDamage).toBe(2);
    }
    expect(weaponDefFor({ weapon: "Streak SRM 2" }).missiles).toBe(2);
    expect(weaponDefFor({ weapon: "Streak SRM 6" }).missiles).toBe(6);
    expect(weaponDefFor({ weapon: "SRM 6" }).streak).toBeUndefined();
    expect(weaponDefFor({ weapon: "LRM 10" }).streak).toBeUndefined();
  });

  it("encodes the weapon To-Hit Mod column (TW p.303-304)", () => {
    for (const name of ["MRM 10", "MRM 20", "MRM 30", "MRM 40"]) {
      expect(weaponDefFor({ weapon: name }).toHitMod).toBe(1);
    }
    for (const name of ["CL Heavy Large Laser", "CL Heavy Medium Laser", "CL Heavy Small Laser"]) {
      expect(weaponDefFor({ weapon: name }).toHitMod).toBe(1);
    }
    for (const name of [
      "Large Pulse Laser",
      "Medium Pulse Laser",
      "Small Pulse Laser",
      "CL Large Pulse Laser",
      "CL Medium Pulse Laser",
      "CL Small Pulse Laser",
      "CL Micro Pulse Laser",
    ]) {
      const def = weaponDefFor({ weapon: name });
      expect(def.pulse).toBe(true);
      expect(def.toHitMod).toBe(-2);
    }
    expect(weaponDefFor({ weapon: "Medium Laser" }).toHitMod).toBeUndefined();
    expect(weaponDefFor({ weapon: "AC/20" }).toHitMod).toBeUndefined();
  });

  it("round-trips every catalog entry through parseWeaponsData", () => {
    const parsed = parseWeaponsData(WEAPON_DATA);
    expect(parsed).toHaveLength(WEAPON_DATA.length);
    for (const def of WEAPON_DATA) {
      const back = parsed.find((p) => p.name === def.name);
      expect(back, def.name).toBeDefined();
      expect(back).toMatchObject(JSON.parse(JSON.stringify(def)));
    }
  });

  it("round-trips clusterRangeMod and critExplosion instead of dropping them", () => {
    const hag = parseWeaponsData([
      {
        name: "HAG 20",
        short: 8,
        medium: 16,
        long: 24,
        minRange: 2,
        missileDamage: 1,
        missiles: 20,
        category: "BALLISTIC",
        heat: 4,
        critExplosion: 10,
        clusterRangeMod: { short: 2, medium: 0, long: -2 },
      },
    ]);
    expect(hag[0]!.critExplosion).toBe(10);
    expect(hag[0]!.clusterRangeMod).toEqual({ short: 2, medium: 0, long: -2 });
    expect(weaponDefFor({ weapon: "HAG 20" }).clusterRangeMod).toEqual({
      short: 2,
      medium: 0,
      long: -2,
    });
    expect(weaponDefFor({ weapon: "Gauss Rifle" }).critExplosion).toBe(20);
  });

  it("rejects out-of-range toHitMod values", () => {
    expect(() =>
      parseWeaponsData([
        { name: "X", short: 1, medium: 2, long: 3, category: "ENERGY", toHitMod: 6 },
      ]),
    ).toThrow(/toHitMod/);
  });
});

describe("ammo validation in MechDef", () => {
  it("rejects a mount.shots that is not a multiple of shotsPerBin", () => {
    const base = toMechDef(mechDef("HBK-4G")!);
    expect(() =>
      validateMechDef({
        ...base,
        weapons: base.weapons.map((w) => (w.weapon === "AC/20" ? { ...w, shots: 7 } : w)),
      } as MechDef),
    ).toThrow(/must be a multiple/);
  });

  it("rejects an ammo crit slot whose weapon has no ammo definition", () => {
    const base = toMechDef(mechDef("HBK-4G")!);
    expect(() =>
      validateMechDef({
        ...base,
        critSlots: {
          ...base.critSlots,
          head: base.critSlots.head.map((s, i) =>
            i === 0 ? { kind: "ammo" as const, weapon: "Medium Laser" } : s,
          ),
        },
      } as MechDef),
    ).toThrow(/has no ammo definition/);
  });
});
