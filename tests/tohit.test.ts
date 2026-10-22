import { describe, expect, it } from "vitest";
import type { Location } from "../src/core/types";
import { mechDef } from "../src/data/index";
import type { ResolvedMechDef } from "../src/data/mech.schema";
import { weaponDefFor } from "../src/data/weapon.schema";
import { armWeaponToHitModifier, countArmActuators } from "../src/rules/actuators";
import { secondaryTargetModifier } from "../src/rules/arcs";
import { resolveWeaponAttack } from "../src/rules/attack";
import { type CritMask, emptyCritTable, setSlotDestroyed } from "../src/rules/critical";
import type { UnitDamageState } from "../src/rules/damage";
import { suggestFireTargets } from "../src/rules/fireability";
import {
  advancePhase,
  type BattleState,
  buildUnitInit,
  declareAttacks,
  type GameEvent,
  requireUnit,
  resolveAllAttacks,
  rollInitiativePhase,
  validateAttacksImpl,
  type WeaponAttackDecl,
} from "../src/rules/game";
import { computeToHit, toHitTotal, weaponToHitModifier } from "../src/rules/tohit";
import { createTestBattle, scriptedRng, seededRng } from "./helpers";

describe("GATOR to-hit calculation", () => {
  // Total Warfare, Rolling To Hit diagram (p.106):
  // Wolverine (ran) fires medium laser at Griffin 4 hexes away,
  // light woods intervening; target moved 2 hexes.
  it("matches rulebook example: Wolverine medium laser TN 9", () => {
    const bd = computeToHit({
      gunnery: 4,
      attackerMovement: "run",
      targetHexesMoved: 2,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 1,
      distance: 4,
      weapon: weaponDefFor({ weapon: "Medium Laser" }),
    });
    expect(toHitTotal(bd)).toBe(9);
    expect(bd.rangeBracket).toBe("medium");
  });

  // Same diagram: Griffin (walked, gunnery 3) fires PPC back at Wolverine
  // 4 hexes away (short for PPC); light woods between AND target in light woods.
  it("matches rulebook example: Griffin PPC TN 8", () => {
    const bd = computeToHit({
      gunnery: 3,
      attackerMovement: "walk",
      targetHexesMoved: 5,
      targetJumped: false,
      targetTerrain: "lightWoods",
      interveningWoods: 1,
      distance: 4,
      weapon: weaponDefFor({ weapon: "PPC" }),
    });
    expect(toHitTotal(bd)).toBe(8);
    expect(bd.rangeBracket).toBe("short");
  });

  // Total Warfare Target Movement diagram (p.107): Cicada fires ML at stationary
  // Enforcer 4 hexes away -> 7. Hunchback AC/20 at Cicada (5 hexes moved),
  // ran, range 2 short -> 8. Enforcer large laser at Hunchback (2 hexes moved),
  // standing still, short range -> 4.
  it("matches the three worked examples on p.107", () => {
    const ml = computeToHit({
      gunnery: 4,
      attackerMovement: "walk",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 4,
      weapon: weaponDefFor({ weapon: "Medium Laser" }),
    });
    expect(toHitTotal(ml)).toBe(7);

    const ac20 = computeToHit({
      gunnery: 4,
      attackerMovement: "run",
      targetHexesMoved: 5,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 2,
      weapon: weaponDefFor({ weapon: "AC/20" }),
    });
    expect(toHitTotal(ac20)).toBe(8);

    const ll = computeToHit({
      gunnery: 4,
      attackerMovement: "standStill",
      targetHexesMoved: 2,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 4,
      weapon: weaponDefFor({ weapon: "Large Laser" }),
    });
    expect(toHitTotal(ll)).toBe(4);
  });

  it("applies target movement bands and jump bonus", () => {
    const mk = (moved: number, jumped = false) =>
      toHitTotal(
        computeToHit({
          gunnery: 4,
          attackerMovement: "standStill",
          targetHexesMoved: moved,
          targetJumped: jumped,
          targetTerrain: "clear",
          interveningWoods: 0,
          distance: 1,
          weapon: weaponDefFor({ weapon: "Small Laser" }),
        }),
      );
    expect(mk(2)).toBe(4);
    expect(mk(3)).toBe(5);
    expect(mk(6)).toBe(6);
    expect(mk(9)).toBe(7);
    expect(mk(17)).toBe(8);
    expect(mk(24)).toBe(9);
    expect(mk(25)).toBe(10);
    expect(mk(3, true)).toBe(6);
  });

  it("prone target: -2 adjacent, +1 at range, -4 when immobile", () => {
    const base = {
      gunnery: 4,
      attackerMovement: "standStill" as const,
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear" as const,
      interveningWoods: 0,
      weapon: weaponDefFor({ weapon: "Small Laser" }),
    };
    const adjacent = computeToHit({ ...base, distance: 1, targetProne: true });
    expect(adjacent.targetMod).toBe(-2);
    const distant = computeToHit({ ...base, distance: 3, targetProne: true });
    expect(distant.targetMod).toBe(1);
    expect(distant.targetMod - adjacent.targetMod).toBe(3);
    const immobileProne = computeToHit({
      ...base,
      distance: 3,
      targetProne: true,
      targetImmobile: true,
    });
    // Target modifiers are cumulative (Attack Modifiers Table, TW p.117):
    // -4 immobile + 1 prone-at-range.
    expect(immobileProne.targetMod).toBe(-3);
  });

  it("immobile target (shut down / legs destroyed) gets a flat -4 target modifier", () => {
    const base = {
      gunnery: 4,
      attackerMovement: "run" as const,
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear" as const,
      interveningWoods: 0,
      distance: 4,
      weapon: weaponDefFor({ weapon: "Medium Laser" }),
    };
    const online = computeToHit(base);
    const immobile = computeToHit({ ...base, targetImmobile: true });
    expect(immobile.targetMod).toBe(-4);
    expect(toHitTotal(immobile)).toBe(toHitTotal(online) - 4);
  });

  it("partial-cover target adds +1 cover modifier, separate from terrain", () => {
    const base = {
      gunnery: 4,
      attackerMovement: "standStill" as const,
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "water1" as const,
      interveningWoods: 0,
      distance: 1,
      weapon: weaponDefFor({ weapon: "Small Laser" }),
    };
    const plain = computeToHit(base);
    expect(plain.terrainMod).toBe(0);
    expect(plain.coverMod).toBe(0);
    const covered = computeToHit({ ...base, partialCoverMod: 1 });
    expect(covered.terrainMod).toBe(0);
    expect(covered.coverMod).toBe(1);
    expect(toHitTotal(covered)).toBe(toHitTotal(plain) + 1);
  });

  it("woods and cover stack as separate terms", () => {
    const base = {
      gunnery: 4,
      attackerMovement: "standStill" as const,
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "lightWoods" as const,
      interveningWoods: 1,
      distance: 1,
      weapon: weaponDefFor({ weapon: "Small Laser" }),
    };
    const bd = computeToHit({ ...base, partialCoverMod: 1 });
    expect(bd.terrainMod).toBe(2);
    expect(bd.coverMod).toBe(1);
    expect(toHitTotal(bd)).toBe(4 + 2 + 1);
  });

  it("flags auto-hit <= 2 and auto-miss > 12", () => {
    const easy = computeToHit({
      gunnery: 0,
      attackerMovement: "standStill",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 1,
      weapon: weaponDefFor({ weapon: "Small Laser" }),
    });
    expect(easy.automatic).toBe("hit");
    expect(easy.weaponMod).toBe(0);

    const pulse = computeToHit({
      gunnery: 4,
      attackerMovement: "standStill",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 1,
      weapon: weaponDefFor({ weapon: "Small Pulse Laser" }),
    });
    expect(pulse.weaponMod).toBe(-2);

    const hard = computeToHit({
      gunnery: 7,
      attackerMovement: "jump",
      targetHexesMoved: 25,
      targetJumped: false,
      targetTerrain: "heavyWoods",
      interveningWoods: 2,
      distance: 15,
      weapon: weaponDefFor({ weapon: "Large Laser" }),
    });
    expect(hard.automatic).toBe("miss");
  });

  it("marks out-of-range shots as automatic misses", () => {
    const bd = computeToHit({
      gunnery: 4,
      attackerMovement: "standStill",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 10,
      weapon: weaponDefFor({ weapon: "Medium Laser" }),
    });
    expect(bd.outOfRange).toBe(true);
    expect(bd.automatic).toBe("miss");
  });

  it("applies the closer-than-minimum-range penalty", () => {
    const gauss = weaponDefFor({ weapon: "CL Gauss Rifle" });
    expect(gauss.minRange).toBe(2);

    const at = (distance: number) =>
      computeToHit({
        gunnery: 4,
        attackerMovement: "standStill",
        targetHexesMoved: 0,
        targetJumped: false,
        targetTerrain: "clear",
        interveningWoods: 0,
        distance,
        weapon: gauss,
      });

    expect(at(1).minRangeMod).toBe(2);
    expect(toHitTotal(at(1))).toBe(6); // gunnery 4 + min (2-1+1) 2
    expect(at(2).minRangeMod).toBe(1);
    expect(toHitTotal(at(2))).toBe(5); // gunnery 4 + min (2-2+1) 1
    expect(at(3).minRangeMod).toBe(0);
    expect(toHitTotal(at(3))).toBe(4); // within short range, no penalty
  });

  it("applies the weapon To-Hit Mod column (TW p.303-304)", () => {
    const base = {
      gunnery: 4,
      attackerMovement: "standStill" as const,
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear" as const,
      interveningWoods: 0,
      distance: 3,
    };
    // MRM +1, Clan heavy lasers +1, pulse -2, everything else 0.
    expect(computeToHit({ ...base, weapon: weaponDefFor({ weapon: "MRM 20" }) }).weaponMod).toBe(1);
    expect(
      computeToHit({ ...base, weapon: weaponDefFor({ weapon: "CL Heavy Medium Laser" }) })
        .weaponMod,
    ).toBe(1);
    expect(
      computeToHit({ ...base, weapon: weaponDefFor({ weapon: "Medium Pulse Laser" }) }).weaponMod,
    ).toBe(-2);
    expect(
      computeToHit({ ...base, weapon: weaponDefFor({ weapon: "Medium Laser" }) }).weaponMod,
    ).toBe(0);
    // The +1 lands in the total: same TN as a 0-mod weapon, plus one.
    const mrm = computeToHit({ ...base, weapon: weaponDefFor({ weapon: "MRM 10" }) });
    const ml = computeToHit({ ...base, weapon: weaponDefFor({ weapon: "Medium Laser" }) });
    expect(ml.rangeBracket).toBe(mrm.rangeBracket);
    expect(toHitTotal(mrm)).toBe(toHitTotal(ml) + 1);
  });

  it("falls back to -2 for legacy pulse-only defs without toHitMod", () => {
    expect(
      weaponToHitModifier({
        name: "x",
        short: 1,
        medium: 2,
        long: 3,
        pulse: true,
        category: "ENERGY",
      }),
    ).toBe(-2);
    expect(
      weaponToHitModifier({ name: "x", short: 1, medium: 2, long: 3, category: "ENERGY" }),
    ).toBe(0);
  });

  it("resolves variable damage per bracket (Snub-Nose PPC V10/8/5)", () => {
    const snub = weaponDefFor({ weapon: "Snub-Nose PPC" });
    const short = computeToHit({
      gunnery: 4,
      attackerMovement: "standStill",
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear",
      interveningWoods: 0,
      distance: 9,
      weapon: snub,
    });
    expect(short.rangeBracket).toBe("short");
  });
});

