import { describe, expect, it } from "vitest";
import {
  ammoBinsFromCrits,
  parseCritSlots,
  validateCritConstruction,
} from "../scripts/mtf-crit.mjs";

type Slot =
  | { kind: "empty" }
  | { kind: "weapon"; weapon: string }
  | { kind: "ammo"; weapon: string }
  | { kind: "structure"; name: string }
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
  for (let i = 0; i < n; i++) push(s, loc, { kind: "structure", name: "engine" });
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
