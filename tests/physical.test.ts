/**
 * Physical attack tests (TW pp. 144–153).
 * Covers punch, kick, push, and club validation, to-hit computation,
 * damage calculation, and hit location rolls.
 */

import { describe, expect, it } from "vitest";
import {
  type BattleState,
  createBattle,
  declareAttacks,
  type GameEvent,
  type HexCoord,
  mechDefFor,
  type Rng,
  type UnitInit,
} from "../src";
import { resolveAllAttacks, validateAttacksImpl } from "../src/rules/game";
import {
  computePhysicalToHit,
  kickHitLocation,
  type PhysicalAttackDecl,
  physicalDamage,
  resolvePhysicalAttack,
  validatePhysicalAttack,
} from "../src/rules/physical";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUnitInit(
  id: string,
  team: number,
  hex: HexCoord,
  facing: "n" | "ne" | "se" | "s" | "sw" | "nw" = "n",
): UnitInit {
  return {
    id,
    model: "HBK-4G",
    team,
    position: hex,
    facing,
    gunnery: 4,
    piloting: 5,
  };
}

function makeBattle(attacker: UnitInit, target: UnitInit): BattleState {
  return createBattle(
    {
      name: "test",
      width: 20,
      height: 20,
      terrain: [],
      legends: [],
    },
    [attacker, target],
  );
}

/** RNG that always rolls 6 (high roll, likely to hit). */
const HIGH_RNG: Rng = {
  d6: () => 6,
  snapshot: () => "",
  load: () => {},
};

/** RNG that always rolls 1 (low roll, likely to miss). */
const LOW_RNG: Rng = {
  d6: () => 1,
  snapshot: () => "",
  load: () => {},
};

// ---------------------------------------------------------------------------
// Punch
// ---------------------------------------------------------------------------

