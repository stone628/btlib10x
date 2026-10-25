import { describe, expect, it } from "vitest";
import kgcJson from "../docs/mtf/sw/json/kgc-000.json";
import { type Facing, type HexCoord, LOCATIONS } from "../src/core/types";
import { type CritSlot, type MechDef, mechDef, resolveMechDef } from "../src/data/index";
import { mechDefFor } from "../src/data/mech.schema";
import { weaponDef } from "../src/data/weapon.schema";
import { loadAmmoBins, pooledShotsLeft } from "../src/rules/ammo";
import {
  type AmsAttack,
  amsExpectedSaving,
  amsPriority,
  chooseAms,
  isAmsEngageable,
} from "../src/rules/ams";
import { type Arc, classifyFiringArc, type Twist } from "../src/rules/arcs";
import {
  type AttackResolution,
  resolveWeaponAttack,
  type WeaponAttackInput,
} from "../src/rules/attack";
import {
  clusterHits,
  expectedClusterHits,
  groupMissiles,
  modifiedClusterRoll,
} from "../src/rules/cluster";
import {
  critSeveredLimbs,
  crittedWeapons,
  emptyCritTable,
  resolveCriticalHits,
  setSlotDestroyed,
} from "../src/rules/critical";
import type { LocationValue, TorsoLocationValue, UnitDamageState } from "../src/rules/damage";
import { suggestFireTargets } from "../src/rules/fireability";
import { buildUnitInit, createBattle } from "../src/rules/game/create";
import { declareAttacks, validateAttacksImpl } from "../src/rules/game/declare";
import { advancePhase } from "../src/rules/game/loop";
import { requireUnit } from "../src/rules/game/queries";
import { resolveAllAttacks } from "../src/rules/game/resolveAttacks";
import { rollInitiativePhase } from "../src/rules/game/turnOrder";
import type { BattleState, GameEvent, UnitInit } from "../src/rules/game/types";
import {
  HIT_LOCATION_TABLE,
  hitLocation,
  hitLocationForArc,
  LEFT_SIDE_TABLE,
  RIGHT_SIDE_TABLE,
} from "../src/rules/hitlocation";
import { createTestBattle } from "./helpers/battle";
import { scriptedRng } from "./helpers/rng";

function freshState(hp = 10): UnitDamageState {
  const armor = {} as LocationValue;
  const is = {} as LocationValue;
  for (const loc of LOCATIONS) {
    armor[loc] = hp;
    is[loc] = hp;
  }
  return { armor, armorRear: {} as TorsoLocationValue, internalStructure: is };
}

function freshFlags(def = mechDef("HBK-4G")!) {
  return emptyCritTable(def);
}

/** Stationary gunnery-4 shooter at range 1 vs stationary target in the clear: TN 4. */
const BASE = {
  gunnery: 4,
  attackerMoved: "standStill",
  targetHexesMoved: 0,
  targetJumped: false,
  targetTerrain: "clear",
  interveningTerrains: [],
  distance: 1,
} as const;

