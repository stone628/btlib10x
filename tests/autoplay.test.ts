import { describe, expect, it } from "vitest";
import { getMechDefFor } from "../src/data/index.js";
import {
  effectiveMoveBudget,
  effectiveMovement,
  isUnitImmobile,
  STAND_MP_COST,
} from "../src/index.js";
import { nextAutoPlayCommand, resetAutoplayState } from "../web/autoplay.js";
import { commitMove, currentActor, declareMode, newSession, type Session } from "../web/session.js";
import { execute, scriptedRng } from "./helpers.js";

function run(s: Session, cmd: string): string[] {
  return execute(s, cmd);
}

/**
 * Build a two-unit battle and drive it into the weapon attack phase (both
 * units have moved), returning the session. The current actor is whoever
 * acts next in the weapon attack phase.
 */
function sessionAtWeaponAttack(): Session {
  const s = newSession(7);
  s.critsDisabled = true;
  run(s, "map quickstart");
  run(s, "add hunchy HBK-4G 9 9 n");
  run(s, "add cicada CDA-3MA 9 8 s");
  run(s, "start");
  // Movement phase: both units move (walk), advancing to weapon attack.
  for (let i = 0; i < 2; i++) {
    if (s.battle!.phase === "movement") {
      declareMode(s, "walk");
      commitMove(s);
    }
  }
  return s;
}

/** Build a fresh session at the start of movement phase 1 with `hunchy`
 *  (HBK-4G, walk 4) guaranteed to be the first mover. Per TW p.37 the loser
 *  of initiative moves first, so we force hunchy to LOSE (5 vs 12). */
function sessionAtMovementStart(): Session {
  const s = newSession(7);
  s.critsDisabled = true;
  // Hunchy rolls 5 (2+3), cicada rolls 12 (6+6). Loser-of-initiative moves
  // first, so hunchy becomes the first actor.
  s.rng = scriptedRng(2, 3, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6);
  run(s, "map quickstart");
  run(s, "add hunchy HBK-4G 9 9 n");
  run(s, "add cicada CDA-3MA 9 8 s");
  run(s, "start");
  expect(s.battle!.phase).toBe("movement");
  expect(s.move!.actorId).toBe("hunchy");
  return s;
}

/** Drain the autoplay queue until a `mode …` command surfaces (or `n` ticks
 *  have elapsed with nothing found). Drops sheet/status/help noise. */
function nextModeCommand(s: Session, n = 8): string | null {
  for (let i = 0; i < n; i++) {
    const cmd = nextAutoPlayCommand(s);
    if (cmd === null) return null;
    if (cmd.startsWith("mode ")) return cmd;
    if (cmd.startsWith("done") || cmd.startsWith("place ") || cmd.startsWith("fire ")) return cmd;
  }
  return null;
}

/** Mutate the actor on the right leg internal structure (depleted). */
function destroyLeg(s: Session, id: string, leg: "rightLeg" | "leftLeg" = "rightLeg"): void {
  s.battle!.units[id]!.damage.internalStructure[leg] = 0;
}
/** Strip both legs and both arms to make the unit a true immobile target. */
function makeImmobile(s: Session, id: string): void {
  for (const loc of ["rightLeg", "leftLeg", "rightArm", "leftArm"] as const) {
    s.battle!.units[id]!.damage.internalStructure[loc] = 0;
  }
}