describe("validateAttacks", () => {
  /** initiative -> weaponAttack with nobody moving. hbk acts first (team 1). */
  function startAttackTurn(state: BattleState): BattleState {
    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
    advancePhase(state, [], scriptedRng()); // initiative -> movement
    advancePhase(state, [], scriptedRng()); // movement -> weaponAttack
    return state;
  }

  function hbkVsEnf(): BattleState {
    const state = createTestBattle(
      [],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "n"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 4 }, "sw"),
      ],
      true,
    );
    return startAttackTurn(state);
  }

  function snapshotUnit(state: BattleState, id: string) {
    const u = state.units[id]!;
    return {
      declaredAttacks: u.declaredWeaponAttacks,
      ammoBins: u.ammoBins,
      actedThisPhase: state.actedThisPhase,
      heat: u.heat,
    };
  }

  describe("validateAttacks — gate coverage", () => {
    it("accepts a legal volley and returns the resolved metadata", () => {
      const state = hbkVsEnf();
      const before = snapshotUnit(state, "hbk");
      const r = validateAttacksImpl(state, "hbk", [{ weaponIndex: 2, targetId: "enf" }], [], {})!;
      expect(r.primaryTargetId).toBe("enf");
      expect(r.targets).toHaveLength(1);
      const t = r.targets[0]!;
      expect(t.targetId).toBe("enf");
      expect(typeof t.attackDirection).toBe("string");
      expect(t.distance).toBe(1);
      expect(["short", "medium", "long"]).toContain(t.rangeBracket);
      expect(t.rangeMod).toBe(0);
      expect(t.secondaryMod).toBe(0);
      expect(r.arcs[2]).toBeDefined();
      // No-mutation contract: declareAttacks side effects absent.
      expect(snapshotUnit(state, "hbk")).toEqual(before);
    });

    it("throws on weaponIndex out of range", () => {
      const state = hbkVsEnf();
      expect(() =>
        validateAttacksImpl(state, "hbk", [{ weaponIndex: 99, targetId: "enf" }], [], {}),
      ).toThrow(/weaponIndex 99 out of range/);
    });

    it("throws on duplicate weaponIndex", () => {
      const state = hbkVsEnf();
      expect(() =>
        validateAttacksImpl(
          state,
          "hbk",
          [
            { weaponIndex: 2, targetId: "enf" },
            { weaponIndex: 2, targetId: "enf" },
          ],
          [],
          {},
        ),
      ).toThrow(/may only be declared once per turn/);
    });

    it("throws on friendly target", () => {
      const state = createTestBattle(
        [],
        [
          buildUnitInit("a", "HBK-4G", 1, { col: 2, row: 4 }, "n"),
          buildUnitInit("b", "ENF-4R", 1, { col: 3, row: 4 }, "sw"),
          buildUnitInit("c", "ENF-4R", 2, { col: 5, row: 4 }, "sw"),
        ],
        true,
      );
      startAttackTurn(state);
      expect(() =>
        validateAttacksImpl(state, "a", [{ weaponIndex: 1, targetId: "b" }], [], {}),
      ).toThrow(/Target must belong to another team/);
    });

    it("accepts a multi-target volley (TW p.108)", () => {
      const state = createTestBattle(
        [],
        [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "n"),
          buildUnitInit("enf1", "ENF-4R", 2, { col: 3, row: 4 }, "sw"),
          buildUnitInit("enf2", "ENF-4R", 2, { col: 2, row: 2 }, "s"),
        ],
        true,
      );
      startAttackTurn(state);
      const r = validateAttacksImpl(
        state,
        "hbk",
        [
          { weaponIndex: 2, targetId: "enf1" },
          { weaponIndex: 1, targetId: "enf2" },
        ],
        [],
        {},
      );
      expect(r.targets.map((t) => t.targetId)).toEqual(["enf1", "enf2"]);
    });

    it("throws on target outside firing arc", () => {
      // hbk at (2,4) facing n; weapon 1 = left-arm medium laser. Target SE
      // (3,5) lies in the rightSide template arc — outside leftArm's arc.
      const state = createTestBattle(
        [],
        [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "n"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 5 }, "sw"),
        ],
        true,
      );
      startAttackTurn(state);
      expect(() =>
        validateAttacksImpl(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], {}),
      ).toThrow(/cannot fire into the rightSide arc/);
    });

    it("accepts a volley through a boundary arc (altArc honored)", () => {
      // hbk at (2,4) facing n, target directly north at (2,3). Bearing is N
      // (front arc); a leftArm weapon can fire into front arc. Use weapon 1
      // and add a second weapon 2 (right arm). Both face front — accepts.
      const state = createTestBattle(
        [],
        [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "n"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 3 }, "s"),
        ],
        true,
      );
      startAttackTurn(state);
      const r = validateAttacksImpl(
        state,
        "hbk",
        [
          { weaponIndex: 1, targetId: "enf" },
          { weaponIndex: 2, targetId: "enf" },
        ],
        [],
        {},
      )!;
      expect(r.targets[0]!.distance).toBe(1);
      expect(r.arcs[1]).toBe("front");
      expect(r.arcs[2]).toBe("front");
    });

    it("throws when range exceeds weapon long", () => {
      // hbk weapon 1 (medium laser) has long = 9. Place target at distance 10
      // directly north (front arc) — well inside arc, beyond range.
      const state = createTestBattle(
        [],
        [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 5, row: 15 }, "n"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 5, row: 5 }, "s"),
        ],
        true,
        7,
        17,
      );
      startAttackTurn(state);
      expect(() =>
        validateAttacksImpl(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], {}),
      ).toThrow(/exceeds long range/);
    });

    it("throws on rapid-fire without rapidFireShots", () => {
      const state = hbkVsEnf();
      expect(() =>
        validateAttacksImpl(
          state,
          "hbk",
          [{ weaponIndex: 1, targetId: "enf", rapidFire: true }],
          [],
          {},
        ),
      ).toThrow(/is not rapid-fire/);
    });

    it("throws on empty decls list", () => {
      const state = hbkVsEnf();
      expect(() => validateAttacksImpl(state, "hbk", [], [], {})).toThrow(
        /requires at least one declaration/,
      );
    });

    it("throws on unknown target", () => {
      const state = hbkVsEnf();
      expect(() =>
        validateAttacksImpl(state, "hbk", [{ weaponIndex: 2, targetId: "ghost" }], [], {}),
      ).toThrow();
    });

    it("throws on prone two-arm volley (both arms in either order)", () => {
      const state = createTestBattle(
        [],
        [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "n"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 3 }, "s"),
        ],
        true,
      );
      startAttackTurn(state);
      requireUnit(state, "hbk").prone = true;
      expect(() =>
        validateAttacksImpl(
          state,
          "hbk",
          [
            { weaponIndex: 1, targetId: "enf" },
            { weaponIndex: 2, targetId: "enf" },
          ],
          [],
          {},
        ),
      ).toThrow(/volley uses both arms/);
      // Order-independent: arms swapped still rejects.
      expect(() =>
        validateAttacksImpl(
          state,
          "hbk",
          [
            { weaponIndex: 2, targetId: "enf" },
            { weaponIndex: 1, targetId: "enf" },
          ],
          [],
          {},
        ),
      ).toThrow(/volley uses both arms/);
    });

    it("accepts a prone single-arm volley", () => {
      const state = createTestBattle(
        [],
        [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "n"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 3 }, "s"),
        ],
        true,
      );
      startAttackTurn(state);
      requireUnit(state, "hbk").prone = true;
      const r = validateAttacksImpl(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], {})!;
      expect(r.primaryTargetId).toBe("enf");
    });

    it("does not check phase, actor queue, or sensors (session-level gates)", () => {
      // Build a state still in initiative phase.
      const state = createTestBattle(
        [],
        [
          buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "n"),
          buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 3 }, "s"),
        ],
        true,
      );
      rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []); // now initiative phase, team 1 wins
      // Phase is "initiative" — validateAttacks should still run.
      expect(() =>
        validateAttacksImpl(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], {}),
      ).not.toThrow();
    });

    it("does not consume RNG — repeated calls with same input return same metadata", () => {
      const state = hbkVsEnf();
      const a = validateAttacksImpl(state, "hbk", [{ weaponIndex: 2, targetId: "enf" }], [], {});
      const b = validateAttacksImpl(state, "hbk", [{ weaponIndex: 2, targetId: "enf" }], [], {});
      expect(a).toEqual(b);
    });

    it("twist rotates the firing arc", () => {
      // hbk facing n; target NE (rightSide). Without twist, leftArm weapon 1
      // is rejected. With twist rightSide, target shifts into front arc and
      // weapon 1 (left arm, front-allowed) accepts.
      const state = hbkVsEnf();
      expect(() =>
        validateAttacksImpl(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], {
          twist: "rightSide",
        }),
      ).not.toThrow();
    });
  });
});

