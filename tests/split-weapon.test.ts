/**
 * Split-location weapons: a weapon whose crit slots span an arm and its
 * side torso (King Crab KGC-000: each arm AC/20 spills two slots into its
 * side torso). Covers slot linking, the torso firing arc (TW pp.105-106),
 * criticals in either location (TW pp.125-128), fireability when either
 * location is lost, and the arm semantics that stay with the arm.
 */

import { describe, expect, it } from "vitest";
import kgcJson from "../docs/mtf/sw/json/kgc-000.json";
import {
  type Arc,
  classifyFiringArc,
  createBattle,
  mechDefFor,
  suggestFireTargets,
  type Twist,
} from "../src";
import type { Facing, HexCoord } from "../src/core/types";
import { type CritSlot, type MechDef, mechDef, resolveMechDef } from "../src/data/index";
import { loadAmmoBins } from "../src/rules/ammo";
import {
  crittedWeapons,
  emptyCritTable,
  resolveCriticalHits,
  setSlotDestroyed,
} from "../src/rules/critical";
import type { UnitDamageState } from "../src/rules/damage";
import { type BattleState, buildUnitInit, validateAttacksImpl } from "../src/rules/game";
import { scriptedRng } from "./helpers";

const KGC = "KGC-000";
const RA_AC20 = 1;
const LA_AC20 = 2;
const RT_LARGE_LASER = 4;

/** Mutable copy of the raw KGC-000 sheet. */
function kgcRaw(): MechDef {
  return structuredClone(kgcJson) as unknown as MechDef;
}

function freshDamage(model = KGC): UnitDamageState {
  const def = mechDef(model)!;
  return {
    armor: { ...def.armor },
    armorRear: { ...def.armorRear },
    internalStructure: { ...def.internalStructure },
  };
}

/** KGC-000 at (5,5) facing north and a target at `targetHex`, in the attack phase. */
function battleWithTarget(targetHex: HexCoord, facing: Facing = "n"): BattleState {
  const battle = createBattle(
    { name: "split", width: 20, height: 20, terrain: [], legends: [] },
    [
      buildUnitInit("a", KGC, 1, { col: 5, row: 5 }, facing),
      buildUnitInit("t", "HBK-4G", 2, targetHex, "s"),
    ],
    { critsDisabled: true },
  );
  battle.phase = "attack";
  battle.initiativeWinnerTeam = 2;
  battle.actorQueue = ["a", "t"];
  battle.actedThisPhase = [];
  return battle;
}

/**
 * A hex within AC/20 range that lies in `arc` of a north-facing unit at
 * (5,5), and in `twistedArc` once the torso twists right (facing ne).
 */
function hexInArc(arc: Arc, twistedArc?: Arc): HexCoord {
  const from = { col: 5, row: 5 };
  for (let col = 2; col <= 8; col++) {
    for (let row = 2; row <= 8; row++) {
      const hex = { col, row };
      if (col === 5 && row === 5) continue;
      if (Math.abs(col - 5) + Math.abs(row - 5) > 3) continue;
      if (classifyFiringArc(from, hex, "n") !== arc) continue;
      if (twistedArc !== undefined && classifyFiringArc(from, hex, "ne") !== twistedArc) continue;
      return hex;
    }
  }
  throw new Error(`no hex in ${arc}`);
}

describe("split weapon linking", () => {
  it("links the side-torso AC/20 slots to the arm mount", () => {
    const def = mechDefFor({ model: KGC });
    expect(def.weapons[RA_AC20]).toMatchObject({
      location: "rightArm",
      splitLocation: "rightTorso",
    });
    expect(def.weapons[LA_AC20]).toMatchObject({ location: "leftArm", splitLocation: "leftTorso" });
    expect(def.weapons[RT_LARGE_LASER]?.splitLocation).toBeUndefined();
    const linked = (loc: "rightTorso" | "rightArm") =>
      def.critSlots[loc].filter((s) => s.kind === "weapon" && s.weaponIndex === RA_AC20).length;
    expect(linked("rightArm")).toBe(8);
    expect(linked("rightTorso")).toBe(2);
  });

  it("rejects weapon slots with no mount in their own or paired location", () => {
    const raw = kgcRaw();
    (raw.critSlots.head as CritSlot[])[3] = { kind: "weapon", weapon: "AC/20" };
    expect(() => resolveMechDef(raw)).toThrow(/no such weapon mount exists in that location/);
  });

  it("models arm/side-torso splits only: leg and center torso spill-over is rejected", () => {
    // The right torso holds the RA AC/20's spill-over, but neither the right
    // leg nor the center torso pairs with an arm.
    const leg = kgcRaw();
    (leg.critSlots.rightLeg as CritSlot[])[5] = { kind: "weapon", weapon: "AC/20" };
    expect(() => resolveMechDef(leg)).toThrow(/no such weapon mount exists in that location/);
    const ct = kgcRaw();
    (ct.critSlots.centerTorso as CritSlot[])[11] = { kind: "weapon", weapon: "AC/20" };
    expect(() => resolveMechDef(ct)).toThrow(/no such weapon mount exists in that location/);
  });

  it("rejects a split whose slots do not add up to the weapon's crits", () => {
    const raw = kgcRaw();
    // A third AC/20 slot in the right torso: 8 + 3 = 11, not 10.
    (raw.critSlots.rightTorso as CritSlot[])[6] = { kind: "weapon", weapon: "AC/20" };
    expect(() => resolveMechDef(raw)).toThrow(/do not complete its 10 slots/);
  });
});