describe("resolveWeaponAttack", () => {
  it("resolves a direct-fire hit end-to-end", () => {
    const rng = scriptedRng(2, 3, 3, 4); // to-hit 5 >= 4; location 7 -> CT
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "Small Laser",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(true);
    expect(res.jammed).toBe(false);
    expect(res.toHitRoll).toBe(5);
    expect(res.clusterRoll).toBeNull();
    expect(res.groups).toEqual([{ location: "centerTorso", damage: 3, throughArmor: false }]);
    expect(res.targetDamageAfter.armor.centerTorso).toBe(7);
    expect(rng.remaining()).toBe(0);
  });

  it("records misses without consuming further rolls", () => {
    const rng = scriptedRng(1, 2); // total 3 < TN 4
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "Small Laser",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(false);
    expect(res.groups).toHaveLength(0);
    expect(res.applications).toEqual([]);
    expect(rng.remaining()).toBe(0);
  });

  it("jams multi-shot rapid fire on a natural 2 and stops there", () => {
    const rng = scriptedRng(1, 1);
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "Ultra AC/5",
      shots: 2,
      targetDamage: freshState(),
    });
    expect(res.jammed).toBe(true);
    expect(res.hit).toBe(false);
    expect(res.groups).toHaveLength(0);
    expect(rng.remaining()).toBe(0);
  });

  it("raw roll above 2 with auto-hit TN hits without jamming", () => {
    // Same TN-<= 2 setup as above, but raw roll 6 != 2: jam trigger stays
    // false while the modified-TN override still auto-hits.
    const rng = scriptedRng(
      3,
      3, // to-hit roll 6 (no jam: != 2)
      1,
      2, // cluster roll 3, 2-shot column -> 1 hit
      3,
      4, // location 7 -> center torso
    );
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      gunnery: 0,
      targetImmobile: true,
      weapon: "Ultra AC/5",
      shots: 2,
      targetDamage: freshState(),
    });
    expect(res.breakdown.automatic).toBe("hit");
    expect(res.toHitRoll).toBe(6);
    expect(res.jammed).toBe(false);
    expect(res.hit).toBe(true);
    expect(res.groups).toEqual([{ location: "centerTorso", damage: 5, throughArmor: false }]);
  });

  it("single-tap Ultra AC does not jam on raw 2 (jam requires shots > 1)", () => {
    // TW p.113: jam threshold applies to 2-3 shot volleys; a single-tap
    // Ultra AC resolves as a normal single-shot attack. Distance 2 clears
    // the UAC/5 min-range of 2 so BASE.gunnery 4 reaches unmodified TN 4.
    const rng = scriptedRng(2, 3, 3, 4); // to-hit 5 -> hit; location 7 -> CT
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      distance: 2,
      weapon: "Ultra AC/5",
      shots: 1,
      targetDamage: freshState(),
    });
    expect(res.toHitRoll).toBe(5);
    expect(res.jammed).toBe(false);
    expect(res.hit).toBe(true);
    expect(res.clusterRoll).toBeNull();
    expect(rng.remaining()).toBe(0);
  });

  it("uses the rapid-fire cluster table for Ultra AC/5 double taps", () => {
    const rng = scriptedRng(
      3,
      4, // to-hit 7 >= 4
      4,
      5, // cluster roll 9, 2-shot column -> 2 hits
      2,
      3, // location 5 -> rightLeg
      3,
      4, // location 7 -> center torso
    );
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "Ultra AC/5",
      shots: 2,
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(true);
    expect(res.clusterRoll).toBe(9);
    expect(res.groups).toEqual([
      { location: "rightLeg", damage: 5, throughArmor: false },
      { location: "centerTorso", damage: 5, throughArmor: false },
    ]);
    expect(res.targetDamageAfter.armor.rightLeg).toBe(5);
  });

  it("rolls LRM missiles in lots of five", () => {
    const rng = scriptedRng(
      5,
      6, // to-hit 11
      4,
      5, // cluster roll 9: 10-missile column -> 8 missiles
      1,
      1, // lot of 5 -> head (2)
      2,
      2, // lot of 3 -> left torso (4)
    );
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "LRM 10",
      targetDamage: freshState(),
    });
    expect(res.clusterRoll).toBe(9);
    expect(res.groups).toEqual([
      { location: "centerTorso", damage: 5, throughArmor: true },
      { location: "rightArm", damage: 3, throughArmor: false },
    ]);
    expect(res.targetDamageAfter.armor.centerTorso).toBe(5);
    expect(res.targetDamageAfter.armor.rightArm).toBe(7);
  });

  it("locates every SRM missile individually", () => {
    const rng = scriptedRng(
      5,
      5, // to-hit 10
      5,
      5, // cluster roll 10: SRM-6 column -> 5 missiles
      ...[2, 2, 3, 3, 4, 4, 5, 5, 6, 6], // ten d6 -> five locations
    );
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "SRM 6",
      targetDamage: freshState(),
    });
    expect(res.groups).toHaveLength(5);
    for (const group of res.groups) expect(group.damage).toBe(2);
  });

  it("lands full tube count on streak hits with no cluster roll", () => {
    const rng = scriptedRng(
      3,
      3, // to-hit 6 >= 4
      3,
      4, // missile 1 -> center torso (7)
      3,
      4, // missile 2 -> center torso (7)
      3,
      4, // missile 3 -> center torso (7)
      3,
      4, // missile 4 -> center torso (7)
    );
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "CL Streak SRM 4",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(true);
    expect(res.clusterRoll).toBeNull();
    expect(res.groups).toEqual([
      { location: "centerTorso", damage: 2, throughArmor: false },
      { location: "centerTorso", damage: 2, throughArmor: false },
      { location: "centerTorso", damage: 2, throughArmor: false },
      { location: "centerTorso", damage: 2, throughArmor: false },
    ]);
    expect(res.targetDamageAfter.armor.centerTorso).toBe(2);
    expect(rng.remaining()).toBe(0);
  });

  it("records streak misses without consuming further rolls", () => {
    const rng = scriptedRng(1, 2); // total 3 < TN 4
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "CL Streak SRM 4",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(false);
    expect(res.clusterRoll).toBeNull();
    expect(res.groups).toHaveLength(0);
    expect(res.applications).toEqual([]);
    expect(rng.remaining()).toBe(0);
  });

  it("auto-fails out-of-range shots without rolling", () => {
    const rng = scriptedRng();
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      distance: 999,
      weapon: "Medium Laser",
      targetDamage: freshState(),
    });
    expect(res.breakdown.outOfRange).toBe(true);
    expect(res.toHitRoll).toBeNull();
    expect(rng.remaining()).toBe(0);
  });

  it("partial cover: +1 TN and leg location hits strike the cover", () => {
    const rng = scriptedRng(3, 3, 2, 3); // to-hit 6 >= TN 5; location 5 -> rightLeg -> cover
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      targetTerrain: "water1",
      weapon: "Small Laser",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(true);
    expect(res.breakdown.terrainMod).toBe(0);
    expect(res.breakdown.coverMod).toBe(1);
    expect(res.groups).toHaveLength(0);
    expect(res.applications).toEqual([]);
    expect(rng.remaining()).toBe(0);
  });

  it("partial cover does not block non-leg locations", () => {
    const rng = scriptedRng(3, 3, 3, 4); // to-hit 6 >= TN 5; location 7 -> CT
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      targetTerrain: "mediumBuilding",
      weapon: "Small Laser",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(true);
    expect(res.breakdown.terrainMod).toBe(0);
    expect(res.breakdown.coverMod).toBe(1);
    expect(res.groups).toEqual([{ location: "centerTorso", damage: 3, throughArmor: false }]);
  });

  it("water1 grants partial cover even when attacker higher", () => {
    const rng = scriptedRng(3, 3, 2, 3); // to-hit 6 >= TN 5; location 5 -> rightLeg -> cover
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      targetTerrain: "water1",
      attackerLevel: 2,
      targetLevel: 0,
      weapon: "Small Laser",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(true);
    expect(res.breakdown.terrainMod).toBe(0);
    expect(res.breakdown.coverMod).toBe(1);
    expect(res.groups).toHaveLength(0);
    expect(res.applications).toEqual([]);
    expect(rng.remaining()).toBe(0);
  });
});

