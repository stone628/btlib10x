import { describe, expect, it } from "vitest";
import type { Location } from "../src/core/types";
import { mechDef } from "../src/data/index";
import type { ResolvedMechDef } from "../src/data/mech.schema";
import { armWeaponToHitModifier, countArmActuators } from "../src/rules/actuators";
import { resolveWeaponAttack } from "../src/rules/attack";
import { type CritMask, emptyCritTable, setSlotDestroyed } from "../src/rules/critical";
import type { UnitDamageState } from "../src/rules/damage";
import { suggestFireTargets } from "../src/rules/fireability";
import { buildUnitInit } from "../src/rules/game";
import { computeToHit, toHitTotal } from "../src/rules/tohit";
import { createTestBattle, scriptedRng } from "./helpers";

function freshFlags(def = mechDef("TBR-Prime")!) {
  return emptyCritTable(def);
}

function freshDamage(def = mechDef("TBR-Prime")!): UnitDamageState {
  return {
    armor: { ...def.armor },
    armorRear: { ...def.armorRear },
    internalStructure: { ...def.internalStructure },
  };
}

/** Mark every slot named `name` in `loc` destroyed. */
function destroyNamed(def: ResolvedMechDef, flags: CritMask, loc: Location, name: string): void {
  const layout = def.critSlots[loc];
  layout.forEach((slot, i) => {
    if (slot.kind === "structure" && slot.type === name) setSlotDestroyed(flags, loc, i);
  });
}

describe("arm actuator weapon modifiers (TW p.125)", () => {
  const def = mechDef("TBR-Prime")!;

  it("intact arms and non-arm mounts score 0", () => {
    const flags = freshFlags(def);
    const damage = freshDamage(def);
    expect(armWeaponToHitModifier(def, damage, flags, "leftArm")).toBe(0);
    expect(armWeaponToHitModifier(def, damage, flags, "rightArm")).toBe(0);
    expect(armWeaponToHitModifier(def, damage, flags, "centerTorso")).toBe(0);
    expect(armWeaponToHitModifier(def, damage, flags, "head")).toBe(0);
  });

  it("upper/lower actuators add +1 each, cumulatively", () => {
    const damage = freshDamage(def);
    const upper = freshFlags(def);
    destroyNamed(def, upper, "leftArm", "upperArmActuator");
    expect(countArmActuators(def, damage, upper, "leftArm")).toMatchObject({
      upper: 1,
      lower: 0,
    });
    expect(armWeaponToHitModifier(def, damage, upper, "leftArm")).toBe(1);

    const both = freshFlags(def);
    destroyNamed(def, both, "leftArm", "upperArmActuator");
    destroyNamed(def, both, "leftArm", "lowerArmActuator");
    expect(armWeaponToHitModifier(def, damage, both, "leftArm")).toBe(2);
  });

  it("shoulder destruction is +4 and suppresses upper/lower", () => {
    const damage = freshDamage(def);
    const flags = freshFlags(def);
    destroyNamed(def, flags, "rightArm", "shoulder");
    destroyNamed(def, flags, "rightArm", "upperArmActuator");
    destroyNamed(def, flags, "rightArm", "lowerArmActuator");
    expect(armWeaponToHitModifier(def, damage, flags, "rightArm")).toBe(4);
    // The other arm is unaffected.
    expect(armWeaponToHitModifier(def, damage, flags, "leftArm")).toBe(0);
  });

  it("hand actuator has no weapon-fire effect", () => {
    const handDef = mechDef("BSW-X1")!;
    const damage: UnitDamageState = {
      armor: { ...handDef.armor },
      armorRear: { ...handDef.armorRear },
      internalStructure: { ...handDef.internalStructure },
    };
    const flags = emptyCritTable(handDef);
    destroyNamed(handDef, flags, "rightArm", "handActuator");
    expect(countArmActuators(handDef, damage, flags, "rightArm").hand).toBe(1);
    expect(armWeaponToHitModifier(handDef, damage, flags, "rightArm")).toBe(0);
  });

  it("computeToHit folds actuatorMod into the total", () => {
    const wdef = def.weapons[1]!;
    const base = {
      gunnery: 4,
      attackerMovement: "standStill" as const,
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear" as const,
      interveningWoods: 0,
      distance: 3,
      weapon: { name: wdef.weapon, short: 3, medium: 6, long: 9 } as never,
    };
    expect(toHitTotal(computeToHit(base))).toBe(4);
    expect(toHitTotal(computeToHit({ ...base, actuatorMod: 4 }))).toBe(8);
    expect(computeToHit({ ...base, actuatorMod: 4 }).actuatorMod).toBe(4);
  });

  it("resolveWeaponAttack carries actuatorMod into the breakdown", () => {
    const targetDef = mechDef("HBK-4G")!;
    const res = resolveWeaponAttack({
      rng: scriptedRng(3, 4, 3, 4),
      gunnery: 4,
      attackerMoved: "standStill",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningTerrains: [],
      distance: 3,
      weapon: "Medium Laser",
      actuatorMod: 1,
      targetDamage: {
        armor: { ...targetDef.armor },
        armorRear: { ...targetDef.armorRear },
        internalStructure: { ...targetDef.internalStructure },
      },
    });
    expect(res.breakdown.actuatorMod).toBe(1);
  });

  it("suggestFireTargets raises arm-weapon TNs after a shoulder hit", () => {
    const state = createTestBattle(
      [],
      [
        buildUnitInit("a", "TBR-Prime", 1, { col: 1, row: 1 }, "s"),
        buildUnitInit("b", "HBK-4G", 2, { col: 1, row: 2 }, "n"),
      ],
      true,
    );
    const tnBefore = suggestFireTargets(state, "a").targets.find((t) => t.targetId === "b");
    const armTnBefore = tnBefore!.weaponsIfPropLeft.find((w) => w.location === "leftArm")!.tn;
    const attacker = state.units.a!;
    const atkDef = mechDef("TBR-Prime")!;
    atkDef.critSlots.leftArm.forEach((slot, i) => {
      if (slot.kind === "structure" && slot.type === "shoulder") {
        setSlotDestroyed(attacker.critSlotsDestroyed, "leftArm", i);
      }
    });
    const tnAfter = suggestFireTargets(state, "a").targets.find((t) => t.targetId === "b");
    const armTnAfter = tnAfter!.weaponsIfPropLeft.find((w) => w.location === "leftArm")!.tn;
    // Standing attacker: left-arm weapons appear in both prop lists.
    const armTnAfterRight = tnAfter!.weaponsIfPropRight.find((w) => w.location === "leftArm")!.tn;
    expect(armTnAfter - armTnBefore).toBe(4);
    expect(armTnAfterRight - armTnBefore).toBe(4);
  });
});