describe("multitarget", () => {
  // HBK-4G weapons (1-based): 1 = left-arm ML, 2 = right-arm ML, 3 = head SL, 4 = RT AC/20.
  // Attacker at (4,6) facing north. Target hexes (verified against
  // classifyFiringArc): (4,3) and (5,3) front, (2,6) leftSide, (6,6) rightSide.
  const FRONT_A = { col: 4, row: 3 };
  const FRONT_B = { col: 5, row: 3 };
  const LEFT = { col: 2, row: 6 };
  const RIGHT = { col: 6, row: 6 };

  function setup() {
    const state = createTestBattle(
      [],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 4, row: 6 }, "n"),
        buildUnitInit("fa", "ENF-4R", 2, FRONT_A, "s"),
        buildUnitInit("fb", "ENF-4R", 2, FRONT_B, "s"),
        buildUnitInit("l", "ENF-4R", 2, LEFT, "s"),
        buildUnitInit("r", "ENF-4R", 2, RIGHT, "s"),
      ],
      true,
    );
    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
    advancePhase(state, [], scriptedRng());
    return state;
  }

  const w = (weaponIndex: number, targetId: string): WeaponAttackDecl => ({
    weaponIndex,
    targetId,
  });

  describe("multiple targets (TW p.108)", () => {
    it("defaults the primary to the first target; a forward-arc secondary is +1", () => {
      const r = validateAttacksImpl(setup(), "hbk", [w(1, "fa"), w(2, "fb")]);
      expect(r.primaryTargetId).toBe("fa");
      expect(r.targets.map((t) => t.secondaryMod)).toEqual([0, 1]);
    });

    it("makes a forward-arc target primary when the first target is not", () => {
      const r = validateAttacksImpl(setup(), "hbk", [w(1, "l"), w(3, "fa")]);
      expect(r.primaryTargetId).toBe("fa");
      expect(r.targets.find((t) => t.targetId === "l")!.secondaryMod).toBe(2);
    });

    it("applies +2 to a side-arc secondary and does not stack on later targets", () => {
      const r = validateAttacksImpl(setup(), "hbk", [w(3, "fa"), w(1, "l"), w(2, "r")]);
      expect(r.targets.map((t) => t.secondaryMod)).toEqual([0, 2, 2]);
    });

    it("lets any target be primary when none is in the forward arc", () => {
      const decls = [w(1, "l"), w(2, "r")];
      expect(validateAttacksImpl(setup(), "hbk", decls).primaryTargetId).toBe("l");
      const r = validateAttacksImpl(setup(), "hbk", decls, [], { primaryTargetId: "r" });
      expect(r.primaryTargetId).toBe("r");
      expect(r.targets.map((t) => t.secondaryMod)).toEqual([2, 0]);
    });

    it("rejects a non-forward primary when a forward target exists", () => {
      expect(() =>
        validateAttacksImpl(setup(), "hbk", [w(1, "l"), w(3, "fa")], [], { primaryTargetId: "l" }),
      ).toThrow(/forward arc/);
    });

    it("rejects a primary that is not a declared target", () => {
      expect(() =>
        validateAttacksImpl(setup(), "hbk", [w(1, "fa"), w(2, "fb")], [], { primaryTargetId: "r" }),
      ).toThrow(/not a declared weapon target/);
    });

    it("groups weapons per target and exposes the status on events", () => {
      const state = setup();
      const events: GameEvent[] = [];
      declareAttacks(state, "hbk", [w(1, "fa"), w(3, "fa"), w(2, "fb")], [], events, seededRng(7));
      const declared = events.find((e) => e.kind === "attacksDeclared");
      expect(declared?.kind === "attacksDeclared" && declared.weapons).toMatchObject([
        { targetId: "fa", count: 2, secondaryMod: 0 },
        { targetId: "fb", count: 1, secondaryMod: 1 },
      ]);
      const decls = state.units.hbk!.declaredWeaponAttacks;
      expect(decls.map((d) => d.secondaryMod)).toEqual([undefined, undefined, 1]);

      const resolved: GameEvent[] = [];
      resolveAllAttacks(state, seededRng(7), resolved);
      const attacks = resolved.filter((e) => e.kind === "attackResolved");
      expect(attacks).toHaveLength(3);
      for (const e of attacks) {
        if (e.kind !== "attackResolved") continue;
        const secondary = e.targetId === "fb";
        expect(e.secondaryMod).toBe(secondary ? 1 : 0);
        expect(e.resolution.breakdown.secondaryTargetMod).toBe(secondary ? 1 : 0);
      }
    });

    it("raises the to-hit number of a secondary shot by the modifier", () => {
      const solo = setup();
      const both = setup();
      const a: GameEvent[] = [];
      const b: GameEvent[] = [];
      declareAttacks(solo, "hbk", [w(2, "fb")], [], a, seededRng(3));
      declareAttacks(both, "hbk", [w(1, "fa"), w(2, "fb")], [], b, seededRng(3));
      resolveAllAttacks(solo, seededRng(3), a);
      resolveAllAttacks(both, seededRng(3), b);
      const total = (evs: GameEvent[]) =>
        evs.flatMap((e) =>
          e.kind === "attackResolved" && e.targetId === "fb"
            ? [toHitTotal(e.resolution.breakdown)]
            : [],
        )[0];
      expect(total(b)).toBe(total(a)! + 1);
    });

    it("classifies the modifier against the twisted facing", () => {
      const hbk = { col: 4, row: 6 };
      expect(secondaryTargetModifier(hbk, FRONT_B, "n")).toBe(1);
      expect(secondaryTargetModifier(hbk, LEFT, "n")).toBe(2);
      expect(secondaryTargetModifier(hbk, RIGHT, "n")).toBe(2);
      // Twisting left swings the torso one hexside counter-clockwise: the left
      // target comes into the forward arc, the right one moves further away.
      expect(secondaryTargetModifier(hbk, LEFT, "n", "leftSide")).toBe(1);
    });

    it("stamps the twisted-facing modifier on the decl and resolves with it", () => {
      const state = setup();
      const events: GameEvent[] = [];
      // Twist left: 'fa' and 'l' are both forward, so the secondary is +1
      // (untwisted it would be +2 for the left target).
      const decls = [w(2, "fa"), w(1, "l")];
      const v = validateAttacksImpl(state, "hbk", decls, [], { twist: "leftSide" });
      const declared = Object.fromEntries(v.targets.map((t) => [t.targetId, t.secondaryMod]));
      declareAttacks(state, "hbk", decls, [], events, seededRng(5), { twist: "leftSide" });
      expect(state.units.hbk!.declaredWeaponAttacks.map((d) => d.secondaryMod)).toEqual([
        undefined,
        1,
      ]);
      resolveAllAttacks(state, seededRng(5), events);
      const resolved = events.flatMap((e) => (e.kind === "attackResolved" ? [e] : []));
      expect(resolved).toHaveLength(2);
      for (const e of resolved) {
        expect(e.secondaryMod).toBe(declared[e.targetId]);
        expect(e.resolution.breakdown.secondaryTargetMod).toBe(declared[e.targetId]);
      }
      expect(Object.values(declared).some((m) => m === 1)).toBe(true);
    });
  });
});

describe("actuators", () => {
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
});