describe("HAG cluster range modifier (TW p.136)", () => {
  // HAG 20: short 8 / medium 16 / long 24, minRange 2. TN at gunnery 4,
  // standing, clear: short 4, long 8.
  it("adds +2 to the cluster roll at short range", () => {
    const rng = scriptedRng(
      3,
      3, // to-hit 6 >= TN 4
      2,
      2, // raw cluster 4 -> +2 -> 6 -> 12 hits on the 20 column
      3,
      4, // lot 1 -> CT (7)
      3,
      4, // lot 2 -> CT
      3,
      4, // remainder -> CT
    );
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      distance: 5,
      weapon: "HAG 20",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(true);
    expect(res.breakdown.rangeBracket).toBe("short");
    expect(res.clusterRoll).toBe(4);
    expect(res.clusterMod).toBe(2);
    expect(res.groups.map((g) => g.damage)).toEqual([5, 5, 2]);
    expect(rng.remaining()).toBe(0);
  });

  it("subtracts 2 from the cluster roll at long range", () => {
    const rng = scriptedRng(
      4,
      4, // to-hit 8 >= TN 8
      6,
      6, // raw cluster 12 -> -2 -> 10 -> 16 hits on the 20 column
      3,
      4, // lot 1 -> CT
      3,
      4, // lot 2 -> CT
      3,
      4, // lot 3 -> CT
      3,
      4, // remainder -> CT
    );
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      distance: 20,
      weapon: "HAG 20",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(true);
    expect(res.breakdown.rangeBracket).toBe("long");
    expect(res.clusterRoll).toBe(12);
    expect(res.clusterMod).toBe(-2);
    expect(res.groups.map((g) => g.damage)).toEqual([5, 5, 5, 1]);
    expect(rng.remaining()).toBe(0);
  });

  it("leaves non-HAG cluster weapons unmodified (clusterMod null)", () => {
    const rng = scriptedRng(
      3,
      4, // to-hit 7 >= TN 6 (medium)
      2,
      2, // raw cluster 4 -> 9 hits on the 20 column
      3,
      4, // lot 1 -> CT
      3,
      4, // remainder -> CT
    );
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      distance: 10,
      weapon: "LRM 20",
      targetDamage: freshState(),
    });
    expect(res.hit).toBe(true);
    expect(res.clusterRoll).toBe(4);
    expect(res.clusterMod).toBeNull();
    expect(res.groups.map((g) => g.damage)).toEqual([5, 4]);
    expect(rng.remaining()).toBe(0);
  });
});

