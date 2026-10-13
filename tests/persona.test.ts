import { isArm, mapDefFor, mechDefFor, suggestFireTargets } from "btlib10x";
import { describe, expect, it } from "vitest";
import { decide } from "../web/terminal/persona";
import { scoreAttacks } from "../web/terminal/persona.attack";
import { rangeProfile } from "../web/terminal/persona.common";
import { PERSONAS } from "../web/terminal/persona.data";
import { scoreMoves } from "../web/terminal/persona.move";
import { newSession, type Session } from "../web/terminal/session";
import { execute } from "./helpers";

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
    for (const seed of [1, 2, 3]) {
      const s = newSession(seed);
      execute(s, "pp setup 4");
      execute(s, "pp trace off");
      const out = execute(s, "start");
      expect(out.filter((l) => l.startsWith("error:"))).toEqual([]);
      expect(out.some((l) => /failed; stopped/.test(l))).toBe(false);
      expect(s.state).toBe("over");
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
