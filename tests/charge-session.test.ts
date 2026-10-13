/**
 * Charge / DFA through the CLI session: `place` onto an enemy hex, the
 * attacker skipping attack input, the physical-phase log, and replay.
 */
import { describe, expect, it } from "vitest";
import { nextAutoPlayCommand, resetAutoplayState } from "../web/terminal/autoplay";
import { replayPlayer } from "../web/terminal/replay";
import { newSession, type Session } from "../web/terminal/session";
import { currentActor, execute } from "./helpers";

/** Drive until `stop` says so, running `commands(actorId, phase, turn)`. */
function drive(
  s: Session,
  commands: (actor: string, phase: "movement" | "attack", turn: number) => string[] | undefined,
  out: string[],
  maxSteps = 200,
): void {
  for (let i = 0; i < maxSteps && s.state === "battle"; i++) {
    const battle = s.battle!;
    const phase = battle.phase === "attack" ? "attack" : "movement";
    const actor = currentActor(s)?.id;
    if (actor === undefined) break;
    const cmds =
      commands(actor, phase, battle.turn) ??
      (phase === "attack" ? ["done"] : ["mode standstill", "done"]);
    for (const cmd of cmds) out.push(...execute(s, cmd));
    if (battle.turn > 1) break;
  }
}

function session(setup: string[], seed = 42): Session {
  const s = newSession(seed);
  execute(s, "map quickstart");
  for (const cmd of setup) execute(s, cmd);
  execute(s, "start");
  return s;
}

describe("charge through the CLI", () => {
  it("place onto the enemy hex declares a charge; the charger gets no attack turn", () => {
    const s = session(["add enf ENF-4R 9 11 n", "add hct HCT-5S 9 9 s"]);
    const out: string[] = [];
    const attackers: string[] = [];
    drive(
      s,
      (actor, phase) => {
        if (phase === "attack") attackers.push(actor);
        return actor === "enf" && phase === "movement"
          ? ["mode walk", "place 9 9 n", "done"]
          : undefined;
      },
      out,
    );
    const text = out.join("\n");
    expect(text).toMatch(/charge: ends against hct/);
    expect(text).toMatch(/charges hct and stops in front of it/);
    expect(text).toMatch(/charge: enf -> hct/);
    expect(attackers).not.toContain("enf");
    expect(attackers).toContain("hct");
    expect(s.battle!.units.enf!.position).toEqual({ col: 9, row: 10 });
    // The record replays: the move line ends against the enemy hex, and the
    // charger has no attack record.
    // The record replays up to the unfinished game's missing result line.
    expect(() => replayPlayer(s.replay!.lines.join("\n"))).toThrow(/ends before its W line/);
    const attackLines = s.replay!.lines.filter((l) => l.startsWith("A"));
    expect(attackLines.length).toBe(1);
  });

  it("a jump onto the enemy hex declares a DFA", () => {
    const s = session(["add enf ENF-4R 9 11 n", "add hct HCT-5S 9 9 s"]);
    const out: string[] = [];
    drive(
      s,
      (actor, phase) =>
        actor === "enf" && phase === "movement" ? ["mode jump", "place 9 9 n", "done"] : undefined,
      out,
    );
    const text = out.join("\n");
    expect(text).toMatch(/DFA: leaps at hct/);
    expect(text).toMatch(/dfa: enf -> hct/);
    expect(s.battle!.units.enf!.position.row).not.toBe(9);
    // The record replays up to the unfinished game's missing result line.
    expect(() => replayPlayer(s.replay!.lines.join("\n"))).toThrow(/ends before its W line/);
  });

  it.each([
    ["charge", "mode walk"],
    ["DFA", "mode jump"],
  ])("a whole match with a %s replays and verifies", (_name, mode) => {
    const s = session(["add enf ENF-4R 9 11 n", "add hct HCT-5S 9 9 s"], 7);
    drive(
      s,
      (actor, phase) =>
        actor === "enf" && phase === "movement" ? [mode, "place 9 9 n", "done"] : undefined,
      [],
    );
    resetAutoplayState(s);
    for (let i = 0; i < 6000 && s.state !== "over"; i++) {
      const cmd = nextAutoPlayCommand(s);
      if (cmd === null) break;
      execute(s, cmd);
    }
    expect(s.state).toBe("over");
    expect(() => replayPlayer(s.replay!.lines.join("\n"))).not.toThrow();
  });
});