describe("split weapon criticals (TW pp.125-128)", () => {
  it("a critical on a side-torso AC/20 slot destroys the arm AC/20", () => {
    const def = mechDefFor({ model: KGC });
    // Determining roll 8 (one critical), slot roll 1,1 → right torso slot 1.
    const res = resolveCriticalHits({
      rng: scriptedRng(4, 4, 1, 1),
      model: def.model,
      source: { location: "rightTorso", damage: 5 },
      critSlotsDestroyed: emptyCritTable(def),
      damage: freshDamage(),
      ammoBins: loadAmmoBins(def),
    });
    expect(crittedWeapons(def, res.critSlotsDestroyed)).toEqual([RA_AC20]);
  });
});

describe("split weapon firing", () => {
  it("fires forward only: the arm's side arc is closed to it (TW pp.105-106)", () => {
    const side = hexInArc("rightSide");
    const battle = battleWithTarget(side);
    expect(() =>
      validateAttacksImpl(battle, "a", [{ weaponIndex: RA_AC20, targetId: "t" }]),
    ).toThrow(/outside its firing arc/);
    const front = battleWithTarget(hexInArc("front"));
    expect(() =>
      validateAttacksImpl(front, "a", [{ weaponIndex: RA_AC20, targetId: "t" }]),
    ).not.toThrow();
  });

  it("follows a torso twist toward the target", () => {
    const battle = battleWithTarget(hexInArc("rightSide", "front"));
    const fires = (twist: Twist | null) =>
      suggestFireTargets(battle, "a", twist ?? "front")
        .targets.find((t) => t.targetId === "t")
        ?.weapons.some((w) => w.weaponIndex === RA_AC20);
    expect(fires(null)).toBe(false);
    expect(fires("rightSide")).toBe(true);
  });

  it("cannot fire once the side torso holding its slots is destroyed", () => {
    const battle = battleWithTarget(hexInArc("front"));
    battle.units.a!.damage.internalStructure.rightTorso = 0;
    expect(() =>
      validateAttacksImpl(battle, "a", [{ weaponIndex: RA_AC20, targetId: "t" }]),
    ).toThrow(/destroyed or its support torso is gone/);
  });

  it("ignores arm actuator damage for to-hit", () => {
    const battle = battleWithTarget(hexInArc("front"));
    const tn = (b: BattleState, idx: number) =>
      suggestFireTargets(b, "a")
        .targets.find((t) => t.targetId === "t")!
        .weapons.find((w) => w.weaponIndex === idx)?.tn;
    const before = tn(battle, RA_AC20);
    // Destroy the right arm's upper and lower arm actuators (slots 2 and 3).
    setSlotDestroyed(battle.units.a!.critSlotsDestroyed, "rightArm", 1);
    setSlotDestroyed(battle.units.a!.critSlotsDestroyed, "rightArm", 2);
    expect(before).toBeDefined();
    expect(tn(battle, RA_AC20)).toBe(before);
  });

  it("still counts as an arm weapon for punching with that arm", () => {
    const battle = battleWithTarget(hexInArc("front"));
    battle.units.t!.position = { col: 5, row: 4 };
    expect(() =>
      validateAttacksImpl(
        battle,
        "a",
        [{ weaponIndex: RA_AC20, targetId: "t" }],
        [{ type: "punch", targetId: "t", limb: "rightArm" }],
      ),
    ).toThrow(/cannot fire/);
  });
});