describe("nextAutoPlayCommand (autoplay demo driver)", () => {
  it("omits weapons destroyed by a critical slot hit from the fire command", () => {
    const s = sessionAtWeaponAttack();
    resetAutoplayState(s);
    expect(s.battle!.phase).toBe("weaponAttack");

    const actor = currentActor(s)!;
    const def = getMechDefFor(actor);
    // Find a plain (non-ammo) weapon mount on the acting unit and mark it
    // destroyed, simulating a prior-turn critical-slot hit.
    const target = Object.entries(def.weapons).find(([, m]) => m.shots === undefined);
    expect(target, "acting unit should have a non-ammo weapon").toBeDefined();
    const destroyedIndex = Number(target![0]);
    actor.destroyedWeapons.push(destroyedIndex);

    const cmds = [0, 1, 2, 3, 4]
      .map(() => nextAutoPlayCommand(s))
      .filter(
        (c): c is string => c !== null && c !== "help" && c !== "status" && c !== "candidate",
      );
    const cmd = cmds.find((c) => c.startsWith("fire"));
    expect(cmd).toBeDefined();
    const indexes = cmd!
      .replace(/^fire \S+\s*/, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    expect(indexes).not.toContain(destroyedIndex);
  });

  it("omits auto-miss weapons from the fire command", () => {
    const s = sessionAtWeaponAttack();
    resetAutoplayState(s);
    expect(s.battle!.phase).toBe("weaponAttack");

    const actor = currentActor(s)!;
    const enemyId = actor.id === "hunchy" ? "cicada" : "hunchy";
    const enemy = s.battle!.units[enemyId]!;
    // Push the enemy up the column (long range) with heavy movement (+6):
    // gunnery 4 + walk 1 + target 6 + long 4 = 15 -> lasers auto-miss.
    enemy.position = { col: 9, row: 1 };
    actor.facing = "n";
    enemy.movesThisTurn = Array(30).fill("forward");

    const cmds = [0, 1, 2, 3, 4]
      .map(() => nextAutoPlayCommand(s))
      .filter(
        (c): c is string => c !== null && c !== "help" && c !== "status" && c !== "candidate",
      );
    const fire = cmds.find((c) => c.startsWith("fire"));
    expect(fire).toBeDefined();
    const indexes = fire!
      .replace(/^fire \S+\s*/, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    // Snub-Nose PPC (2) keeps a fireable TN; the lasers auto-miss and the
    // Small Pulse Laser is out of range.
    expect(indexes).toEqual([2]);
  });
});

describe("nextAutoPlayCommand movement-phase posture/MP guards", () => {
  it("immobile + prone: emits `mode pronestill` (not the illegal `mode standup walk`)", () => {
    const s = sessionAtMovementStart();
    const actorId = s.move!.actorId!;
    const actor = s.battle!.units[actorId]!;
    makeImmobile(s, actorId);
    actor.prone = true;

    resetAutoplayState(s);
    const cmd = nextModeCommand(s);
    expect(cmd).toBe("mode pronestill");
  });

  it("immobile + prone: applying the emitted mode commits without throwing", () => {
    const s = sessionAtMovementStart();
    const actorId = s.move!.actorId!;
    const actor = s.battle!.units[actorId]!;
    makeImmobile(s, actorId);
    actor.prone = true;

    resetAutoplayState(s);
    const cmd = nextModeCommand(s);
    expect(cmd).toBe("mode pronestill");
    const out = run(s, "mode pronestill");
    expect(out[0]).not.toMatch(/^error:/);
    expect(() => commitMove(s)).not.toThrow();
  });

  it("one-leg + prone: attempts `mode standup walk` (canAttemptStandUp)", () => {
    const s = sessionAtMovementStart();
    const actorId = s.move!.actorId!;
    const actor = s.battle!.units[actorId]!;
    destroyLeg(s, actorId);
    actor.prone = true;
    expect(isUnitImmobile(actor.damage)).toBe(false);

    resetAutoplayState(s);
    const cmd = nextModeCommand(s);
    expect(cmd).toBe("mode standup walk");
  });

  it("one-leg + two-arms + prone: cannot stand, emits `mode pronestill` (TW p.50)", () => {
    const s = sessionAtMovementStart();
    const actorId = s.move!.actorId!;
    const actor = s.battle!.units[actorId]!;
    destroyLeg(s, actorId);
    actor.damage.internalStructure.rightArm = 0;
    actor.damage.internalStructure.leftArm = 0;
    actor.prone = true;
    expect(isUnitImmobile(actor.damage)).toBe(false);

    resetAutoplayState(s);
    const cmd = nextModeCommand(s);
    expect(cmd).toBe("mode pronestill");
  });

  it("one-leg + standing: emits `mode walk` (TW p.122: walk 1 MP)", () => {
    const s = sessionAtMovementStart();
    const actorId = s.move!.actorId!;
    destroyLeg(s, actorId);

    resetAutoplayState(s);
    const cmd = nextModeCommand(s);
    expect(cmd).toBe("mode walk");
  });

  it("mobile + prone + walk budget < STAND_MP_COST: emits `mode pronestill`", () => {
    const s = sessionAtMovementStart();
    const actorId = s.move!.actorId!;
    const actor = s.battle!.units[actorId]!;
    actor.prone = true;
    // Climb heat until the actor's walk budget drops below the 2-MP stand
    // cost, without making the unit immobile.
    const def = getMechDefFor(actor);
    for (let heat = 0; heat <= 30; heat++) {
      actor.heat = heat;
      const budget = effectiveMoveBudget(
        "walk",
        effectiveMovement(def, actor.damage, actor.critSlotsDestroyed),
        actor.heat,
      );
      if (budget < STAND_MP_COST) {
        break;
      }
    }
    const finalBudget = effectiveMoveBudget(
      "walk",
      effectiveMovement(def, actor.damage, actor.critSlotsDestroyed),
      actor.heat,
    );
    expect(isUnitImmobile(actor.damage)).toBe(false);
    expect(finalBudget).toBeLessThan(STAND_MP_COST);

    resetAutoplayState(s);
    const cmd = nextModeCommand(s);
    expect(cmd).toBe("mode pronestill");
  });

  it("notprone + walk budget 0 (heat-shutdown walk MP): emits `mode standstill`", () => {
    const s = sessionAtMovementStart();
    const actorId = s.move!.actorId!;
    const actor = s.battle!.units[actorId]!;
    const def = getMechDefFor(actor);
    // Climb heat until walk MP is clamped to 0.
    for (let heat = 0; heat <= 30; heat++) {
      actor.heat = heat;
      const budget = effectiveMoveBudget(
        "walk",
        effectiveMovement(def, actor.damage, actor.critSlotsDestroyed),
        actor.heat,
      );
      if (budget === 0) {
        break;
      }
    }
    const finalBudget = effectiveMoveBudget(
      "walk",
      effectiveMovement(def, actor.damage, actor.critSlotsDestroyed),
      actor.heat,
    );
    expect(isUnitImmobile(actor.damage)).toBe(false);
    expect(finalBudget).toBe(0);

    resetAutoplayState(s);
    const cmd = nextModeCommand(s);
    expect(cmd).toBe("mode standstill");
  });

  it("mobile + prone + walk budget >= STAND_MP_COST: still emits `mode standup walk`", () => {
    const s = sessionAtMovementStart();
    const actorId = s.move!.actorId!;
    const actor = s.battle!.units[actorId]!;
    actor.prone = true;
    actor.heat = 0;
    const def = getMechDefFor(actor);
    const budget = effectiveMoveBudget(
      "walk",
      effectiveMovement(def, actor.damage, actor.critSlotsDestroyed),
      actor.heat,
    );
    expect(isUnitImmobile(actor.damage)).toBe(false);
    expect(budget).toBeGreaterThanOrEqual(STAND_MP_COST);

    resetAutoplayState(s);
    const cmd = nextModeCommand(s);
    expect(cmd).toBe("mode standup walk");
  });

  it("notprone + immobile (both legs and both arms): emits `mode standstill`", () => {
    const s = sessionAtMovementStart();
    const actorId = s.move!.actorId!;
    makeImmobile(s, actorId);

    resetAutoplayState(s);
    const cmd = nextModeCommand(s);
    expect(cmd).toBe("mode standstill");
  });
});
