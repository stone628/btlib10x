import { isArm, mapDefFor, mechDefFor, suggestFireTargets } from "btlib10x";
import { describe, expect, it } from "vitest";
import { mechDefFor as mechDefForSrc } from "../src/data/index";
import { effectiveMovement } from "../src/rules/critical";
import { isUnitImmobile } from "../src/rules/damage";
import { STAND_MP_COST } from "../src/rules/game/constants";
import { effectiveMoveBudget } from "../src/rules/heat";
import {
  AUTOPLAY_MAX_TURNS,
  nextAutoPlayCommand,
  resetAutoplayState,
} from "../web/terminal/autoplay";
import { decide } from "../web/terminal/persona";
import { scoreAttacks } from "../web/terminal/persona.attack";
import { rangeProfile } from "../web/terminal/persona.common";
import { PERSONAS } from "../web/terminal/persona.data";
import { scoreMoves } from "../web/terminal/persona.move";
import {
  commitMovement,
  declareMovementMode,
  newSession,
  requireAttackActor,
  type Session,
} from "../web/terminal/session";
import { critWeapon } from "./helpers/battle";
import { scriptedRng } from "./helpers/rng";
import { disableCritical, execute } from "./helpers/session";

/** HBK by hand vs. a persona WVR, both well inside each other's range. */
function setup(seed = 5, persona = "jumpjockey"): Session {
  const s = newSession(seed);
  execute(s, "map quickstart");
  execute(s, "add me HBK-4G 9 9 n");
  execute(s, "add foe WVR-6R 9 5 s");
  execute(s, `pp foe ${persona}`);
  return s;
}

/** Finish the human's current activation with a stand-still / pass. */
function pass(s: Session): string[] {
  if (s.battle!.phase === "movement") execute(s, "mode standstill");
  return execute(s, "done");
}

function actorId(s: Session): string | null {
  return s.move?.actorId ?? s.attack?.actorId ?? null;
}

describe("persona player: assignment", () => {
  it("assigns in setup only and keeps the persona out of the unit data", () => {
    const s = setup();
    expect(execute(s, "pp")).toContain("  foe: Jump Jockey");
    expect(s.setup.roster.find((u) => u.id === "foe")).not.toHaveProperty("persona");
    expect(execute(s, "pp foe sniper")[0]).toMatch(/unknown persona/);
    expect(execute(s, "pp ghost alpha")[0]).toMatch(/ghost/);
    execute(s, "start");
    expect(execute(s, "pp me alpha")[0]).toMatch(/setup only/);
  });

  it("plays only persona prompts and leaves the human prompt to the human", () => {
    const s = setup();
    execute(s, "start");
    // Whatever the initiative, after start the prompt belongs to the human.
    expect(s.state).toBe("battle");
    expect(actorId(s)).toBe("me");
  });
});