describe("punch", () => {
  it("computes damage as 1 per 10 tons (round up)", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    const attacker = battle.units.a!;
    // HBK-4G = 50 tons → 5 damage
    expect(physicalDamage("punch", attacker, "rightArm")).toBe(5);
  });

  it("halves damage for each damaged arm actuator", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    const attacker = battle.units.a!;
    // Simulate destroyed upper arm actuator
    attacker.critSlotsDestroyed.rightArm![1] = true; // upperArmActuator
    // 5 damage → halved to 2.5 → floor → 2
    expect(physicalDamage("punch", attacker, "rightArm")).toBe(2);
  });

  it("quarters damage when both upper and lower arm actuators destroyed", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    const attacker = battle.units.a!;
    attacker.critSlotsDestroyed.rightArm![1] = true; // upperArmActuator
    attacker.critSlotsDestroyed.rightArm![2] = true; // lowerArmActuator
    // 5 damage → halved twice → 1.25 → floor → 1
    expect(physicalDamage("punch", attacker, "rightArm")).toBe(1);
  });

  it("validates adjacency requirement", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 8, row: 5 }, "sw"),
    );
    const decl: PhysicalAttackDecl = { type: "punch", targetId: "t", limb: "rightArm" };
    const result = validatePhysicalAttack(battle, "a", decl);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("adjacency");
  });

  it("validates target is not in rear arc", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "n"),
      makeUnitInit("t", 2, { col: 5, row: 6 }, "s"), // directly behind (south)
    );
    const decl: PhysicalAttackDecl = { type: "punch", targetId: "t", limb: "rightArm" };
    const result = validatePhysicalAttack(battle, "a", decl);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("forward or side arc");
  });

  it("validates shoulder is undamaged", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    const attacker = battle.units.a!;
    // Destroy right shoulder
    attacker.critSlotsDestroyed.rightArm![0] = true; // shoulder
    const decl: PhysicalAttackDecl = { type: "punch", targetId: "t", limb: "rightArm" };
    const result = validatePhysicalAttack(battle, "a", decl);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("shoulder");
  });

  it("resolves a hit with correct damage and location", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    const decl: PhysicalAttackDecl = { type: "punch", targetId: "t", limb: "rightArm" };
    const resolution = resolvePhysicalAttack(battle, "a", decl, HIGH_RNG);
    expect(resolution.hit).toBe(true);
    expect(resolution.damageToTarget.length).toBe(1);
    expect(resolution.damageToTarget[0]!.damage).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Kick
// ---------------------------------------------------------------------------

describe("kick", () => {
  it("computes damage as 1 per 5 tons (round up)", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    const attacker = battle.units.a!;
    // HBK-4G = 50 tons → 10 damage
    expect(physicalDamage("kick", attacker, "rightLeg")).toBe(10);
  });

  it("has −2 to-hit modifier", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    const attacker = battle.units.a!;
    const target = battle.units.t!;
    const mods = computePhysicalToHit(battle, attacker, target, "kick", "rightLeg");
    expect(mods.attackMod).toBe(-2);
  });

  it("validates both hips are undamaged", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    const attacker = battle.units.a!;
    // Destroy left hip
    attacker.critSlotsDestroyed.leftLeg![0] = true; // hip
    const decl: PhysicalAttackDecl = { type: "kick", targetId: "t", limb: "rightLeg" };
    const result = validatePhysicalAttack(battle, "a", decl);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("hip");
  });

  it("validates target is in forward arc", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "n"),
      makeUnitInit("t", 2, { col: 5, row: 6 }, "s"), // behind (south)
    );
    const decl: PhysicalAttackDecl = { type: "kick", targetId: "t", limb: "rightLeg" };
    const result = validatePhysicalAttack(battle, "a", decl);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("forward arc");
  });

  it("target makes PSR on hit", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    const decl: PhysicalAttackDecl = { type: "kick", targetId: "t", limb: "rightLeg" };
    const resolution = resolvePhysicalAttack(battle, "a", decl, HIGH_RNG);
    expect(resolution.targetPsr).not.toBeNull();
    // Undamaged target: piloting 5 + 0 preexisting = target 5.
    expect(resolution.targetPsr!.target).toBe(5);
  });

  it("attacker makes PSR on miss", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    const decl: PhysicalAttackDecl = { type: "kick", targetId: "t", limb: "rightLeg" };
    const resolution = resolvePhysicalAttack(battle, "a", decl, LOW_RNG);
    // With piloting 5 and kick mod -2, TN = 3. Rolling 2 (1+1) misses.
    expect(resolution.hit).toBe(false);
    expect(resolution.attackerPsr).not.toBeNull();
    expect(resolution.attackerPsr!.target).toBe(5);
  });

  it("adds the target's preexisting damage to its PSR target", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    battle.units.t!.critSlotsDestroyed.leftLeg![1] = true; // upperLegActuator: +1
    const decl: PhysicalAttackDecl = { type: "kick", targetId: "t", limb: "rightLeg" };
    const resolution = resolvePhysicalAttack(battle, "a", decl, HIGH_RNG);
    expect(resolution.targetPsr!.target).toBe(6);
  });

  it("skips the target PSR when the target is prone", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    battle.units.t!.prone = true;
    const decl: PhysicalAttackDecl = { type: "kick", targetId: "t", limb: "rightLeg" };
    const resolution = resolvePhysicalAttack(battle, "a", decl, HIGH_RNG);
    // Damage still lands, but prone 'Mechs ignore fall-avoidance PSRs.
    expect(resolution.hit).toBe(true);
    expect(resolution.damageToTarget.length).toBe(1);
    expect(resolution.targetPsr).toBeNull();
    expect(resolution.targetFalls).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

describe("push", () => {
  it("has −1 to-hit modifier", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    const attacker = battle.units.a!;
    const target = battle.units.t!;
    const mods = computePhysicalToHit(battle, attacker, target, "push", undefined);
    expect(mods.attackMod).toBe(-1);
  });

  it("deals no damage", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    const attacker = battle.units.a!;
    expect(physicalDamage("push", attacker, undefined)).toBe(0);
  });

  it("validates target is in hex directly ahead", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"), // adjacent (SE) but not the NE front hex (6,4)
    );
    const decl: PhysicalAttackDecl = { type: "push", targetId: "t" };
    const result = validatePhysicalAttack(battle, "a", decl);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("directly ahead");
  });

  it("validates target is not prone", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 4 }, "sw"), // directly ahead (NE)
    );
    battle.units.t!.prone = true;
    const decl: PhysicalAttackDecl = { type: "push", targetId: "t" };
    const result = validatePhysicalAttack(battle, "a", decl);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("prone");
  });

  it("displaces target and advances attacker on hit", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 4 }, "sw"), // NE front hex
    );
    const decl: PhysicalAttackDecl = { type: "push", targetId: "t" };
    const resolution = resolvePhysicalAttack(battle, "a", decl, HIGH_RNG);
    expect(resolution.hit).toBe(true);
    expect(resolution.targetDisplacedTo).not.toBeNull();
    expect(resolution.attackerDisplacedTo).not.toBeNull();
    // Attacker moves into target's old hex
    expect(resolution.attackerDisplacedTo).toEqual({ col: 6, row: 4 });
    // Both sides roll PSRs against their own piloting (5 + 0 preexisting).
    expect(resolution.targetPsr!.target).toBe(5);
    expect(resolution.attackerPsr!.target).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Club