describe("through-armor criticals (hit-location roll of 2)", () => {
  const def = mechDef("HBK-4G")!;

  function critInput(rng: ReturnType<typeof scriptedRng>) {
    return {
      ...BASE,
      rng,
      weapon: "Small Laser",
      targetDamage: freshState(),
      targetCrits: {
        model: def.model,
        critSlotsDestroyed: freshFlags(def),
        ammoBins: loadAmmoBins(def),
      },
    } satisfies WeaponAttackInput;
  }

  it("rolls once on the determining table with armor unbreached (front CT)", () => {
    const rng = scriptedRng(
      2,
      3, // to-hit 5 >= TN 4
      1,
      1, // location 2 -> centerTorso, through-armor
      3,
      5, // determining 8 -> one crit
      1,
      1, // CT slot 1 (engine)
    );
    const res = resolveWeaponAttack(critInput(rng));
    expect(res.hit).toBe(true);
    expect(res.groups).toEqual([{ location: "centerTorso", damage: 3, throughArmor: true }]);
    // Damage lands on armor normally; structure untouched.
    expect(res.targetDamageAfter.armor.centerTorso).toBe(7);
    expect(res.targetDamageAfter.internalStructure.centerTorso).toBe(10);
    expect(res.crits).toHaveLength(1);
    expect(res.crits[0]!.throughArmor).toBe(true);
    expect(res.crits[0]!.determiningRoll).toBe(8);
    expect(res.crits[0]!.rows).toHaveLength(1);
    expect(rng.remaining()).toBe(0);
  });

  it("keeps a crit-severed leg on the crit, not on the damage application", () => {
    const state = freshState();
    state.armor.rightLeg = 0;
    const rng = scriptedRng(
      2,
      3, // to-hit 5 >= TN 4
      2,
      3, // location 5 -> rightLeg
      6,
      6, // determining 12 -> leg blown off
    );
    const res = resolveWeaponAttack({ ...critInput(rng), targetDamage: state });
    expect(res.groups[0]!.location).toBe("rightLeg");
    expect(critSeveredLimbs(res.crits[0]!)).toEqual(["rightLeg"]);
    // The blow-off is the crit's, not the damage's: the application still
    // shows the leg standing, the final state does not.
    expect(res.applications[0]!.blownOffLimbs).toEqual([]);
    expect(res.applications[0]!.after.internalStructure.rightLeg).toBeGreaterThan(0);
    expect(res.targetDamageAfter.internalStructure.rightLeg).toBe(0);
  });

  it("applies to the near torso on side columns (rightSide roll of 2)", () => {
    const rng = scriptedRng(
      2,
      3, // to-hit 5 >= TN 4
      1,
      1, // location 2 -> rightTorso on the right-side table, through-armor
      3,
      5, // determining 8 -> one crit
      1,
      1, // rightTorso slot 1 (AC/20)
    );
    const res = resolveWeaponAttack({ ...critInput(rng), arc: "rightSide" });
    expect(res.hit).toBe(true);
    expect(res.groups).toEqual([{ location: "rightTorso", damage: 3, throughArmor: true }]);
    expect(res.targetDamageAfter.armor.rightTorso).toBe(7);
    expect(res.crits).toHaveLength(1);
    expect(res.crits[0]!.throughArmor).toBe(true);
    expect(rng.remaining()).toBe(0);
  });

  it("rolls no determining table on other locations with armor unbreached", () => {
    const rng = scriptedRng(
      2,
      3, // to-hit 5 >= TN 4
      3,
      4, // location 7 -> centerTorso, ordinary
    );
    const res = resolveWeaponAttack(critInput(rng));
    expect(res.hit).toBe(true);
    expect(res.groups).toEqual([{ location: "centerTorso", damage: 3, throughArmor: false }]);
    expect(res.crits).toHaveLength(0);
    expect(rng.remaining()).toBe(0);
  });

  it("rolls twice when hit-location 2 also strips IS (TW p.124, in addition to)", () => {
    // Pre-armor CT = 2, IS CT = 10; 3pt Small Laser breaches armor + strips 1 IS.
    // Roll of 2 -> through-armor crit in addition to structure-damage crit (2 rolls).
    const rng = scriptedRng(
      2,
      3, // to-hit 5 >= TN 4
      1,
      1, // location 2 -> centerTorso, through-armor
      3,
      5, // determining 8 -> 1 crit (structure breach)
      1,
      1, // CT slot 1 (engine)
      3,
      5, // determining 8 -> 1 crit (through-armor)
      1,
      2, // CT slot 2 (engine)
    );
    const res = resolveWeaponAttack({
      ...critInput(rng),
      targetDamage: freshState(2),
    });
    expect(res.hit).toBe(true);
    expect(res.groups).toEqual([{ location: "centerTorso", damage: 3, throughArmor: true }]);
    expect(res.targetDamageAfter.armor.centerTorso).toBe(0);
    expect(res.targetDamageAfter.internalStructure.centerTorso).toBe(1);
    expect(res.crits).toHaveLength(2);
    expect(res.crits[0]!.throughArmor).toBe(false);
    expect(res.crits[0]!.determiningRoll).toBe(8);
    expect(res.crits[0]!.rows[0]!.kind).toBe("componentDestroyed");
    expect(res.crits[1]!.throughArmor).toBe(true);
    expect(res.crits[1]!.determiningRoll).toBe(8);
    // Second roll must not re-hit slot 1 (already destroyed by first call).
    expect(res.crits[1]!.rows[0]!.kind).toBe("componentDestroyed");
    expect(rng.remaining()).toBe(0);
  });
});

