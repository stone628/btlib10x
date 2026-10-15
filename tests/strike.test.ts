/**
 * Physical-weapon strike tests (TW p.146).
 * Covers hatchet / sword / retractable-blade catalog entries, to-hit
 * modifiers, tonnage damage, mounting-arm arc gates, destroyed-equipment
 * and actuator handling, weapon-fire interaction, and full-phase
 * resolution for the Hatchetman HCT-5S (the only bundled 'Mech mounting
 * one of the three modeled weapons).
 */

import { describe, expect, it } from "vitest";
import hct5sJson from "../data/mechs/hct-5s.json";
import {
  type BattleState,
  createBattle,
  declareAttacks,
  type GameEvent,
  type HexCoord,
  mechDefFor,
  type Rng,
  suggestFireTargets,
  type UnitInit,
} from "../src";
import type { Location } from "../src/core/types";
import { type MechDef, type ResolvedMechDef, resolveMechDef } from "../src/data/index";
import { parseWeaponsData } from "../src/data/weapon.schema";
import { WEAPON_DATA } from "../src/data/weapons.data";
import { isWeaponCritted, setSlotDestroyed } from "../src/rules/critical";

/** Raw HCT-5S sheet as written in data/mechs/hct-5s.json. */
const hct5sRaw = hct5sJson as unknown as MechDef;

import {
  buildUnitInit,
  resolveAllAttacks,
  type TeamId,
  validateAttacksImpl,
} from "../src/rules/game";
import {
  computePhysicalToHit,
  isPhysicalWeaponName,
  PHYSICAL_WEAPONS,
  type PhysicalAttackDecl,
  physicalDamage,
  resolvePhysicalAttack,
  resolveStrikeArm,
  resolveStrikeMount,
  strikeMountArms,
  strikeWeaponInArm,
  validatePhysicalAttack,
} from "../src/rules/physical";
import {
  commitAttack,
  commitMovement,
  declareMovementMode,
  newSession,
  queuePhysicalAttack,
  type Session,
} from "../web/terminal/session";
import { critWeapon, disableCritical, execute, seededRng } from "./helpers";

function makeUnitInit(
  id: string,
  team: TeamId,
  hex: HexCoord,
  facing: "n" | "ne" | "se" | "s" | "sw" | "nw" = "se",
  model = "HCT-5S",
): UnitInit {
  return buildUnitInit(id, model, team, hex, facing);
}

/** Attacker faces its target dead-on (front arc for any arm). */
function faceToFaceBattle(attackerModel = "HCT-5S", targetModel = "HBK-4G"): BattleState {
  const battle = createBattle(
    {
      name: "test",
      width: 20,
      height: 20,
      terrain: [],
      legends: [],
    },
    [
      makeUnitInit("a", 1, { col: 5, row: 5 }, "se", attackerModel),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "nw", targetModel),
    ],
    { critsDisabled: true },
  );
  battle.phase = "attack";
  battle.initiativeWinnerTeam = 2;
  battle.actorQueue = ["a", "t"];
  battle.actedThisPhase = [];
  return battle;
}

