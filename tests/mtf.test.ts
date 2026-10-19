import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMtf } from "../scripts/mtf.mjs";
import {
  ammoBinsFromCrits,
  parseCritSlots,
  validateCritConstruction,
} from "../scripts/mtf-crit.mjs";
import { type MechDef, resolveMechDef, validateMechDef } from "../src/data/index";

type Slot =
  | { kind: "empty" }
  | { kind: "weapon"; weapon: string }
  | { kind: "ammo"; weapon: string }
  | { kind: "structure"; type: string; name?: string }
  | { kind: "soak"; name: string };
type Slots = Record<string, Slot[]>;

/** An empty 8-location crit-slot map. */
function emptySlots(): Slots {
  return {
    centerTorso: [],
    leftTorso: [],
    rightTorso: [],
    leftArm: [],
    rightArm: [],
    leftLeg: [],
    rightLeg: [],
    head: [],
  };
}

function push(s: Slots, loc: string, e: Slot): void {
  s[loc]!.push(e);
}

function engine(s: Slots, loc: string, n: number): void {
  for (let i = 0; i < n; i++) push(s, loc, { kind: "structure", type: "engine" });
}

function soak(s: Slots, loc: string, name: string, n: number): void {
  for (let i = 0; i < n; i++) push(s, loc, { kind: "soak", name });
}

/** Full IS XL (6 CT / 3 LT / 3 RT) with the standard 14 Endo Steel spread. */
function isXlEndoSteelSlots(): Slots {
  const s = emptySlots();
  engine(s, "centerTorso", 6);
  engine(s, "leftTorso", 3);
  engine(s, "rightTorso", 3);
  soak(s, "centerTorso", "endoSteel", 4);
  soak(s, "leftTorso", "endoSteel", 2);
  soak(s, "rightTorso", "endoSteel", 2);
  soak(s, "leftArm", "endoSteel", 2);
  soak(s, "rightArm", "endoSteel", 2);
  soak(s, "leftLeg", "endoSteel", 1);
  soak(s, "rightLeg", "endoSteel", 1);
  return s;
}

const ISXLMETA = {
  techBase: "Inner Sphere",
  engineField: "360 XL Fusion Engine",
  structureField: "Endo Steel",
  armorField: "Standard",
};