describe("persona player: decisions", () => {
  it("shows its reasoning in the attack-resolution box and types its commands", () => {
    const s = setup();
    const out = [...execute(s, "start"), ...pass(s)].join("\n");
    expect(out).toMatch(/\[foe -> me\]/);
    expect(out).toMatch(/persona Jump Jockey · posture/);
    expect(out).toMatch(/#1 .* = /);
    expect(out).toMatch(/chose #1/);
    expect(out).toMatch(/> done/);
    expect(s.persona.lastTrace.foe).toBeDefined();
  });

  it("never touches the battle dice while deciding", () => {
    const s = setup();
    execute(s, "start");
    if (s.battle!.phase === "movement") execute(s, "mode standstill");
    execute(s, "done");
    // Seed 5: one rollback lands on the persona's move prompt (rollback does not auto-play).
    execute(s, "rollback");
    expect(actorId(s)).toBe("foe");
    const dice = s.rng.snapshot();
    const own = s.persona.rng;
    expect(decide(s, s.persona.assignments.foe!, s.persona)).not.toBeNull();
    expect(s.rng.snapshot()).toBe(dice);
    expect(s.persona.rng).toBe(own);
  });

  it("is deterministic for a seed", () => {
    const run = (): string[] => {
      const s = setup(11);
      const out = execute(s, "start");
      for (let i = 0; i < 8 && s.state === "battle"; i++) out.push(...pass(s));
      return out;
    };
    expect(run()).toEqual(run());
  });

  it("rollback restores its context, waits, and 'pp go' replays the same decision", () => {
    const s = setup();
    execute(s, "start");
    pass(s);
    const trace = s.persona.lastTrace.foe;
    expect(trace).toBeDefined();
    // Seed 5: the human moves first, so one rollback lands on the persona's move prompt.
    const out = execute(s, "rollback");
    expect(actorId(s)).toBe("foe");
    expect(out.join("\n")).toMatch(/pp go/);
    const replayed = execute(s, "pp go").join("\n");
    expect(replayed).toMatch(/\[foe/);
    expect(s.persona.lastTrace.foe?.commands).toEqual(trace?.commands);
  });
});

describe("persona player: pp phase", () => {
  it("plays the human unit's current phase once, then hands the next prompt back", () => {
    const s = setup();
    execute(s, "start");
    expect(actorId(s)).toBe("me");
    const turn = s.battle!.turn;
    const out = execute(s, "pp phase longtom").join("\n");
    expect(out).toMatch(/me: Long Tom plays this phase/);
    expect(out).toMatch(/persona Long Tom · posture/);
    expect(out).toMatch(/> done/);
    expect(s.persona.lastTrace.me?.persona).toBe("longtom");
    expect(s.persona.assignments.me).toBeUndefined();
    // The persona opponent's prompts were driven on: the prompt is the human's again.
    expect(actorId(s)).toBe("me");
    expect(s.battle!.phase === "attack" || s.battle!.turn > turn).toBe(true);
  });

  it("refuses persona-assigned units, unknown personas and setup", () => {
    const s = setup();
    expect(execute(s, "pp phase alpha")[0]).toMatch(/phase/);
    execute(s, "start");
    expect(execute(s, "pp phase sniper")[0]).toMatch(/unknown persona/);
    execute(s, "rollback");
    if (actorId(s) === "foe") {
      expect(execute(s, "pp phase alpha")[0]).toMatch(/foe is played by the Jump Jockey persona/);
    }
  });

  it("rolls back like any other prompt", () => {
    const s = setup();
    execute(s, "start");
    const before = execute(s, "status").join("\n");
    execute(s, "pp phase alpha");
    expect(s.persona.lastTrace.me).toBeDefined();
    // Back through the prompts the phase and the opponent played, to the start.
    for (let i = 0; i < 10 && execute(s, "status").join("\n") !== before; i++) {
      execute(s, "rollback");
    }
    expect(s.persona.lastTrace.me).toBeUndefined();
    expect(execute(s, "status").join("\n")).toBe(before);
  });
});

describe("persona player: jump", () => {
  it("never jumps back into its own hex (TW p. 53: a jump must leave the hex)", () => {
    for (const seed of [1, 2, 3, 5, 8]) {
      for (const key of ["jumpjockey", "gladiator", "longtom"] as const) {
        const s = setup(seed, key);
        execute(s, "pp trace off");
        execute(s, "start");
        for (let i = 0; i < 20 && s.state === "battle"; i++) {
          const foe = s.battle!.units.foe!;
          if (s.battle!.phase === "movement" && foe.position !== undefined) {
            const candidates = scoreMoves({
              battle: s.battle!,
              actor: foe,
              target: s.battle!.units.me!,
              persona: PERSONAS[key],
              profile: rangeProfile(foe, PERSONAS[key].range),
              heatCeiling: PERSONAS[key].heatCeiling,
            });
            const inPlace = candidates.filter(
              (c) =>
                c.commands[0] === "mode jump" &&
                c.commands[1] ===
                  `place ${foe.position.col} ${foe.position.row} ${c.label.split(" ").at(-1)}`,
            );
            expect(inPlace).toEqual([]);
          }
          const from = { ...foe.position };
          const t = s.persona.lastTrace.foe;
          pass(s);
          const played = s.persona.lastTrace.foe;
          if (played !== t && played?.commands.includes("mode jump")) {
            expect(played.commands).not.toContain(
              expect.stringMatching(new RegExp(`^place ${from.col} ${from.row} `)),
            );
          }
        }
      }
    }
  });
});

describe("persona player: discipline", () => {
  it("a Cold persona never plans a volley past its heat ceiling", () => {
    const s = setup(5, "dispossessed");
    execute(s, "start");
    let attacks = 0;
    for (let i = 0; i < 16 && s.state === "battle"; i++) {
      const t = s.persona.lastTrace.foe;
      if (t?.phase === "attack") {
        attacks++;
        expect(t.heatCeiling).toBe(PERSONAS.dispossessed.heatCeiling);
        for (const c of t.candidates.filter((x) => x.commands.some((k) => k.startsWith("fire")))) {
          expect(c.terms.some((x) => x.id === "heat")).toBe(false);
        }
      }
      pass(s);
    }
    expect(attacks).toBeGreaterThan(0);
  });

  it("Miser fires no ammo weapon above to-hit 7", () => {
    const s = setup(5, "dispossessed");
    execute(s, "start");
    let checked = 0;
    for (let i = 0; i < 20 && s.state === "battle"; i++) {
      if (s.battle!.phase === "attack" && actorId(s) === "me") {
        const scored = scoreAttacks({
          battle: s.battle!,
          actor: s.battle!.units.me!,
          targetId: "foe",
          persona: PERSONAS.dispossessed,
          heatCeiling: 30,
        });
        const front = suggestFireTargets(s.battle!, "me", "front").targets.find(
          (t) => t.targetId === "foe",
        );
        for (const c of scored.candidates) {
          const fire = c.commands.find((k) => k.startsWith("fire"));
          if (fire === undefined || c.commands.some((k) => k.startsWith("torso"))) continue;
          for (const idx of fire.split(" ").slice(2).map(Number)) {
            const w = front?.weapons.find((x) => x.weaponIndex === idx);
            if (w?.shots !== null && w?.shots !== undefined) expect(w.tn).toBeLessThanOrEqual(7);
            checked++;
          }
        }
      }
      pass(s);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("yields (ejects) at its threshold", () => {
    const s = setup(5, "dispossessed");
    execute(s, "start");
    // Strip the persona unit to 10% so the next movement prompt yields.
    const foe = s.battle!.units.foe!;
    for (const loc of Object.keys(foe.damage.armor) as (keyof typeof foe.damage.armor)[]) {
      foe.damage.armor[loc] = 0;
    }
    for (const loc of Object.keys(foe.damage.armorRear) as (keyof typeof foe.damage.armorRear)[]) {
      foe.damage.armorRear[loc] = 0;
    }
    const out: string[] = [];
    for (let i = 0; i < 6 && s.state === "battle"; i++) out.push(...pass(s));
    expect(out.join("\n")).toMatch(/yields: .*eject stands in/);
    expect(s.state).toBe("over");
  });
});

describe("persona player: full bout", () => {
  it("two personas finish a bout without errors", () => {
    const s = newSession(3);
    execute(s, "map quickstart");
    execute(s, "add a HBK-4G 9 9 n");
    execute(s, "add b WVR-6R 9 5 s");
    execute(s, "pp a alpha");
    execute(s, "pp b pitfighter");
    execute(s, "pp trace off");
    const out = execute(s, "start");
    expect(out.some((l) => l.startsWith("error:"))).toBe(false);
    expect(s.state).toBe("over");
  });
});

describe("persona player: pp setup", () => {
  it("builds a random 2-player setup: one unit per team, open hexes, a persona each", () => {
    const s = newSession(7);
    const dice = s.rng.snapshot();
    const out = execute(s, "pp setup 2");
    expect(out.at(-1)).toMatch(/random setup ready: 2 players, seed 7/);
    // It reports what it picked, without echoing CLI commands.
    expect(out[0]).toBe(
      `map ${s.setup.mapName}: ${mapDefFor(s.setup).width}x${mapDefFor(s.setup).height}`,
    );
    for (const u of s.setup.roster) {
      const persona = PERSONAS[s.persona.assignments[u.id]!].name;
      expect(out).toContain(
        `${u.id}: ${u.model} at (${u.position.col},${u.position.row}) facing ${u.facing}, team ${u.team}, persona ${persona}`,
      );
    }
    expect(out.some((l) => l.startsWith("setup >"))).toBe(false);
    expect(s.setup.mapName).not.toBeNull();
    expect(s.setup.roster.map((u) => u.team).sort()).toEqual([1, 2]);
    for (const u of s.setup.roster) {
      expect(s.persona.assignments[u.id]).toBeDefined();
    }
    const hexes = s.setup.roster.map((u) => `${u.position.col},${u.position.row}`);
    expect(new Set(hexes).size).toBe(2);
    // The battle dice are untouched by the setup draws.
    expect(s.rng.snapshot()).toBe(dice);
  });

  it("splits 4 players evenly and avoids water and buildings", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const s = newSession(seed);
      execute(s, "pp setup 4");
      expect(s.setup.roster).toHaveLength(4);
      expect(s.setup.roster.filter((u) => u.team === 1)).toHaveLength(2);
      expect(s.setup.roster.filter((u) => u.team === 2)).toHaveLength(2);
      const map = mapDefFor(s.setup);
      for (const u of s.setup.roster) {
        const t = map.terrain.find((h) => h.col === u.position.col && h.row === u.position.row);
        expect(t?.type ?? "clear").not.toMatch(/^water|Building$/);
        expect(u.position.col).toBeLessThanOrEqual(map.width);
        expect(u.position.row).toBeLessThanOrEqual(map.height);
      }
    }
  });

  it("is reproducible from the seed", () => {
    const roster = (seed: number) => {
      const s = newSession(seed);
      execute(s, "pp setup 4");
      return JSON.stringify([s.setup.mapName, s.setup.roster, s.persona.assignments]);
    };
    expect(roster(9)).toBe(roster(9));
    expect(roster(9)).not.toBe(roster(10));
  });

  it("refuses unless the setup is empty, and checks the player count", () => {
    const withMap = newSession(1);
    execute(withMap, "map quickstart");
    expect(execute(withMap, "pp setup 2")[0]).toMatch(/map quickstart is already loaded/);

    const withUnit = newSession(1);
    execute(withUnit, "add me HBK-4G 9 9 n");
    expect(execute(withUnit, "pp setup 2")[0]).toMatch(/1 unit\(s\) are already added/);

    const s = newSession(1);
    expect(execute(s, "pp setup 3")[0]).toMatch(/pp setup 2\|4/);
    expect(execute(s, "pp setup")[0]).toMatch(/pp setup 2\|4/);
    expect(s.setup.mapName).toBeNull();

    const inBattle = setup();
    execute(inBattle, "start");
    expect(execute(inBattle, "pp setup 2")[0]).toMatch(/setup phase only/);
  });

  it("random 4-player bouts play out without errors", () => {
    // Seed 1 used to be a 131-turn Long Tom stand-off; stall pressure ends it.
    for (const seed of [1, 2, 3]) {
      const s = newSession(seed);
      execute(s, "pp setup 4");
      execute(s, "pp trace off");
      const out = execute(s, "start");
      expect(out.filter((l) => l.startsWith("error:"))).toEqual([]);
      expect(out.some((l) => /failed; stopped/.test(l))).toBe(false);
      expect(s.state).toBe("over");
      expect(s.battle!.turn).toBeLessThanOrEqual(60);
    }
  });
});

describe("persona player: physical attacks", () => {
  /** A Hatchetman persona unit adjacent to the human's Hunchback. */
  function adjacent(seed = 5, persona = "pitfighter"): Session {
    const s = newSession(seed);
    execute(s, "map quickstart");
    execute(s, "add me HBK-4G 9 6 n");
    execute(s, "add foe HCT-5S 9 5 s");
    execute(s, `pp foe ${persona}`);
    execute(s, "pp trace off");
    execute(s, "start");
    return s;
  }

  function attacks(s: Session, persona: keyof typeof PERSONAS = "pitfighter") {
    return scoreAttacks({
      battle: s.battle!,
      actor: s.battle!.units.foe!,
      targetId: "me",
      persona: PERSONAS[persona],
      heatCeiling: PERSONAS[persona].heatCeiling,
    }).candidates;
  }

  it("weighs strikes, both punches and kicks when adjacent", () => {
    const labels = attacks(adjacent()).map((c) => c.label);
    expect(labels.some((l) => /strike (left|right) \(hatchet\)/.test(l))).toBe(true);
    expect(labels.some((l) => /punch left · punch right/.test(l))).toBe(true);
    expect(labels.some((l) => /kick (left|right)/.test(l))).toBe(true);
  });

  it("Never personas make no physical attacks", () => {
    const labels = attacks(adjacent(5, "longtom"), "longtom").map((c) => c.label);
    expect(labels.some((l) => /punch|kick|strike|club|pickup/.test(l))).toBe(false);
  });

  it("with a club in hand: swings it, and fires arm weapons only after a drop", () => {
    const s = adjacent();
    const foe = s.battle!.units.foe!;
    foe.club = { kind: "girder" };
    const def = mechDefFor(foe);
    const candidates = attacks(s);
    expect(candidates.some((c) => c.commands.includes("club me"))).toBe(true);
    for (const c of candidates) {
      const fire = c.commands.find((k) => k.startsWith("fire"));
      if (fire === undefined) continue;
      const arm = fire
        .split(" ")
        .slice(2)
        .some((i) => isArm(def.weapons[Number(i)]!.location));
      if (arm) expect(c.commands).toContain("drop");
    }
  });

  it("charges or DFAs the target from movement (physical-biased personas only)", () => {
    const bout = (persona: string) => {
      const s = newSession(3);
      execute(s, "map quickstart");
      execute(s, "add a HBK-4G 9 9 n");
      execute(s, "add b WVR-6R 9 5 s");
      execute(s, "pp a alpha");
      execute(s, `pp b ${persona}`);
      execute(s, "pp trace off");
      const out = execute(s, "start");
      expect(out.filter((l) => l.startsWith("error:"))).toEqual([]);
      return out.join("\n");
    };
    expect(bout("pitfighter")).toMatch(/charges a and stops|leaps at a/);
    expect(bout("jumpjockey")).not.toMatch(/charges a and stops|leaps at a/);
  });

  it("melee persona bouts play out without errors", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const s = newSession(seed);
      execute(s, "pp setup 4");
      for (const id of Object.keys(s.persona.assignments)) {
        s.persona.assignments[id] = seed % 2 === 0 ? "pitfighter" : "gladiator";
      }
      execute(s, "pp trace off");
      const out = execute(s, "start");
      expect(out.filter((l) => l.startsWith("error:"))).toEqual([]);
      expect(out.some((l) => /failed; stopped/.test(l))).toBe(false);
      expect(s.state).toBe("over");
    }
  });
});

describe("autoplay", () => {
  const mechDefFor = mechDefForSrc;
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
});
