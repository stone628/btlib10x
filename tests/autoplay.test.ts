import { describe, expect, it } from "vitest";
import { mechDefFor } from "../src/data/index";
import {
  effectiveMoveBudget,
  effectiveMovement,
  isUnitImmobile,
  STAND_MP_COST,
} from "../src/index";
import {
  AUTOPLAY_MAX_TURNS,
  nextAutoPlayCommand,
  resetAutoplayState,
} from "../web/terminal/autoplay";
import {
  commitMovement,
  declareMovementMode,
  newSession,
  requireAttackActor,
  type Session,
} from "../web/terminal/session";
import { critWeapon, disableCritical, execute, scriptedRng } from "./helpers";

/**
 * Build a two-unit battle and drive it into the weapon attack phase (both
 * units have moved), returning the session. The current actor is whoever
 * acts next in the weapon attack phase.
 */
function sessionAtWeaponAttack(): Session {
  const s = newSession(7);
  execute(s, "map quickstart");
  execute(s, "add hunchy HBK-4G 9 9 n");
  execute(s, "add cicada CDA-3MA 9 8 s");
  execute(s, "start");
  disableCritical(s);
  // Movement phase: both units move (walk), advancing to weapon attack.
  for (let i = 0; i < 2; i++) {
    if (s.battle!.phase === "movement") {
      declareMovementMode(s, "walk");
      commitMovement(s);
    }
  }
  return s;
}

/** Build a fresh session at the start of movement phase 1 with `hunchy`
 *  (HBK-4G, walk 4) guaranteed to be the first mover. Per TW p.37 the loser
 *  of initiative moves first, so we force hunchy to LOSE (5 vs 12). */
function sessionAtMovementStart(): Session {
  const s = newSession(7);
  // Hunchy rolls 5 (2+3), cicada rolls 12 (6+6). Loser-of-initiative moves
  // first, so hunchy becomes the first actor.
  s.rng = scriptedRng(2, 3, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6);
  execute(s, "map quickstart");
  execute(s, "add hunchy HBK-4G 9 9 n");
  execute(s, "add cicada CDA-3MA 9 8 s");
  execute(s, "start");
  disableCritical(s);
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
    expect(s.battle!.phase).toBe("attack");

    const actor = requireAttackActor(s);
    const def = mechDefFor(actor);
    // Find a plain (non-ammo) weapon mount on the acting unit and mark it
    // destroyed, simulating a prior-turn critical-slot hit.
    const target = Object.entries(def.weapons).find(([, m]) => m.shots === undefined);
    expect(target, "acting unit should have a non-ammo weapon").toBeDefined();
    const destroyedIndex = Number(target![0]);
    critWeapon(actor, destroyedIndex);

    const cmds = Array.from({ length: 12 }, () => nextAutoPlayCommand(s)).filter(
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
    expect(s.battle!.phase).toBe("attack");

    const actor = requireAttackActor(s);
    const enemyId = actor.id === "hunchy" ? "cicada" : "hunchy";
    const enemy = s.battle!.units[enemyId]!;
    // Push the enemy up the column (long range) with heavy movement (+6):
    // gunnery 4 + walk 1 + target 6 + long 4 = 15 -> lasers auto-miss.
    enemy.position = { col: 9, row: 1 };
    actor.facing = "n";
    enemy.hexesMovedThisTurn = 30;

    const cmds = Array.from({ length: 12 }, () => nextAutoPlayCommand(s)).filter(
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
    const out = execute(s, "mode pronestill");
    expect(out[0]).not.toMatch(/^error:/);
    expect(() => commitMovement(s)).not.toThrow();
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
    const def = mechDefFor(actor);
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
    const def = mechDefFor(actor);
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
    const def = mechDefFor(actor);
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

/** Feed autoplay commands through the CLI until it stops (or `limit` ticks),
 *  returning every command it typed and every line that came back as an error. */
function runAutoplay(s: Session, limit: number): { commands: string[]; errors: string[] } {
  resetAutoplayState(s);
  const commands: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < limit; i++) {
    const cmd = nextAutoPlayCommand(s);
    if (cmd === null) break;
    commands.push(cmd);
    for (const line of execute(s, cmd)) {
      if (/^error:/.test(line)) errors.push(`${cmd}: ${line}`);
    }
  }
  return { commands, errors };
}

describe("nextAutoPlayCommand with the persona player", () => {
  it("plays movement with the persona: a mode, a landing, then done", () => {
    const s = sessionAtMovementStart();
    resetAutoplayState(s);
    const cmds = Array.from({ length: 12 }, () => nextAutoPlayCommand(s));
    const mode = cmds.findIndex((c) => c?.startsWith("mode ") === true);
    expect(mode).toBeGreaterThanOrEqual(0);
    const next = cmds.slice(mode + 1);
    // standstill goes straight to done; every other mode places a landing first.
    if (cmds[mode] === "mode standstill") expect(next[0]).toBe("done");
    else expect(next[0]).toMatch(/^place \d+ \d+ \S+$/);
  });

  it("installs the persona context so `pp why` can show the reasoning", () => {
    const s = sessionAtMovementStart();
    const actorId = s.move!.actorId!;
    resetAutoplayState(s);
    for (let i = 0; i < 12 && s.persona.lastTrace[actorId] === undefined; i++) {
      nextAutoPlayCommand(s);
    }
    expect(s.persona.lastTrace[actorId]?.persona).toBe("alpha");
  });

  it("plays several turns without errors, with help once per phase and sheets every turn", () => {
    // Real dice: the scripted RNG of sessionAtMovementStart() runs out.
    const s = newSession(7);
    execute(s, "map quickstart");
    execute(s, "add hunchy HBK-4G 9 9 n");
    execute(s, "add cicada CDA-3MA 9 8 s");
    execute(s, "start");
    const startTurn = s.battle!.turn;
    const { commands, errors } = runAutoplay(s, 400);
    expect(errors).toEqual([]);
    // help: at most once each for battle movement, battle attack and game over.
    expect(commands.filter((c) => c === "help").length).toBeLessThanOrEqual(3);
    const turnsPlayed = (s.battle?.turn ?? startTurn) - startTurn + 1;
    const sheetRounds = commands.filter((c) => c === "sheet hunchy").length;
    expect(sheetRounds).toBeGreaterThanOrEqual(Math.min(turnsPlayed, 2));
  });

  it("stops after AUTOPLAY_MAX_TURNS", () => {
    const s = sessionAtMovementStart();
    s.battle!.turn = AUTOPLAY_MAX_TURNS + 1;
    resetAutoplayState(s);
    expect(nextAutoPlayCommand(s)).toBeNull();
  });
});