describe("MTF crit construction validation", () => {
  it("accepts a valid IS XL with 14 Endo Steel", () => {
    const errors: string[] = [];
    validateCritConstruction(isXlEndoSteelSlots(), ISXLMETA, errors);
    expect(errors).toEqual([]);
  });

  it("accepts a valid Clan XL with 7 Endo Steel + 7 Ferro-Fibrous", () => {
    const s = emptySlots();
    engine(s, "centerTorso", 6);
    engine(s, "leftTorso", 2);
    engine(s, "rightTorso", 2);
    soak(s, "centerTorso", "endoSteel", 1);
    soak(s, "leftTorso", "endoSteel", 1);
    soak(s, "rightTorso", "endoSteel", 1);
    soak(s, "leftLeg", "endoSteel", 2);
    soak(s, "rightLeg", "endoSteel", 2);
    soak(s, "leftTorso", "ferroFibrous", 2);
    soak(s, "rightTorso", "ferroFibrous", 2);
    soak(s, "leftArm", "ferroFibrous", 1);
    soak(s, "rightArm", "ferroFibrous", 1);
    soak(s, "head", "ferroFibrous", 1);
    const errors: string[] = [];
    validateCritConstruction(
      s,
      {
        techBase: "Clan",
        engineField: "360 XL Fusion Engine",
        structureField: "Endo-Steel",
        armorField: "Ferro-Fibrous",
      },
      errors,
    );
    expect(errors).toEqual([]);
  });

  it("rejects a wrong Endo Steel slot total", () => {
    const s = isXlEndoSteelSlots();
    // Drop one arm soak so the total is 13 instead of the required 14.
    s.rightArm!.length = 0;
    s.rightArm!.push({ kind: "soak", name: "endoSteel" });
    const errors: string[] = [];
    validateCritConstruction(s, ISXLMETA, errors);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Endo Steel");
  });

  it("rejects a wrong Ferro-Fibrous slot total", () => {
    const s = emptySlots();
    engine(s, "centerTorso", 6);
    engine(s, "leftTorso", 3);
    engine(s, "rightTorso", 3);
    soak(s, "centerTorso", "ferroFibrous", 5);
    const errors: string[] = [];
    validateCritConstruction(
      s,
      { ...ISXLMETA, structureField: "Standard", armorField: "Ferro-Fibrous" },
      errors,
    );
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Ferro-Fibrous");
  });

  it("rejects an IS XL laid out with the Clan side-torso distribution", () => {
    const s = emptySlots();
    engine(s, "centerTorso", 6);
    engine(s, "leftTorso", 2);
    engine(s, "rightTorso", 2);
    const errors: string[] = [];
    validateCritConstruction(
      s,
      { ...ISXLMETA, structureField: "Standard", armorField: "Standard" },
      errors,
    );
    expect(errors.length).toBe(3);
    expect(errors.join(" ")).toContain("leftTorso: 2 counted, 3 expected");
  });

  it("rejects a standard engine that has an engine bay in a side torso", () => {
    const s = emptySlots();
    engine(s, "centerTorso", 6);
    engine(s, "leftTorso", 1);
    const errors: string[] = [];
    validateCritConstruction(
      s,
      {
        techBase: "Inner Sphere",
        engineField: "360 Fusion Engine",
        structureField: "Standard",
        armorField: "Standard",
      },
      errors,
    );
    expect(errors.length).toBe(2);
    expect(errors.join(" ")).toContain("leftTorso: 1 counted, 0 expected");
  });

  it("rejects Endo Steel slots when the header declares Standard structure", () => {
    const s = emptySlots();
    engine(s, "centerTorso", 6);
    soak(s, "leftArm", "endoSteel", 2);
    const errors: string[] = [];
    validateCritConstruction(
      s,
      {
        techBase: "Inner Sphere",
        engineField: "360 Fusion Engine",
        structureField: "Standard",
        armorField: "Standard",
      },
      errors,
    );
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Endo Steel");
  });

  it("defers compact engines with a hard error", () => {
    const s = emptySlots();
    engine(s, "centerTorso", 2);
    const errors: string[] = [];
    validateCritConstruction(
      s,
      {
        techBase: "Inner Sphere",
        engineField: "Compact Fusion Engine",
        structureField: "Standard",
        armorField: "Standard",
      },
      errors,
    );
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("compact engines");
  });

  it("maps Hatchet to a weapon slot and TSM to a tsm soak slot", () => {
    const errors: string[] = [];
    const slots = parseCritSlots(
      ["Left Arm:", "Hatchet", "Triple Strength Myomer", ""],
      errors,
      "test.mtf",
    );
    expect(errors).toEqual([]);
    expect(slots.leftArm!.slice(0, 2)).toEqual([
      { kind: "weapon", weapon: "Hatchet" },
      { kind: "soak", name: "tsm" },
    ]);
    expect(slots.leftArm!.length).toBe(12);
  });

  it("accepts 6 tsm slots when myomer is Triple Strength Myomer", () => {
    const s = emptySlots();
    engine(s, "centerTorso", 6);
    soak(s, "leftArm", "tsm", 1);
    soak(s, "rightArm", "tsm", 1);
    soak(s, "leftTorso", "tsm", 1);
    soak(s, "rightTorso", "tsm", 1);
    soak(s, "leftLeg", "tsm", 1);
    soak(s, "rightLeg", "tsm", 1);
    const errors: string[] = [];
    validateCritConstruction(
      s,
      {
        techBase: "Inner Sphere",
        engineField: "200 Fusion Engine",
        structureField: "Standard",
        armorField: "Standard",
        myomer: "Triple Strength Myomer",
      },
      errors,
    );
    expect(errors).toEqual([]);
  });

  it("rejects tsm slots when myomer is Standard", () => {
    const s = emptySlots();
    engine(s, "centerTorso", 6);
    soak(s, "leftArm", "tsm", 1);
    const errors: string[] = [];
    validateCritConstruction(
      s,
      {
        techBase: "Inner Sphere",
        engineField: "200 Fusion Engine",
        structureField: "Standard",
        armorField: "Standard",
      },
      errors,
    );
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Triple Strength Myomer");
  });

  it("rejects a TSM mech missing its 6 slots", () => {
    const s = emptySlots();
    engine(s, "centerTorso", 6);
    const errors: string[] = [];
    validateCritConstruction(
      s,
      {
        techBase: "Inner Sphere",
        engineField: "200 Fusion Engine",
        structureField: "Standard",
        armorField: "Standard",
        myomer: "Triple Strength Myomer",
      },
      errors,
    );
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Triple Strength Myomer");
  });
});