describe("split-weapon", () => {
  /**
   * Split-location weapons: a weapon whose crit slots span an arm and its
   * side torso (King Crab KGC-000: each arm AC/20 spills two slots into its
   * side torso). Covers slot linking, the torso firing arc (TW pp.105-106),
   * criticals in either location (TW pp.125-128), fireability when either
   * location is lost, and the arm semantics that stay with the arm.
   */

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
      expect(def.weapons[LA_AC20]).toMatchObject({
        location: "leftArm",
        splitLocation: "leftTorso",
      });
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
});

describe("streak-simultaneous", () => {
  // TW resolves weapon attacks simultaneously: a Streak launcher's ammo is read
  // as the attacker's bins stood at phase start, so damage another unit deals
  // to the bin's location earlier in the resolution order cannot void it.
  const MC = buildUnitInit("mc", "MC-MKII-2", 1, { col: 2, row: 4 }, "ne");
  const ENF = buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 4 }, "nw");

  /** Attack phase with mc's only live Streak bin (RT:7) in a right torso the
   *  ENF's AC/10 (weapon 1, front arc, roll 6 = RT) destroys outright. */
  function setup(units: UnitInit[], rtShots?: number): BattleState {
    const state = createTestBattle([], units, true);
    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
    advancePhase(state, [], scriptedRng());
    const mc = requireUnit(state, "mc");
    mc.ammoBins["leftTorso:7"] = 0;
    if (rtShots !== undefined) mc.ammoBins["rightTorso:7"] = rtShots;
    mc.damage.armor.rightTorso = 0;
    mc.damage.internalStructure.rightTorso = 1;
    return state;
  }

  /** Declares in unit order (initiative ties keep it), which is also the
   *  resolution order. */
  function declare(state: BattleState, streaks: number[]): void {
    for (const id of Object.keys(state.units)) {
      const decls =
        id === "enf"
          ? [{ weaponIndex: 1, targetId: "mc" }]
          : streaks.map((weaponIndex) => ({ weaponIndex, targetId: "enf" }));
      declareAttacks(state, id, decls, [], [], scriptedRng());
    }
  }

  /** All 3s: every to-hit is 6 (TN 4), every location roll 6 (front RT). */
  function resolve(state: BattleState): AttackResolution[] {
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(...Array<number>(32).fill(3)), events);
    return events.flatMap((e) =>
      e.kind === "attackResolved" && e.resolution.weapon === "CL Streak SRM 4"
        ? [e.resolution]
        : [],
    );
  }

  describe("streak ammo under simultaneous fire", () => {
    it("fires from a bin destroyed earlier in the same phase", () => {
      const state = setup([ENF, MC]);
      expect(requireUnit(state, "mc").ammoBins["rightTorso:7"]).toBe(25);
      declare(state, [3]);
      const [streak] = resolve(state);
      const mc = requireUnit(state, "mc");
      // Precondition: the AC/10 resolved first and destroyed the RT.
      expect(mc.damage.internalStructure.rightTorso).toBe(0);
      expect(streak!.ammoExhausted).toBe(false);
      expect(streak!.toHitRoll).toBe(6);
      expect(streak!.hit).toBe(true);
      expect(streak!.groups).toHaveLength(4);
      // One shot spent; the rest is stranded in the destroyed torso.
      expect(mc.ammoBins["rightTorso:7"]).toBe(24);
      expect(mc.heatPending).toBe(3);
    });

    it("gives the same volley and bins whichever unit resolves first", () => {
      const enfFirst = setup([ENF, MC]);
      const mcFirst = setup([MC, ENF]);
      declare(enfFirst, [3]);
      declare(mcFirst, [3]);
      const a = resolve(enfFirst);
      const b = resolve(mcFirst);
      expect(requireUnit(mcFirst, "mc").damage.internalStructure.rightTorso).toBe(0);
      expect(a).toEqual(b);
      expect(requireUnit(enfFirst, "mc").ammoBins).toEqual(requireUnit(mcFirst, "mc").ammoBins);
    });

    it("does not spend the last phase-start shot twice", () => {
      const state = setup([ENF, MC], 1);
      expect(
        pooledShotsLeft(mechDef("MC-MKII-2")!, requireUnit(state, "mc"), "CL Streak SRM 4"),
      ).toBe(1);
      declare(state, [3, 5]);
      const [first, second] = resolve(state);
      const mc = requireUnit(state, "mc");
      expect(mc.damage.internalStructure.rightTorso).toBe(0);
      expect(first!.hit).toBe(true);
      expect(first!.ammoExhausted).toBe(false);
      expect(second!.hit).toBe(false);
      expect(second!.ammoExhausted).toBe(true);
      expect(second!.toHitRoll).toBeNull();
      expect(mc.ammoBins["rightTorso:7"]).toBe(0);
      expect(mc.heatPending).toBe(3);
    });
  });
});