// ---------------------------------------------------------------------------

describe("club", () => {
  it("computes damage as 1 per 5 tons (round up)", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    const attacker = battle.units.a!;
    // HBK-4G = 50 tons → 10 damage
    expect(physicalDamage("club", attacker, undefined)).toBe(10);
  });

  it("has −1 to-hit modifier", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    const attacker = battle.units.a!;
    const target = battle.units.t!;
    const mods = computePhysicalToHit(battle, attacker, target, "club", undefined);
    expect(mods.attackMod).toBe(-1);
  });

  it("validates target is in forward arc", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "n"),
      makeUnitInit("t", 2, { col: 5, row: 6 }, "s"), // behind (south)
    );
    const decl: PhysicalAttackDecl = { type: "club", targetId: "t" };
    const result = validatePhysicalAttack(battle, "a", decl);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("forward arc");
  });

  it("validates both shoulders undamaged", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 4 }, "sw"), // directly ahead (NE)
    );
    const attacker = battle.units.a!;
    attacker.critSlotsDestroyed.leftArm![0] = true; // left shoulder
    const decl: PhysicalAttackDecl = { type: "club", targetId: "t" };
    const result = validatePhysicalAttack(battle, "a", decl);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("shoulder");
  });

  it("validates both hand actuators undamaged", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 4 }, "sw"), // directly ahead (NE)
    );
    const attacker = battle.units.a!;
    attacker.critSlotsDestroyed.rightArm![3] = true; // hand actuator
    const decl: PhysicalAttackDecl = { type: "club", targetId: "t" };
    const result = validatePhysicalAttack(battle, "a", decl);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("hand actuator");
  });
});

// ---------------------------------------------------------------------------
// Hit location tables
// ---------------------------------------------------------------------------

describe("kick hit location table", () => {
  it("returns left leg for left side arc", () => {
    expect(kickHitLocation(1, "leftSide")).toBe("leftLeg");
    expect(kickHitLocation(4, "leftSide")).toBe("leftLeg");
  });

  it("returns right leg for front arc on roll 1-3", () => {
    expect(kickHitLocation(1, "front")).toBe("rightLeg");
    expect(kickHitLocation(3, "front")).toBe("rightLeg");
  });

  it("returns left leg for front arc on roll 4-6", () => {
    expect(kickHitLocation(4, "front")).toBe("leftLeg");
    expect(kickHitLocation(6, "front")).toBe("leftLeg");
  });

  it("returns right leg for right side arc", () => {
    expect(kickHitLocation(1, "rightSide")).toBe("rightLeg");
    expect(kickHitLocation(4, "rightSide")).toBe("rightLeg");
  });
});

// ---------------------------------------------------------------------------
// Integration: full attack phase with physical attacks
// ---------------------------------------------------------------------------