describe("ammoBinsFromCrits", () => {
  it("counts a half-ton Machine Gun crit as 0.5 tons", () => {
    const bins = ammoBinsFromCrits(["IS Machine Gun Ammo - Half"]);
    expect(bins.get("Machine Gun")).toBe(0.5);
  });

  it("counts a full-ton Machine Gun crit as 1 ton", () => {
    const bins = ammoBinsFromCrits(["IS Machine Gun Ammo"]);
    expect(bins.get("Machine Gun")).toBe(1);
  });

  it("resolves IS Ammo <token> form to the catalog weapon", () => {
    const bins = ammoBinsFromCrits(["IS Ammo AC/10", "IS Ammo LRM-5"]);
    expect(bins.get("AC/10")).toBe(1);
    expect(bins.get("LRM 5")).toBe(1);
  });

  it('resolves Clan compact "<code> Ammo" form', () => {
    const bins = ammoBinsFromCrits(["CLMG Ammo"]);
    expect(bins.get("CL Machine Gun")).toBe(1);
  });

  it('resolves the compact "<IS|CL><stem>Ammo" form', () => {
    const bins = ammoBinsFromCrits(["ISPlasmaRifleAmmo"]);
    expect(bins.get("Plasma Rifle")).toBe(1);
  });

  it("sums multiple half-ton bins for the same weapon", () => {
    const bins = ammoBinsFromCrits(["IS Machine Gun Ammo - Half", "IS Machine Gun Ammo - Half"]);
    expect(bins.get("Machine Gun")).toBe(1);
  });

  it("mixes half-ton and full-ton bins additively", () => {
    const bins = ammoBinsFromCrits(["IS Machine Gun Ammo - Half", "IS Machine Gun Ammo"]);
    expect(bins.get("Machine Gun")).toBe(1.5);
  });

  it("ignores unmapped ammo-shaped lines silently", () => {
    const bins = ammoBinsFromCrits(["FooBar Ammo", "IS Ammo Mysterio"]);
    expect(bins.size).toBe(0);
  });

  it("multiplies half-ton MG by SHOTS_PER_TON to yield 100 shots", () => {
    // Regression for Bushwacker BSW-X1: "IS Machine Gun Ammo - Half" must
    // resolve to 100 shots, not 200.
    const SHOTS_PER_TON: Record<string, number> = { "Machine Gun": 200 };
    const bins = ammoBinsFromCrits(["IS Machine Gun Ammo - Half"]);
    const weapon = "Machine Gun";
    const shots = (bins.get(weapon) ?? 0) * (SHOTS_PER_TON[weapon] ?? 0);
    expect(shots).toBe(100);
  });
});

describe("parseCritSlots: catalog token aliases", () => {
  const classify = (token: string, techBase = "Clan") => {
    const errors: string[] = [];
    const lines = ["Left Arm:", token, ...Array(11).fill("-Empty-")];
    const slots = parseCritSlots(lines, errors, "t.mtf", techBase);
    return { slot: slots.leftArm?.[0], errors };
  };

  it.each([
    ["CLHAG20", "HAG 20"],
    ["CLAPGaussRifle", "AP Gauss Rifle"],
    ["CLHeavyMG", "CL Heavy Machine Gun"],
    ["CLERSmallLaser (OMNIPOD)", "CL ER Small Laser"],
    ["CLLaserAntiMissileSystem", "CL Laser Anti-Missile System"],
    ["ISLAC5", "Light AC/5"],
    ["ISBPod", "B-Pods"],
    ["ISLBXAC10", "LB 10-X AC"],
    ["ISLBXAC20", "LB 20-X AC"],
    ["ISLBXAC20 (Split)", "LB 20-X AC"],
    ["CLLBXAC20", "CL LB 20-X AC"],
  ])("maps %s to the catalog weapon %s", (token, weapon) => {
    const { slot, errors } = classify(token, token.startsWith("IS") ? "Inner Sphere" : "Clan");
    expect(errors).toEqual([]);
    expect(slot).toEqual({ kind: "weapon", weapon });
  });

  it("maps Improved Jump Jet spellings to the jump-jet structure slot", () => {
    expect(classify("Improved Jump Jet").slot).toEqual({ kind: "structure", type: "jumpJet" });
  });
});