/** RNG that always rolls 6 (high roll, likely to hit). */
const HIGH_RNG: Rng = {
  d6: () => 6,
  snapshot: () => "",
  load: () => {},
};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe("physical weapon catalog", () => {
  it("ships hatchet, sword, and retractable blade as non-firing equipment", () => {
    for (const name of ["Hatchet", "Sword", "Retractable Blade"] as const) {
      expect(isPhysicalWeaponName(name)).toBe(true);
    }
    expect(isPhysicalWeaponName("Medium Laser")).toBe(false);
    expect(PHYSICAL_WEAPONS.Hatchet.toHitMod).toBe(-1);
    expect(PHYSICAL_WEAPONS.Sword.toHitMod).toBe(-2);
    expect(PHYSICAL_WEAPONS["Retractable Blade"].toHitMod).toBe(-2);
  });

  it("round-trips the catalog through the weapon validator", () => {
    expect(() => parseWeaponsData(WEAPON_DATA)).not.toThrow();
  });

  it("links the Hatchetman's three hatchet slots to one right-arm mount", () => {
    const def = mechDefFor({ model: "HCT-5S" });
    expect(strikeMountArms(def, "Hatchet")).toEqual(["rightArm"]);
    expect(strikeMountArms(def, "Sword")).toEqual([]);
    const mounts = Object.values(def.weapons).filter((m) => m.weapon === "Hatchet");
    expect(mounts.length).toBe(1);
    expect(mounts[0]!.location).toBe("rightArm");
    const hatchetSlots = def.critSlots.rightArm.filter(
      (s) => s.kind === "weapon" && s.weapon === "Hatchet",
    );
    expect(hatchetSlots.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// To-hit and damage
// ---------------------------------------------------------------------------

describe("strike to-hit and damage", () => {
  it("reads the per-weapon to-hit modifier", () => {
    const battle = faceToFaceBattle();
    const attacker = battle.units.a!;
    const target = battle.units.t!;
    expect(
      computePhysicalToHit(battle, attacker, target, "strike", "rightArm", "Hatchet").attackMod,
    ).toBe(-1);
    expect(
      computePhysicalToHit(battle, attacker, target, "strike", "rightArm", "Sword").attackMod,
    ).toBe(-2);
    expect(
      computePhysicalToHit(battle, attacker, target, "strike", "rightArm", "Retractable Blade")
        .attackMod,
    ).toBe(-2);
  });

  it("computes tonnage damage (45t hatchet 9, sword 6, blade 5)", () => {
    const battle = faceToFaceBattle();
    const attacker = battle.units.a!;
    // HCT-5S = 45 tons → hatchet ceil(45/5) = 9
    expect(physicalDamage("strike", attacker, "rightArm", "Hatchet")).toBe(9);
  });

  it("computes sword/blade damage on the formula (50t: sword 6, blade 5)", () => {
    const battle = faceToFaceBattle("HBK-4G");
    const attacker = battle.units.a!;
    // HBK-4G = 50 tons → sword ceil(50/10)+1 = 6, blade ceil(50/10) = 5
    expect(physicalDamage("strike", attacker, undefined, "Sword")).toBe(6);
    expect(physicalDamage("strike", attacker, undefined, "Retractable Blade")).toBe(5);
  });

  it("halves hatchet damage on a damaged upper arm actuator", () => {
    const battle = faceToFaceBattle();
    const attacker = battle.units.a!;
    setSlotDestroyed(attacker.critSlotsDestroyed, "rightArm", 1); // upperArmActuator
    // 9 → floor(9/2) = 4
    expect(physicalDamage("strike", attacker, "rightArm", "Hatchet")).toBe(4);
  });

  it("adds actuator to-hit for a damaged hand, and upper arm", () => {
    const battle = faceToFaceBattle();
    const attacker = battle.units.a!;
    const target = battle.units.t!;
    setSlotDestroyed(attacker.critSlotsDestroyed, "rightArm", 3); // handActuator
    expect(
      computePhysicalToHit(battle, attacker, target, "strike", "rightArm", "Hatchet").actuatorMod,
    ).toBe(1);
    setSlotDestroyed(attacker.critSlotsDestroyed, "rightArm", 1); // upperArmActuator
    expect(
      computePhysicalToHit(battle, attacker, target, "strike", "rightArm", "Hatchet").actuatorMod,
    ).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("strike validation", () => {
  function hatchetDecl(extra?: Partial<PhysicalAttackDecl>): PhysicalAttackDecl {
    return { type: "strike", targetId: "t", limb: "rightArm", weapon: "Hatchet", ...extra };
  }

  it("accepts a face-to-face hatchet strike", () => {
    const battle = faceToFaceBattle();
    expect(validatePhysicalAttack(battle, "a", hatchetDecl()).ok).toBe(true);
  });

  it("defaults a limbless strike to the mounting arm", () => {
    const battle = faceToFaceBattle();
    const def = mechDefFor(battle.units.a!);
    expect(resolveStrikeArm(def, "Hatchet", undefined)).toBe("rightArm");
    const limbless: PhysicalAttackDecl = {
      type: "strike",
      targetId: "t",
      weapon: "Hatchet",
    };
    expect(validatePhysicalAttack(battle, "a", limbless).ok).toBe(true);
  });

  it("rejects a strike without a weapon", () => {
    const battle = faceToFaceBattle();
    const result = validatePhysicalAttack(battle, "a", { type: "strike", targetId: "t" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("physical weapon");
  });

  it("rejects a strike on a 'Mech with no such mount", () => {
    const battle = faceToFaceBattle("HBK-4G");
    const result = validatePhysicalAttack(battle, "a", hatchetDecl());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not mount");
  });

  it("rejects a strike from the wrong side arc", () => {
    // Target in the adjacent southwest hex = leftSide template arc for a
    // north-facing 'Mech; the hatchet sits in the right arm.
    const battle = createBattle(
      { name: "test", width: 20, height: 20, terrain: [], legends: [] },
      [
        makeUnitInit("a", 1, { col: 10, row: 10 }, "n"),
        makeUnitInit("t", 2, { col: 9, row: 11 }, "s"),
      ],
      { critsDisabled: true },
    );
    const result = validatePhysicalAttack(battle, "a", hatchetDecl());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("side arc");
  });

  it("rejects a strike with a destroyed shoulder", () => {
    const battle = faceToFaceBattle();
    setSlotDestroyed(battle.units.a!.critSlotsDestroyed, "rightArm", 0); // shoulder
    const result = validatePhysicalAttack(battle, "a", hatchetDecl());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("shoulder");
  });

  it("rejects a strike when the equipment is destroyed by a crit", () => {
    const battle = faceToFaceBattle();
    const def = mechDefFor(battle.units.a!);
    const hatchetIndex = Number(
      Object.keys(def.weapons).find((k) => def.weapons[Number(k)]?.weapon === "Hatchet"),
    );
    critWeapon(battle.units.a!, hatchetIndex);
    const result = validatePhysicalAttack(battle, "a", hatchetDecl());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("destroyed");
  });

  it("rejects a strike from a destroyed arm location", () => {
    const battle = faceToFaceBattle();
    battle.units.a!.damage.internalStructure.rightArm = 0;
    const result = validatePhysicalAttack(battle, "a", hatchetDecl());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("destroyed");
  });

  it("judges the striking arm against the supplied phase-start damage", () => {
    const battle = faceToFaceBattle();
    const intact = { ...battle.units.a!.damage };
    battle.units.a!.damage = {
      ...intact,
      internalStructure: { ...intact.internalStructure, rightTorso: 0 },
    };
    // Support torso lost to this phase's weapon fire: the phase-start state still allows the strike.
    const r = validatePhysicalAttack(battle, "a", hatchetDecl(), null, false, intact);
    expect(r.ok).toBe(true);
    // Without it, the live (destroyed) state rejects.
    expect(validatePhysicalAttack(battle, "a", hatchetDecl()).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Declaration interaction
// ---------------------------------------------------------------------------

describe("strike declaration interaction", () => {
  function armAndTorsoWeaponIndices(battle: BattleState): { arm: number; torso: number } {
    const def = mechDefFor(battle.units.a!);
    const arm = Number(
      Object.keys(def.weapons).find(
        (k) =>
          def.weapons[Number(k)]?.location === "rightArm" &&
          def.weapons[Number(k)]?.weapon === "Medium Pulse Laser",
      ),
    );
    const torso = Number(
      Object.keys(def.weapons).find((k) => {
        const loc = def.weapons[Number(k)]?.location;
        return loc === "centerTorso" || loc === "leftTorso" || loc === "rightTorso";
      }),
    );
    expect(Number.isInteger(arm)).toBe(true);
    expect(Number.isInteger(torso)).toBe(true);
    return { arm, torso };
  }

  it("allows a strike plus a torso weapon, but not the striking arm's weapon", () => {
    const battle = faceToFaceBattle();
    const { arm, torso } = armAndTorsoWeaponIndices(battle);
    const events: GameEvent[] = [];
    expect(() =>
      declareAttacks(
        battle,
        "a",
        [{ weaponIndex: torso, targetId: "t" }],
        [{ type: "strike", targetId: "t", limb: "rightArm", weapon: "Hatchet" }],
        events,
        HIGH_RNG,
      ),
    ).not.toThrow();
    expect(battle.units.a!.declaredPhysicalAttacks[0]!.weapon).toBe("Hatchet");

    const battle2 = faceToFaceBattle();
    expect(() =>
      declareAttacks(
        battle2,
        "a",
        [{ weaponIndex: arm, targetId: "t" }],
        [{ type: "strike", targetId: "t", limb: "rightArm", weapon: "Hatchet" }],
        [],
        HIGH_RNG,
      ),
    ).toThrow(/cannot fire/);
    expect(battle2.units.a!.declaredWeaponAttacks).toEqual([]);
    expect(battle2.units.a!.declaredPhysicalAttacks).toEqual([]);
  });

  it("rejects firing a hatchet as a ranged weapon", () => {
    const battle = faceToFaceBattle();
    const def = mechDefFor(battle.units.a!);
    const hatchetIndex = Number(
      Object.keys(def.weapons).find((k) => def.weapons[Number(k)]?.weapon === "Hatchet"),
    );
    expect(() =>
      validateAttacksImpl(battle, "a", [{ weaponIndex: hatchetIndex, targetId: "t" }], []),
    ).toThrow(/strike with it/);
  });

  it("rejects two strikes in one turn", () => {
    const battle = faceToFaceBattle();
    expect(() =>
      declareAttacks(
        battle,
        "a",
        [],
        [
          { type: "strike", targetId: "t", limb: "rightArm", weapon: "Hatchet" },
          { type: "strike", targetId: "t", limb: "rightArm", weapon: "Hatchet" },
        ],
        [],
        HIGH_RNG,
      ),
    ).toThrow(/only one physical weapon attack/);
  });

  it("rejects mixing strikes with other physical types", () => {
    const battle = faceToFaceBattle();
    expect(() =>
      declareAttacks(
        battle,
        "a",
        [],
        [
          { type: "punch", targetId: "t", limb: "rightArm" },
          { type: "strike", targetId: "t", limb: "rightArm", weapon: "Hatchet" },
        ],
        [],
        HIGH_RNG,
      ),
    ).toThrow(/only one type/);
  });

  it("keeps hatchets out of the ranged fire suggestion", () => {
    const battle = faceToFaceBattle();
    const sugg = suggestFireTargets(battle, "a");
    for (const target of sugg.targets) {
      for (const w of [
        ...target.weapons,
        ...target.weaponsIfPropLeft,
        ...target.weaponsIfPropRight,
      ]) {
        expect(w.weapon).not.toBe("Hatchet");
      }
      for (const b of [
        ...target.blocked,
        ...target.blockedIfPropLeft,
        ...target.blockedIfPropRight,
      ]) {
        expect(b.weapon).not.toBe("Hatchet");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("strike resolution", () => {
  it("resolves a hatchet hit with tonnage damage on the standard table", () => {
    const battle = faceToFaceBattle();
    const decl: PhysicalAttackDecl = {
      type: "strike",
      targetId: "t",
      limb: "rightArm",
      weapon: "Hatchet",
    };
    const resolution = resolvePhysicalAttack(battle, "a", decl, HIGH_RNG);
    expect(resolution.hit).toBe(true);
    expect(resolution.weapon).toBe("Hatchet");
    expect(resolution.damageToTarget.length).toBe(1);
    expect(resolution.damageToTarget[0]!.damage).toBe(9);
  });

  it("resolves through declareAttacks + resolveAllAttacks with a weapon tag", () => {
    const battle = faceToFaceBattle();
    const events: GameEvent[] = [];
    declareAttacks(
      battle,
      "a",
      [],
      [{ type: "strike", targetId: "t", limb: "rightArm", weapon: "Hatchet" }],
      events,
      HIGH_RNG,
    );
    const declared = events.find((e) => e.kind === "attacksDeclared");
    expect(declared?.physical).toEqual([{ type: "strike", targetId: "t", weapon: "Hatchet" }]);

    const resolved: GameEvent[] = [];
    resolveAllAttacks(battle, HIGH_RNG, resolved);
    const physEvent = resolved.find((e) => e.kind === "physicalAttackResolved");
    expect(physEvent).toBeDefined();
    if (physEvent && physEvent.kind === "physicalAttackResolved") {
      expect(physEvent.resolution.hit).toBe(true);
      expect(physEvent.resolution.weapon).toBe("Hatchet");
      expect(physEvent.resolution.damageToTarget[0]!.damage).toBe(9);
    }
    expect(battle.units.a!.declaredPhysicalAttacks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Mount resolution (arm-selected strikes)
// ---------------------------------------------------------------------------

describe("resolveStrikeMount", () => {
  it("resolves the sole mount when the arm is omitted", () => {
    const def = mechDefFor({ model: "HCT-5S" });
    expect(resolveStrikeMount(def, undefined)).toEqual({
      ok: true,
      arm: "rightArm",
      weapon: "Hatchet",
    });
    expect(strikeWeaponInArm(def, "rightArm")).toBe("Hatchet");
    expect(strikeWeaponInArm(def, "leftArm")).toBeNull();
  });

  it("selects the named arm and reports an empty arm as none", () => {
    const def = mechDefFor({ model: "HCT-5S" });
    expect(resolveStrikeMount(def, "rightArm")).toEqual({
      ok: true,
      arm: "rightArm",
      weapon: "Hatchet",
    });
    expect(resolveStrikeMount(def, "leftArm")).toEqual({ ok: false, reason: "none" });
  });

  it("reports none for a unit with no mounts", () => {
    const def = mechDefFor({ model: "HBK-4G" });
    expect(resolveStrikeMount(def, undefined)).toEqual({ ok: false, reason: "none" });
  });

  it("reports ambiguous for a dual mount and selects per arm", () => {
    const dual: MechDef = {
      ...hct5sRaw,
      weapons: [...hct5sRaw.weapons, { weapon: "Sword", location: "leftArm" }],
      critSlots: {
        ...hct5sRaw.critSlots,
        leftArm: hct5sRaw.critSlots.leftArm.map((s, i) =>
          i === 8 ? { kind: "weapon", weapon: "Sword" } : s,
        ),
      },
    };
    const def: ResolvedMechDef = resolveMechDef(dual);
    const swordSlots = def.critSlots.leftArm.filter(
      (s) => s.kind === "weapon" && s.weapon === "Sword",
    );
    expect(swordSlots.length).toBe(1);
    expect(resolveStrikeMount(def, undefined)).toEqual({ ok: false, reason: "ambiguous" });
    expect(resolveStrikeMount(def, "rightArm")).toEqual({
      ok: true,
      arm: "rightArm",
      weapon: "Hatchet",
    });
    expect(resolveStrikeMount(def, "leftArm")).toEqual({
      ok: true,
      arm: "leftArm",
      weapon: "Sword",
    });
  });
});

// ---------------------------------------------------------------------------
// Session: bare `strike <target>` form
// ---------------------------------------------------------------------------

describe("strike command", () => {
  /** Hatchetman (a) facing an enemy (t) on quickstart, advanced to a's attack activation. */
  function hatchetSetup(): { s: Session; enemy: string } {
    const s = newSession(42);
    execute(s, "map quickstart");
    execute(s, "add a HCT-5S 9 9 n");
    execute(s, "add t HBK-4G 9 8 s");
    execute(s, "start");
    disableCritical(s);
    while (s.state === "battle" && s.battle!.phase === "movement") {
      declareMovementMode(s, "walk");
      commitMovement(s);
    }
    expect(s.battle!.phase).toBe("attack");
    while (s.state === "battle" && s.battle!.phase === "attack" && s.attack!.actorId !== "a") {
      commitAttack(s);
    }
    expect(s.attack!.actorId).toBe("a");
    return { s, enemy: "t" };
  }

  it("queues a bare strike on the sole mount", () => {
    const { s, enemy } = hatchetSetup();
    queuePhysicalAttack(s, "strike", enemy);
    expect(s.attack!.physicalDecls).toEqual([
      { type: "strike", targetId: enemy, limb: "rightArm", weapon: "Hatchet" },
    ]);
  });

  it("rejects an empty arm with a mount hint", () => {
    const { s, enemy } = hatchetSetup();
    expect(() => queuePhysicalAttack(s, "strike", enemy, "leftArm")).toThrow(
      /no physical weapon mounted in leftArm/,
    );
    expect(s.attack!.physicalDecls).toEqual([]);
  });

  it("runs the CLI bare form through status and done", () => {
    const { s, enemy } = hatchetSetup();
    expect(execute(s, `strike ${enemy}`)[0]).toBe(`queued strike -> ${enemy}`);
    expect(execute(s, "status").join("\n")).toContain(`strike hatchet (rightArm) -> ${enemy}`);
    for (const line of execute(s, "done")) expect(line).not.toMatch(/^error:/);
  });

  it("rejects the CLI form on a unit with no mounts", () => {
    const { s, enemy } = hatchetSetup();
    // Retarget the duel: the armless unit is the enemy HBK-4G here, so drive
    // to its activation by passing on the hatchet unit first.
    commitAttack(s);
    expect(s.attack!.actorId).toBe(enemy);
    expect(execute(s, "strike a")[0]).toMatch(/^error: unit mounts no physical weapon$/);
  });
});

describe("simultaneous physical sub-pass (PHY-05)", () => {
  it("a hatchet crit from an earlier physical attack does not cancel the declared strike", () => {
    let seen = 0;
    for (let seed = 1; seed <= 400 && seen < 3; seed++) {
      const battle = createBattle(
        { name: "test", width: 20, height: 20, terrain: [], legends: [] },
        [
          makeUnitInit("a", 1, { col: 5, row: 5 }, "se", "HCT-5S"),
          makeUnitInit("t", 2, { col: 6, row: 5 }, "nw", "HBK-4G"),
        ],
      );
      battle.phase = "attack";
      battle.initiativeWinnerTeam = 1;
      battle.actorQueue = ["t", "a"];
      battle.actedThisPhase = [];
      const a = battle.units.a!;
      for (const loc of Object.keys(a.damage.armor) as Location[]) a.damage.armor[loc] = 0;
      for (const loc of Object.keys(a.damage.armorRear) as Array<keyof typeof a.damage.armorRear>) {
        a.damage.armorRear[loc] = 0;
      }
      const def = mechDefFor(a);
      const hatchet = Number(
        Object.keys(def.weapons).find((k) => def.weapons[Number(k)]?.weapon === "Hatchet"),
      );
      const rng = seededRng(seed);
      const events: GameEvent[] = [];
      declareAttacks(
        battle,
        "t",
        [],
        [{ type: "punch", targetId: "a", limb: "rightArm" }],
        events,
        rng,
      );
      declareAttacks(
        battle,
        "a",
        [],
        [{ type: "strike", targetId: "t", limb: "rightArm", weapon: "Hatchet" }],
        events,
        rng,
      );
      resolveAllAttacks(battle, rng, events);
      const strike = events.find((e) => e.kind === "physicalAttackResolved" && e.unitId === "a");
      if (
        !isWeaponCritted(def, a.critSlotsDestroyed, hatchet) ||
        strike?.kind !== "physicalAttackResolved"
      )
        continue;
      seen++;
      expect(strike.resolution.missReason ?? "").not.toMatch(/^invalid:/);
    }
    expect(seen).toBeGreaterThan(0);
  });
});
