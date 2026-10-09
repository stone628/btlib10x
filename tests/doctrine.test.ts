import { suggestFireTargets } from "btlib10x";
import { describe, expect, it } from "vitest";
import { decide } from "../web/doctrine";
import { scoreAttacks } from "../web/doctrine.attack";
import { DOCTRINES } from "../web/doctrine.data";
import { newSession, type Session } from "../web/session";
import { execute } from "./helpers";

/** HBK by hand vs. a doctrine WVR, both well inside each other's range. */
function setup(seed = 5, doctrine = "jumpjockey"): Session {
  const s = newSession(seed);
  execute(s, "map quickstart");
  execute(s, "add me HBK-4G 9 9 n");
  execute(s, "add foe WVR-6R 9 5 s");
  execute(s, `dp foe ${doctrine}`);
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

describe("doctrine player: assignment", () => {
  it("assigns in setup only and keeps the doctrine out of the unit data", () => {
    const s = setup();
    expect(execute(s, "dp")).toContain("  foe: Jump Jockey");
    expect(s.setup.roster.find((u) => u.id === "foe")).not.toHaveProperty("doctrine");
    expect(execute(s, "dp foe sniper")[0]).toMatch(/unknown doctrine/);
    expect(execute(s, "dp ghost alpha")[0]).toMatch(/ghost/);
    execute(s, "start");
    expect(execute(s, "dp me alpha")[0]).toMatch(/setup only/);
  });

  it("plays only doctrine prompts and leaves the human prompt to the human", () => {
    const s = setup();
    execute(s, "start");
    // Whatever the initiative, after start the prompt belongs to the human.
    expect(s.state).toBe("battle");
    expect(actorId(s)).toBe("me");
  });
});

describe("doctrine player: decisions", () => {
  it("shows its reasoning in the attack-resolution box and types its commands", () => {
    const s = setup();
    const out = [...execute(s, "start"), ...pass(s)].join("\n");
    expect(out).toMatch(/\[foe -> me\]/);
    expect(out).toMatch(/doctrine Jump Jockey · posture/);
    expect(out).toMatch(/#1 .* = /);
    expect(out).toMatch(/chose #1/);
    expect(out).toMatch(/> done/);
    expect(s.doctrine.lastTrace.foe).toBeDefined();
  });

  it("never touches the battle dice while deciding", () => {
    const s = setup();
    execute(s, "start");
    if (s.battle!.phase === "movement") execute(s, "mode standstill");
    execute(s, "done");
    // Seed 5: one rollback lands on the doctrine's move prompt (rollback does not auto-play).
    execute(s, "rollback");
    expect(actorId(s)).toBe("foe");
    const dice = s.rng.snapshot();
    const own = s.doctrine.rng;
    expect(decide(s)).not.toBeNull();
    expect(s.rng.snapshot()).toBe(dice);
    expect(s.doctrine.rng).toBe(own);
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

  it("rollback restores its context, waits, and 'dp go' replays the same decision", () => {
    const s = setup();
    execute(s, "start");
    pass(s);
    const trace = s.doctrine.lastTrace.foe;
    expect(trace).toBeDefined();
    // Seed 5: the human moves first, so one rollback lands on the doctrine's move prompt.
    const out = execute(s, "rollback");
    expect(actorId(s)).toBe("foe");
    expect(out.join("\n")).toMatch(/dp go/);
    const replayed = execute(s, "dp go").join("\n");
    expect(replayed).toMatch(/\[foe/);
    expect(s.doctrine.lastTrace.foe?.commands).toEqual(trace?.commands);
  });
});

describe("doctrine player: discipline", () => {
  it("a Cold doctrine never plans a volley past its heat ceiling", () => {
    const s = setup(5, "dispossessed");
    execute(s, "start");
    let attacks = 0;
    for (let i = 0; i < 16 && s.state === "battle"; i++) {
      const t = s.doctrine.lastTrace.foe;
      if (t?.phase === "attack") {
        attacks++;
        expect(t.heatCeiling).toBe(DOCTRINES.dispossessed.heatCeiling);
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
          doctrine: DOCTRINES.dispossessed,
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
    // Strip the doctrine unit to 10% so the next movement prompt yields.
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

describe("doctrine player: full bout", () => {
  it("two doctrines finish a bout without errors", () => {
    const s = newSession(3);
    execute(s, "map quickstart");
    execute(s, "add a HBK-4G 9 9 n");
    execute(s, "add b WVR-6R 9 5 s");
    execute(s, "dp a alpha");
    execute(s, "dp b pitfighter");
    execute(s, "dp trace off");
    const out = execute(s, "start");
    expect(out.some((l) => l.startsWith("error:"))).toBe(false);
    expect(s.state).toBe("over");
  });
});