describe("parseMtf: repeated weapons in one location", () => {
  const convert = (sheet: string) => {
    const file = `docs/mtf/sw/mtf/${sheet}.mtf`;
    const { def, errors } = parseMtf(readFileSync(file, "utf8"), file);
    expect(errors).toEqual([]);
    return def!;
  };
  const mounts = (def: ReturnType<typeof convert>, location: string, weapon: string) =>
    def.weapons.filter((w) => w.location === location && w.weapon === weapon);

  it('expands a quantity line ("2 ISMediumLaser, Left Torso") into separate mounts', () => {
    // CHP-1N: 2 ML in LT and 2 SL in CT, each one crit slot.
    const def = convert("Champion CHP-1N");
    expect(mounts(def, "leftTorso", "Medium Laser")).toHaveLength(2);
    expect(mounts(def, "centerTorso", "Small Laser")).toHaveLength(2);
    expect(def.weapons).toHaveLength(6);
    const resolved = resolveMechDef(validateMechDef(def as unknown as MechDef));
    const ctLinks = resolved.critSlots.centerTorso
      .filter((s) => s.kind === "weapon")
      .map((s) => (s as { weaponIndex: number }).weaponIndex);
    expect(new Set(ctLinks).size).toBe(2);
  });

  it("gives an expanded line's ammo to one mount only", () => {
    // RMP-5G: "3 ISStreakSRM2, Left Torso, Ammo:50".
    const def = convert("Rampage RMP-5G");
    expect(mounts(def, "leftTorso", "Streak SRM 2").map((m) => m.shots)).toEqual([
      50,
      undefined,
      undefined,
    ]);
  });

  it("marks only the rear-facing copy when front and rear copies share a location", () => {
    // BLR-1G: 3 ML per side torso, crit slots "Medium Laser" x2 + "Medium Laser (R)".
    const def = convert("BattleMaster BLR-1G");
    for (const loc of ["leftTorso", "rightTorso"]) {
      expect(mounts(def, loc, "Medium Laser").map((m) => m.rearFacing === true)).toEqual([
        false,
        false,
        true,
      ]);
    }
    // FS9-A: CT "Flamer" + "Flamer (R)".
    const fs9 = convert("Firestarter FS9-A");
    expect(mounts(fs9, "centerTorso", "Flamer").map((m) => m.rearFacing === true)).toEqual([
      false,
      true,
    ]);
  });

  it("links each multi-slot copy to a contiguous run of crit slots", () => {
    // HBK-4J: 2 LRM 10 in RT (2 slots each). A hit on slots 1 and 2 must
    // land on the same launcher, not destroy both.
    const def = convert("Hunchback HBK-4J");
    expect(mounts(def, "rightTorso", "LRM 10")).toHaveLength(2);
    const resolved = resolveMechDef(validateMechDef(def as unknown as MechDef));
    const links = resolved.critSlots.rightTorso
      .filter((s) => s.kind === "weapon" && s.weapon === "LRM 10")
      .map((s) => (s as { weaponIndex: number }).weaponIndex);
    expect(links).toHaveLength(4);
    expect(links[0]).toBe(links[1]);
    expect(links[2]).toBe(links[3]);
    expect(links[0]).not.toBe(links[2]);
  });
});

describe("parseMtf: model callsign suffix", () => {
  const convert = (file: string) => {
    const { def, errors } = parseMtf(readFileSync(file, "utf8"), file);
    expect(errors).toEqual([]);
    return def!;
  };

  it("splits a pilot suffix into a whitespace-free model plus callsign", () => {
    const def = convert("docs/mtf/sw/mtf/Atlas AS7-WGS Samsonov.mtf");
    expect(def.model).toBe("AS7-WGS");
    expect(def.callsign).toBe("Samsonov");
    expect(def.model).not.toMatch(/\s/);
  });

  it("folds the spaced Von Rohrs code to dashes with no callsign", () => {
    const def = convert("docs/mtf/sw/mtf/Von Rohrs (Hebis) VON 4RH-5.mtf");
    expect(def.model).toBe("VON-4RH-5");
    expect(def.callsign).toBeUndefined();
  });

  it("rejects whitespace in model via validateMechDef", () => {
    const def = convert("docs/mtf/sw/mtf/Atlas AS7-WGS Samsonov.mtf");
    expect(() =>
      validateMechDef({ ...(def as unknown as MechDef), model: "AS7-WGS (Samsonov)" }),
    ).toThrow(/must not contain whitespace/);
    expect(() => validateMechDef(def as unknown as MechDef)).not.toThrow();
  });

  it("extracts the Intro year as a required integer", () => {
    const def = convert("docs/mtf/sw/mtf/Atlas AS7-WGS Samsonov.mtf");
    expect(def.intro).toBe(3025);
    expect(def).not.toHaveProperty("era");
    const file = "docs/mtf/sw/mtf/Atlas AS7-WGS Samsonov.mtf";
    const noIntro = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !/^Intro:/im.test(l))
      .join("\n");
    const res = parseMtf(noIntro, file);
    expect(res.errors.some((e) => /Intro/.test(e))).toBe(true);
  });
});