describe("hitlocation", () => {
  describe("hit location table", () => {
    it("maps every 2D6 result per the record sheets", () => {
      expect(hitLocation(2)).toBe("centerTorso");
      expect(hitLocation(3)).toBe("rightArm");
      expect(hitLocation(4)).toBe("rightArm");
      expect(hitLocation(5)).toBe("rightLeg");
      expect(hitLocation(6)).toBe("rightTorso");
      expect(hitLocation(7)).toBe("centerTorso");
      expect(hitLocation(8)).toBe("leftTorso");
      expect(hitLocation(9)).toBe("leftLeg");
      expect(hitLocation(10)).toBe("leftArm");
      expect(hitLocation(11)).toBe("leftArm");
      expect(hitLocation(12)).toBe("head");
    });

    it("rejects impossible rolls", () => {
      expect(() => hitLocation(1)).toThrow();
      expect(() => hitLocation(13)).toThrow();
    });

    it("front and rear arcs share the front/rear column", () => {
      for (const roll of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
        expect(hitLocationForArc("front", roll)).toBe(HIT_LOCATION_TABLE[roll]);
        expect(hitLocationForArc("rear", roll)).toBe(HIT_LOCATION_TABLE[roll]);
      }
    });

    it("uses the left-side table for the left side arc", () => {
      for (const roll of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
        expect(hitLocationForArc("leftSide", roll)).toBe(LEFT_SIDE_TABLE[roll]);
      }
      expect(hitLocationForArc("leftSide", 2)).toBe("leftTorso");
      expect(hitLocationForArc("leftSide", 8)).toBe("centerTorso");
    });

    it("uses the right-side table for the right side arc", () => {
      for (const roll of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
        expect(hitLocationForArc("rightSide", roll)).toBe(RIGHT_SIDE_TABLE[roll]);
      }
      expect(hitLocationForArc("rightSide", 2)).toBe("rightTorso");
      expect(hitLocationForArc("rightSide", 8)).toBe("centerTorso");
    });

    it("rejects impossible rolls for every arc", () => {
      for (const arc of ["front", "rear", "leftSide", "rightSide"] as const) {
        expect(() => hitLocationForArc(arc, 1)).toThrow();
        expect(() => hitLocationForArc(arc, 13)).toThrow();
      }
    });
  });

  describe("cluster hits tables", () => {
    it("matches the missile table (TW p. 116)", () => {
      expect(clusterHits(2, 2)).toBe(1);
      expect(clusterHits(2, 12)).toBe(2);
      expect(clusterHits(4, 11)).toBe(4);
      expect(clusterHits(5, 4)).toBe(2);
      expect(clusterHits(6, 8)).toBe(4);
      expect(clusterHits(10, 9)).toBe(8);
      expect(clusterHits(10, 12)).toBe(10);
      expect(clusterHits(15, 11)).toBe(15);
      expect(clusterHits(20, 7)).toBe(12);
      expect(clusterHits(20, 12)).toBe(20);
    });

    it("matches the full weapon-size columns incl. large launchers", () => {
      expect(clusterHits(30, 2)).toBe(10);
      expect(clusterHits(30, 4)).toBe(12);
      expect(clusterHits(30, 9)).toBe(24);
      expect(clusterHits(40, 2)).toBe(12);
      expect(clusterHits(40, 4)).toBe(18);
      expect(clusterHits(40, 5)).toBe(24);
      expect(clusterHits(40, 9)).toBe(32);
      expect(clusterHits(40, 11)).toBe(40);
      expect(clusterHits(7, 6)).toBe(4);
      expect(clusterHits(13, 8)).toBe(8);
    });

    it("matches the size-8 column (all eleven 2D6 rows, TW p. 116)", () => {
      // Full column, so a single transposed cell cannot pass unnoticed.
      const column = Array.from({ length: 11 }, (_, i) => clusterHits(8, i + 2));
      expect(column).toEqual([3, 3, 4, 4, 5, 5, 5, 6, 6, 8, 8]);
    });

    it("shares the same table for rapid-fire shots (2/3/4)", () => {
      expect(clusterHits(2, 2)).toBe(1);
      expect(clusterHits(2, 12)).toBe(2);
      expect(clusterHits(3, 7)).toBe(2);
      expect(clusterHits(4, 11)).toBe(4);
    });

    it("groups LRM missiles into lots of five", () => {
      expect(groupMissiles(10, 5)).toEqual([5, 5]);
      expect(groupMissiles(8, 5)).toEqual([5, 3]);
      expect(groupMissiles(3, 5)).toEqual([3]);
    });
  });
});