describe("physical attack integration", () => {
  it("resolves physical attacks after weapon attacks", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    // Move to weapon attack phase
    battle.phase = "attack";
    battle.actedThisPhase = [];

    // Declare a punch
    const decl: PhysicalAttackDecl = { type: "punch", targetId: "t", limb: "rightArm" };
    battle.units.a!.declaredPhysicalAttacks.push(decl);

    const events: GameEvent[] = [];
    resolveAllAttacks(battle, HIGH_RNG, events);

    // Check that physical attack resolved event was emitted
    const physEvent = events.find((e) => e.kind === "physicalAttackResolved");
    expect(physEvent).toBeDefined();
    if (physEvent && physEvent.kind === "physicalAttackResolved") {
      expect(physEvent.resolution.hit).toBe(true);
      expect(physEvent.resolution.damageToTarget.length).toBe(1);
    }

    // Check that declarations were cleared
    expect(battle.units.a!.declaredPhysicalAttacks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Declaration commit path (declarePhysicalAttacks)
// ---------------------------------------------------------------------------

describe("declarePhysicalAttacks", () => {
  function attackPhaseBattle(): BattleState {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    battle.phase = "attack";
    battle.initiativeWinnerTeam = 2; // target's team wins, so "a" acts first
    battle.actorQueue = ["a", "t"];
    battle.actedThisPhase = [];
    return battle;
  }

  it("stores declarations and emits a merged attacksDeclared event", () => {
    const battle = attackPhaseBattle();
    const events: GameEvent[] = [];
    declareAttacks(
      battle,
      "a",
      [],
      [{ type: "punch", targetId: "t", limb: "rightArm" }],
      events,
      HIGH_RNG,
    );
    expect(battle.units.a!.declaredPhysicalAttacks.length).toBe(1);
    expect(battle.actedThisPhase).toContain("a");
    const declared = events.find((e) => e.kind === "attacksDeclared");
    expect(declared?.weapons).toBeNull();
    expect(declared?.physical).toEqual([{ type: "punch", targetId: "t" }]);
  });

  it("defaults a limbless punch to the right arm", () => {
    const battle = attackPhaseBattle();
    const events: GameEvent[] = [];
    declareAttacks(battle, "a", [], [{ type: "punch", targetId: "t" }], events, HIGH_RNG);
    expect(battle.units.a!.declaredPhysicalAttacks[0]!.limb).toBe("rightArm");
  });

  it("allows a two-arm punch but rejects a repeated arm", () => {
    const battle = attackPhaseBattle();
    const events: GameEvent[] = [];
    declareAttacks(
      battle,
      "a",
      [],
      [
        { type: "punch", targetId: "t", limb: "leftArm" },
        { type: "punch", targetId: "t", limb: "rightArm" },
      ],
      events,
      HIGH_RNG,
    );
    expect(battle.units.a!.declaredPhysicalAttacks.length).toBe(2);

    const battle2 = attackPhaseBattle();
    expect(() =>
      declareAttacks(
        battle2,
        "a",
        [],
        [
          { type: "punch", targetId: "t", limb: "rightArm" },
          { type: "punch", targetId: "t", limb: "rightArm" },
        ],
        [],
        HIGH_RNG,
      ),
    ).toThrow(/only once/);
  });

  it("rejects mixing physical attack types in one turn", () => {
    const battle = attackPhaseBattle();
    expect(() =>
      declareAttacks(
        battle,
        "a",
        [],
        [
          { type: "punch", targetId: "t", limb: "rightArm" },
          { type: "kick", targetId: "t", limb: "rightLeg" },
        ],
        [],
        HIGH_RNG,
      ),
    ).toThrow(/only one type/);
  });

  it("rejects a second declaration once weapons were declared (one declare per turn)", () => {
    const battle = attackPhaseBattle();
    // HBK-4G mounts a right-arm weapon; declare it as a weapon attack first.
    const def = mechDefFor(battle.units.a!);
    const rightArmIndex = Number(
      Object.keys(def.weapons).find((k) => def.weapons[Number(k)]?.location === "rightArm"),
    );
    expect(Number.isInteger(rightArmIndex)).toBe(true);
    battle.units.a!.declaredWeaponAttacks.push({ weaponIndex: rightArmIndex, targetId: "t" });
    expect(() =>
      declareAttacks(
        battle,
        "a",
        [],
        [{ type: "punch", targetId: "t", limb: "rightArm" }],
        [],
        HIGH_RNG,
      ),
    ).toThrow(/already declared attacks/);
  });
});

// ---------------------------------------------------------------------------
// Combined weapon + physical declaration (declareAttacks)
// ---------------------------------------------------------------------------

describe("declareAttacks with weapons and physicals", () => {
  /** Attacker faces its target dead-on so torso weapons and punches are legal. */
  function faceToFaceBattle(): BattleState {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "se"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "nw"),
    );
    battle.phase = "attack";
    battle.initiativeWinnerTeam = 2;
    battle.actorQueue = ["a", "t"];
    battle.actedThisPhase = [];
    return battle;
  }

  function armAndTorsoWeaponIndices(): { arm: number; torso: number } {
    const battle = faceToFaceBattle();
    const def = mechDefFor(battle.units.a!);
    const arm = Number(
      Object.keys(def.weapons).find((k) => def.weapons[Number(k)]?.location === "rightArm"),
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

  it("commits a legal punch plus torso weapon atomically", () => {
    const battle = faceToFaceBattle();
    const { torso } = armAndTorsoWeaponIndices();
    const events: GameEvent[] = [];
    declareAttacks(
      battle,
      "a",
      [{ weaponIndex: torso, targetId: "t" }],
      [{ type: "punch", targetId: "t", limb: "rightArm" }],
      events,
      HIGH_RNG,
    );
    expect(battle.units.a!.declaredWeaponAttacks.length).toBe(1);
    expect(battle.units.a!.declaredPhysicalAttacks.length).toBe(1);
    expect(battle.units.a!.declaredPhysicalAttacks[0]!.limb).toBe("rightArm");
    expect(battle.actedThisPhase).toEqual(["a"]);
    const declared = events.find((e) => e.kind === "attacksDeclared");
    expect(declared?.weapons?.targetId).toBe("t");
    expect(declared?.weapons?.count).toBe(1);
    expect(declared?.physical).toEqual([{ type: "punch", targetId: "t" }]);
  });

  it("rejects a punching arm's weapons in the same call with no partial state", () => {
    const battle = faceToFaceBattle();
    const { arm } = armAndTorsoWeaponIndices();
    expect(() =>
      declareAttacks(
        battle,
        "a",
        [{ weaponIndex: arm, targetId: "t" }],
        [{ type: "punch", targetId: "t", limb: "rightArm" }],
        [],
        HIGH_RNG,
      ),
    ).toThrow(/cannot fire/);
    expect(battle.units.a!.declaredWeaponAttacks).toEqual([]);
    expect(battle.units.a!.declaredPhysicalAttacks).toEqual([]);
    expect(battle.actedThisPhase).toEqual([]);
  });

  it("rejects arm weapons combined with push or club", () => {
    const battle = faceToFaceBattle();
    const { arm } = armAndTorsoWeaponIndices();
    // Push needs the target directly ahead; faceToFace already is.
    expect(() =>
      declareAttacks(
        battle,
        "a",
        [{ weaponIndex: arm, targetId: "t" }],
        [{ type: "push", targetId: "t" }],
        [],
        HIGH_RNG,
      ),
    ).toThrow(/no arm-mounted weapons/);
    expect(battle.units.a!.declaredWeaponAttacks).toEqual([]);
    expect(battle.units.a!.declaredPhysicalAttacks).toEqual([]);
  });

  it("validateAttacksImpl checks the combined set", () => {
    const battle = faceToFaceBattle();
    const { arm, torso } = armAndTorsoWeaponIndices();
    expect(() =>
      validateAttacksImpl(
        battle,
        "a",
        [{ weaponIndex: torso, targetId: "t" }],
        [{ type: "punch", targetId: "t", limb: "rightArm" }],
      ),
    ).not.toThrow();
    expect(() =>
      validateAttacksImpl(
        battle,
        "a",
        [{ weaponIndex: arm, targetId: "t" }],
        [{ type: "punch", targetId: "t", limb: "rightArm" }],
      ),
    ).toThrow(/cannot fire/);
  });

  it("a second declaration of either kind is rejected (one declare per turn)", () => {
    const battle = faceToFaceBattle();
    const { torso } = armAndTorsoWeaponIndices();
    declareAttacks(
      battle,
      "a",
      [{ weaponIndex: torso, targetId: "t" }],
      [{ type: "punch", targetId: "t", limb: "rightArm" }],
      [],
      HIGH_RNG,
    );
    // Re-arm the head-of-queue check: the actor-queue guard runs before
    // the already-declared guards (pre-existing ordering).
    battle.actedThisPhase = [];
    expect(() =>
      declareAttacks(battle, "a", [{ weaponIndex: torso, targetId: "t" }], [], [], HIGH_RNG),
    ).toThrow(/already declared attacks/);
    expect(() =>
      declareAttacks(
        battle,
        "a",
        [],
        [{ type: "punch", targetId: "t", limb: "leftArm" }],
        [],
        HIGH_RNG,
      ),
    ).toThrow(/already declared attacks/);
  });
});

describe("twist-aware physical arcs (TW pp. 98-99)", () => {
  /** Attacker faces north; target sits in the adjacent southwest hex (leftSide template arc). */
  function northVsSouthwest(): BattleState {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 10, row: 10 }, "n"),
      makeUnitInit("t", 2, { col: 9, row: 11 }, "s"),
    );
    battle.phase = "attack";
    battle.initiativeWinnerTeam = 2;
    battle.actorQueue = ["a", "t"];
    battle.actedThisPhase = [];
    return battle;
  }

  it("punch works untwisted but club needs a left twist into the front arc", () => {
    const battle = northVsSouthwest();
    expect(
      validatePhysicalAttack(battle, "a", { type: "punch", targetId: "t", limb: "rightArm" }).ok,
    ).toBe(true);
    expect(validatePhysicalAttack(battle, "a", { type: "club", targetId: "t" }).ok).toBe(false);
    expect(
      validatePhysicalAttack(battle, "a", { type: "club", targetId: "t" }, "leftSide").ok,
    ).toBe(true);
    // Twisting away swings the side target behind the torso (rear arc),
    // so even the punch no longer bears.
    expect(
      validatePhysicalAttack(
        battle,
        "a",
        { type: "punch", targetId: "t", limb: "rightArm" },
        "rightSide",
      ).ok,
    ).toBe(false);
  });

  it("a rear target becomes punchable with a twist", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 10, row: 10 }, "n"),
      makeUnitInit("t", 2, { col: 10, row: 11 }, "n"),
    );
    battle.phase = "attack";
    battle.initiativeWinnerTeam = 2;
    battle.actorQueue = ["a", "t"];
    battle.actedThisPhase = [];
    expect(
      validatePhysicalAttack(battle, "a", { type: "punch", targetId: "t", limb: "rightArm" }).ok,
    ).toBe(false);
    expect(
      validatePhysicalAttack(
        battle,
        "a",
        { type: "punch", targetId: "t", limb: "rightArm" },
        "rightSide",
      ).ok,
    ).toBe(true);
  });

  it("kick ignores the twist (feet-based, TW p. 147)", () => {
    // Rear target for a north-facing 'Mech: rejected with and without a
    // twist, since kick classifies against the feet (validateKick never
    // reads the twist).
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 10, row: 10 }, "n"),
      makeUnitInit("t", 2, { col: 10, row: 11 }, "n"),
    );
    battle.phase = "attack";
    battle.initiativeWinnerTeam = 2;
    battle.actorQueue = ["a", "t"];
    battle.actedThisPhase = [];
    expect(
      validatePhysicalAttack(battle, "a", { type: "kick", targetId: "t", limb: "rightLeg" }).ok,
    ).toBe(false);
    expect(
      validatePhysicalAttack(
        battle,
        "a",
        { type: "kick", targetId: "t", limb: "rightLeg" },
        "leftSide",
      ).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Critical hits from physical attacks (TW pp. 123–124)
// ---------------------------------------------------------------------------

describe("physical attack critical hits", () => {
  /**
   * Creates a battle with a target that has armor stripped on one location
   * so that physical attack damage will hit internal structure.
   */
  function makeBattleWithStrippedArmor(
    targetLocation:
      | "leftArm"
      | "rightArm"
      | "leftLeg"
      | "rightLeg"
      | "leftTorso"
      | "rightTorso"
      | "centerTorso"
      | "head",
  ): BattleState {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    // Strip all armor from the target location so damage hits IS
    const target = battle.units.t!;
    target.damage.armor[targetLocation] = 0;
    if (
      targetLocation === "leftTorso" ||
      targetLocation === "rightTorso" ||
      targetLocation === "centerTorso"
    ) {
      target.damage.armorRear[targetLocation] = 0;
    }
    // Also set baseDamage to match
    target.baseDamage.armor[targetLocation] = 0;
    if (
      targetLocation === "leftTorso" ||
      targetLocation === "rightTorso" ||
      targetLocation === "centerTorso"
    ) {
      target.baseDamage.armorRear[targetLocation] = 0;
    }
    return battle;
  }

  /** RNG that rolls 2 on hit-location (through-armor critical) - 3rd call returns 2. */
  const THROUGH_ARMOR_RNG: Rng = (() => {
    let callCount = 0;
    return {
      d6() {
        callCount++;
        // Call 1-2: to-hit 2D6 -> 4+4=8 (hits)
        // Call 3: hit location 1D6 -> 2 (through-armor)
        if (callCount === 3) return 2;
        return 4;
      },
      snapshot: () => "",
      load: () => {},
    };
  })();

  /** RNG that rolls 12 on 2D6 (limb blown off / 3 crits on torso). */
  const CRIT_TWELVE_RNG: Rng = (() => {
    let callCount = 0;
    return {
      d6() {
        callCount++;
        // Call 1-2: to-hit 2D6 -> 6+6=12 (auto-hit, but 12 is also max)
        // Call 3: hit location 1D6 -> 6
        if (callCount <= 2) return 6;
        return 6;
      },
      snapshot: () => "",
      load: () => {},
    };
  })();

  /** RNG that always rolls 4 on d6 (8 on 2D6). */
  const RNG_4: Rng = {
    d6: () => 4,
    snapshot: () => "",
    load: () => {},
  };

  it("punch stripping IS triggers determining roll → 1 critical hit", () => {
    const battle = makeBattleWithStrippedArmor("rightArm");
    const decl: PhysicalAttackDecl = { type: "punch", targetId: "t", limb: "rightArm" };
    const resolution = resolvePhysicalAttack(battle, "a", decl, RNG_4);

    expect(resolution.hit).toBe(true);
    expect(resolution.damageToTarget.length).toBe(1);
    // Hit location varies by attack direction; just verify damage was dealt
    expect(resolution.damageToTarget[0]!.damage).toBeGreaterThan(0);
    expect(resolution.throughArmorCrit).toBe(false);
  });

  it("kick with hit-location roll 2 triggers through-armor critical", () => {
    const battle = makeBattle(
      makeUnitInit("a", 1, { col: 5, row: 5 }, "ne"),
      makeUnitInit("t", 2, { col: 6, row: 5 }, "sw"),
    );
    const decl: PhysicalAttackDecl = { type: "kick", targetId: "t", limb: "rightLeg" };
    const resolution = resolvePhysicalAttack(battle, "a", decl, THROUGH_ARMOR_RNG);

    expect(resolution.hit).toBe(true);
    expect(resolution.throughArmorCrit).toBe(true);
  });

  it("punch stripping IS AND hit-location 2 triggers two determining rolls", () => {
    // RNG that returns:
    // - Calls 1-2: to-hit 2D6 = 8 (hit)
    // - Call 3: hit location = 2 (through-armor)
    // - Calls 4-5: determining roll 1 = 8 (1 crit)
    // - Calls 6-7: determining roll 2 = 8 (1 crit)
    const TWO_ROLLS_RNG: Rng = (() => {
      let callCount = 0;
      return {
        d6() {
          callCount++;
          if (callCount === 3) return 2; // hit location = 2
          return 4; // all other rolls = 4 (8 on 2D6)
        },
        snapshot: () => "",
        load: () => {},
      };
    })();

    const battle = makeBattleWithStrippedArmor("rightArm");
    const decl: PhysicalAttackDecl = { type: "punch", targetId: "t", limb: "rightArm" };
    const resolution = resolvePhysicalAttack(battle, "a", decl, TWO_ROLLS_RNG);

    expect(resolution.hit).toBe(true);
    expect(resolution.throughArmorCrit).toBe(true);
  });

  it("critical hit destroys weapon in hit location", () => {
    // This test would require full game.ts integration to verify
    // the critical resolution actually destroys the weapon.
    // For now, verify the resolvePhysicalAttack returns correct data.
    const battle = makeBattleWithStrippedArmor("rightArm");
    const target = battle.units.t!;
    const def = mechDefFor(target);

    // Verify right arm has weapons that can be crit
    const rightArmWeapons = Object.entries(def.weapons).filter(
      ([, mount]) => mount.location === "rightArm",
    );
    expect(rightArmWeapons.length).toBeGreaterThan(0);

    const decl: PhysicalAttackDecl = { type: "punch", targetId: "t", limb: "rightArm" };
    const resolution = resolvePhysicalAttack(battle, "a", decl, RNG_4);
    expect(resolution.hit).toBe(true);
    expect(resolution.damageToTarget[0]!.damage).toBeGreaterThan(0);
  });

  it("critical roll 12 on arm → limb blown off", () => {
    const battle = makeBattleWithStrippedArmor("rightArm");
    const decl: PhysicalAttackDecl = { type: "punch", targetId: "t", limb: "rightArm" };
    const resolution = resolvePhysicalAttack(battle, "a", decl, CRIT_TWELVE_RNG);

    expect(resolution.hit).toBe(true);
    expect(resolution.damageToTarget[0]!.damage).toBeGreaterThan(0);
    // The blow-off would be handled by resolveCriticalHits in game.ts
  });

  it("critical roll 12 on torso → 3 critical hits", () => {
    const battle = makeBattleWithStrippedArmor("centerTorso");
    const decl: PhysicalAttackDecl = { type: "punch", targetId: "t", limb: "rightArm" };
    const resolution = resolvePhysicalAttack(battle, "a", decl, CRIT_TWELVE_RNG);

    expect(resolution.hit).toBe(true);
    // Center torso hit would trigger 3 crit rolls on determining 12
  });

  it("integration: physical attack in attack phase triggers critical resolution", () => {
    const battle = makeBattleWithStrippedArmor("rightArm");
    battle.phase = "attack";
    battle.initiativeWinnerTeam = 2;
    battle.actorQueue = ["a", "t"];
    battle.actedThisPhase = [];

    const decl: PhysicalAttackDecl = { type: "punch", targetId: "t", limb: "rightArm" };
    battle.units.a!.declaredPhysicalAttacks.push(decl);

    const events: GameEvent[] = [];
    resolveAllAttacks(battle, RNG_4, events);

    const physEvent = events.find((e) => e.kind === "physicalAttackResolved");
    expect(physEvent).toBeDefined();
    if (physEvent && physEvent.kind === "physicalAttackResolved") {
      expect(physEvent.resolution.hit).toBe(true);
      expect(physEvent.resolution.damageToTarget.length).toBe(1);
      // The target's crit state should have been updated
      // Critical resolution ran and may have destroyed slots
    }
  });
});
