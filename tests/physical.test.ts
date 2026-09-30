/**
 * Physical attack tests (TW pp. 144–153).
 * Covers punch, kick, push, and club validation, to-hit computation,
 * damage calculation, and hit location rolls.
 */

import {
  type BattleState,
  computePhysicalToHit,
  createBattle,
  declarePhysicalAttacks,
  type GameEvent,
  type HexCoord,
  kickHitLocation,
  mechDefFor,
  type PhysicalAttackDecl,
  physicalDamage,
  type Rng,
  resolveAllAttacks,
  resolvePhysicalAttack,
  type UnitInit,
  validatePhysicalAttack,
} from "btlib10x";
import { describe, expect, it } from "vitest";

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
    { critsDisabled: true },
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
    battle.phase = "weaponAttack";
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
    battle.phase = "weaponAttack";
    battle.initiativeWinnerTeam = 2; // target's team wins, so "a" acts first
    battle.actorQueue = ["a", "t"];
    battle.actedThisPhase = [];
    return battle;
  }

  it("stores declarations and emits physicalAttacksDeclared", () => {
    const battle = attackPhaseBattle();
    const events: GameEvent[] = [];
    declarePhysicalAttacks(
      battle,
      "a",
      [{ type: "punch", targetId: "t", limb: "rightArm" }],
      events,
      HIGH_RNG,
    );
    expect(battle.units.a!.declaredPhysicalAttacks.length).toBe(1);
    expect(battle.actedThisPhase).toContain("a");
    const declared = events.find((e) => e.kind === "physicalAttacksDeclared");
    expect(declared).toBeDefined();
  });

  it("defaults a limbless punch to the right arm", () => {
    const battle = attackPhaseBattle();
    const events: GameEvent[] = [];
    declarePhysicalAttacks(battle, "a", [{ type: "punch", targetId: "t" }], events, HIGH_RNG);
    expect(battle.units.a!.declaredPhysicalAttacks[0]!.limb).toBe("rightArm");
  });

  it("allows a two-arm punch but rejects a repeated arm", () => {
    const battle = attackPhaseBattle();
    const events: GameEvent[] = [];
    declarePhysicalAttacks(
      battle,
      "a",
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
      declarePhysicalAttacks(
        battle2,
        "a",
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
      declarePhysicalAttacks(
        battle,
        "a",
        [
          { type: "punch", targetId: "t", limb: "rightArm" },
          { type: "kick", targetId: "t", limb: "rightLeg" },
        ],
        [],
        HIGH_RNG,
      ),
    ).toThrow(/only one type/);
  });

  it("rejects a punch when the punching arm's weapons already fired", () => {
    const battle = attackPhaseBattle();
    // HBK-4G mounts a right-arm weapon; declare it as a weapon attack first.
    const def = mechDefFor(battle.units.a!);
    const rightArmIndex = Number(
      Object.keys(def.weapons).find((k) => def.weapons[Number(k)]?.location === "rightArm"),
    );
    expect(Number.isInteger(rightArmIndex)).toBe(true);
    battle.units.a!.declaredWeaponAttacks.push({ weaponIndex: rightArmIndex, targetId: "t" });
    expect(() =>
      declarePhysicalAttacks(
        battle,
        "a",
        [{ type: "punch", targetId: "t", limb: "rightArm" }],
        [],
        HIGH_RNG,
      ),
    ).toThrow(/cannot fire/);
  });
});