describe("cluster", () => {
  describe("modifiedClusterRoll (HAG range mod, TW p.136)", () => {
    it("adds the modifier to the 2D6 roll", () => {
      expect(modifiedClusterRoll(7, 2)).toBe(9);
      expect(modifiedClusterRoll(7, 0)).toBe(7);
      expect(modifiedClusterRoll(7, -2)).toBe(5);
    });

    it("clamps results below 2 up to 2 and above 12 down to 12", () => {
      expect(modifiedClusterRoll(2, -2)).toBe(2);
      expect(modifiedClusterRoll(3, -2)).toBe(2);
      expect(modifiedClusterRoll(12, 2)).toBe(12);
      expect(modifiedClusterRoll(11, 2)).toBe(12);
      expect(modifiedClusterRoll(2, 0)).toBe(2);
      expect(modifiedClusterRoll(12, 0)).toBe(12);
    });

    it("feeds the Cluster Hits Table through clusterHits", () => {
      // 20-column, roll 6 -> 12 hits; the +2 short-range mod turns a raw 4 into that row.
      expect(clusterHits(20, modifiedClusterRoll(4, 2))).toBe(clusterHits(20, 6));
      expect(clusterHits(20, modifiedClusterRoll(4, 2))).toBe(12);
    });
  });

  describe("expectedClusterHits", () => {
    it("averages the Cluster Hits Table over 2D6 (TW p. 116)", () => {
      // Column 2: rolls 2-7 hit once (21 of 36 ways), rolls 8-12 hit twice (15 ways).
      expect(expectedClusterHits(2)).toBeCloseTo(51 / 36, 10);
      // Column 40 tops out at 40 and never drops below 12.
      expect(expectedClusterHits(40)).toBeGreaterThan(12);
      expect(expectedClusterHits(40)).toBeLessThan(40);
    });
  });
});

describe("AMS (TW p.129)", () => {
  const AMS = { weaponIndex: 0, weapon: "Anti-Missile System" } as const;

  it("takes 4 off the Cluster roll, never below 2", () => {
    const rng = scriptedRng(
      3,
      3, // to-hit 6 >= TN 4
      2,
      3, // raw cluster 5 -> 12 on the 20 column; 5 - 4 = 1 -> floor 2 -> 6
      3,
      4, // lot of 5 -> CT
      3,
      4, // lot of 1 -> CT
    );
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      distance: 7,
      weapon: "LRM 20",
      targetDamage: freshState(),
      missileDefense: () => AMS,
    });
    expect(res.clusterRoll).toBe(5);
    expect(res.missileDefense).toEqual({ ...AMS, hitsWithout: 12, hitsWith: 6 });
    expect(res.groups.map((g) => g.damage)).toEqual([5, 1]);
    expect(rng.remaining()).toBe(0);
  });

  it("counts a Streak volley as a roll of 11 before the -4 and throws no cluster dice", () => {
    const rng = scriptedRng(3, 3, 3, 4, 3, 4, 3, 4, 3, 4);
    const res = resolveWeaponAttack({
      ...BASE,
      rng,
      weapon: "Streak SRM 6",
      targetDamage: freshState(),
      missileDefense: () => AMS,
    });
    expect(res.clusterRoll).toBeNull();
    expect(res.missileDefense).toEqual({ ...AMS, hitsWithout: 6, hitsWith: 4 });
    expect(res.groups).toHaveLength(4);
    expect(rng.remaining()).toBe(0);
  });

  it("is only asked about missile attacks that hit", () => {
    let asked = 0;
    const missileDefense = () => {
      asked += 1;
      return AMS;
    };
    const miss = resolveWeaponAttack({
      ...BASE,
      rng: scriptedRng(1, 1),
      distance: 7,
      weapon: "LRM 20",
      targetDamage: freshState(),
      missileDefense,
    });
    expect(miss.hit).toBe(false);
    const cannon = resolveWeaponAttack({
      ...BASE,
      rng: scriptedRng(3, 3, 3, 4),
      weapon: "AC/20",
      targetDamage: freshState(30),
      missileDefense,
    });
    expect(cannon.hit).toBe(true);
    expect(cannon.missileDefense).toBeUndefined();
    expect(asked).toBe(0);
  });

  it("lets a declined attack through unchanged", () => {
    const res = resolveWeaponAttack({
      ...BASE,
      rng: scriptedRng(3, 3, 2, 3, 3, 4, 3, 4, 3, 4),
      distance: 7,
      weapon: "LRM 20",
      targetDamage: freshState(),
      missileDefense: () => null,
    });
    expect(res.missileDefense).toBeUndefined();
    expect(res.groups.map((g) => g.damage)).toEqual([5, 5, 2]);
  });

  it("missiles the AMS destroyed do not strike an adjacent building", () => {
    const res = resolveWeaponAttack({
      ...BASE,
      rng: scriptedRng(3, 3, 2, 3, 3, 4, 3, 4),
      distance: 7,
      weapon: "LRM 20",
      targetDamage: freshState(),
      missesStrikeBuilding: true,
      missileDefense: () => AMS,
    });
    // 20 fired, 12 would hit, the AMS stops 6: only the 8 true misses fly on.
    expect(res.buildingAbsorbed).toBe(8);
  });
});

describe("AMS policy (amsPolicy)", () => {
  const w = (name: string) => weaponDef(name)!;
  const attack = (
    key: number,
    name: string,
    hitChance = 1,
    coveredBy: readonly number[] = [0],
  ): AmsAttack => ({ key, weapon: w(name), hitChance, coveredBy });

  it("values an engagement by the damage it saves", () => {
    expect(amsExpectedSaving(w("Streak SRM 6"))).toBe(4);
    expect(amsExpectedSaving(w("LRM 20"))).toBeCloseTo(4.61, 2);
    expect(amsExpectedSaving(w("LRM 15"))).toBeCloseTo(3.25, 2);
    expect(amsExpectedSaving(w("SRM 6"))).toBeCloseTo(2.83, 2);
    expect(amsExpectedSaving(w("LRM 10"))).toBeCloseTo(2.33, 2);
    expect(isAmsEngageable(w("LRM 5"))).toBe(true);
    expect(isAmsEngageable(w("LB 10-X AC"))).toBe(false);
    expect(isAmsEngageable(w("HAG 20"))).toBe(false);
  });

  it("off never engages; first-hit engages at once", () => {
    const now = attack(0, "LRM 5");
    const later = [attack(1, "LRM 20")];
    expect(chooseAms("off", now, [0], later)).toBeNull();
    expect(chooseAms("firstHit", now, [0], later)).toBe(0);
    expect(chooseAms("expected", now, [], [])).toBeNull();
  });

  it("expected waits for a bigger saving still to come, weighted by its hit chance", () => {
    const srm = attack(0, "SRM 6");
    expect(chooseAms("expected", srm, [0], [attack(1, "LRM 20", 0.9)])).toBeNull();
    // A long shot is not worth waiting for: 4.61 x 0.3 < 2.83.
    expect(chooseAms("expected", srm, [0], [attack(1, "LRM 20", 0.3)])).toBe(0);
    // Streak SRM 6 (4 sure) beats a sure LRM 15 hit (3.25).
    expect(chooseAms("expected", attack(0, "Streak SRM 6"), [0], [attack(1, "LRM 15")])).toBe(0);
  });

  it("priority goes by full-volley damage, Streak first on ties", () => {
    const streak4 = attack(0, "Streak SRM 4");
    const lrm10 = attack(1, "LRM 10", 0.5);
    // 8 damage volley waits for a 10 damage one; expected takes the sure 2.
    expect(chooseAms("priority", streak4, [0], [lrm10])).toBeNull();
    expect(chooseAms("expected", streak4, [0], [lrm10])).toBe(0);
    expect(amsPriority(w("Streak SRM 6"))).toBeGreaterThan(amsPriority(w("SRM 6")));
    expect(chooseAms("priority", attack(0, "SRM 6"), [0], [attack(1, "Streak SRM 6")])).toBeNull();
    expect(chooseAms("priority", attack(0, "Streak SRM 6"), [0], [attack(1, "SRM 6")])).toBe(0);
  });

  it("uses the AMS the pending attacks need least", () => {
    const now = attack(0, "LRM 20", 1, [0, 1]);
    const later = [attack(1, "LRM 20", 1, [0])];
    for (const policy of ["expected", "firstHit", "priority"] as const) {
      expect(chooseAms(policy, now, [0, 1], later)).toBe(1);
    }
  });
});
