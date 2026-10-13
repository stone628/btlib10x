import { describe, expect, it } from "vitest";
import { nextAutoPlayCommand, resetAutoplayState } from "../web/terminal/autoplay";
import { MAX_SNAPSHOT_COUNT } from "../web/terminal/rollback";
import { newSession, type Session } from "../web/terminal/session";
import { execute } from "./helpers";

function battle(seed = 5): Session {
  const s = newSession(seed);
  execute(s, "map quickstart");
  execute(s, "add me HBK-4G 9 9 n");
  execute(s, "add foe WVR-6R 9 5 s");
  execute(s, "start");
  return s;
}

/** Complete the current actor's activation with a plain stand-still / pass. */
function finishActivation(s: Session): void {
  if (s.battle!.phase === "movement") execute(s, "mode standstill");
  execute(s, "done");
}

function fingerprint(s: Session): string {
  return JSON.stringify({
    state: s.state,
    battle: s.battle,
    move: s.move,
    attack: s.attack,
    over: s.over,
    rng: s.rng.snapshot(),
    replay: s.replay?.lines.length,
  });
}

describe("rollback", () => {
  it("undoes the last completed done and restores state and dice", () => {
    const s = battle();
    const before = fingerprint(s);
    finishActivation(s);
    expect(fingerprint(s)).not.toBe(before);
    expect(execute(s, "rollback")[0]).toMatch(/rolled back/);
    expect(fingerprint(s)).toBe(before);
  });

  it("declarations and failed commands add no snapshot", () => {
    const s = battle();
    finishActivation(s); // snapshot 2
    const mid = fingerprint(s);
    execute(s, "mode walk");
    execute(s, "place 99 99 n"); // fails
    execute(s, "cancel");
    execute(s, "rollback"); // back to snapshot 1, not to `mid`
    expect(fingerprint(s)).not.toBe(mid);
    expect(execute(s, "rollback")[0]).toMatch(/nothing to roll back/);
  });

  it("is unavailable in setup and with a single snapshot", () => {
    const setup = newSession(1);
    expect(execute(setup, "rollback")[0]).toMatch(/not available in this phase/);
    const s = battle();
    expect(execute(s, "rollback")[0]).toMatch(/nothing to roll back/);
  });

  it("keeps at most MAX_SNAPSHOT_COUNT snapshots", () => {
    const s = battle();
    for (let i = 0; i < MAX_SNAPSHOT_COUNT + 4 && s.state === "battle"; i++) finishActivation(s);
    expect(s.state).toBe("battle");
    let ok = 0;
    while (!/nothing to roll back/.test(execute(s, "rollback")[0]!)) ok++;
    expect(ok).toBe(MAX_SNAPSHOT_COUNT - 1);
  });

  it("from game over returns to the last battle prompt, and the end replays identically", () => {
    const s = newSession(5);
    resetAutoplayState(s);
    for (let i = 0; i < 2000 && s.state !== "over"; i++) {
      const cmd = nextAutoPlayCommand(s);
      if (cmd === null) break;
      execute(s, cmd);
    }
    expect(s.state).toBe("over");
    const winner = s.over!.victory;
    const lines = s.replay!.lines.length;
    execute(s, "rollback");
    expect(s.state).toBe("battle");
    expect(s.over).toBeNull();
    // Re-issue the commands that ended the game: same dice, same result.
    for (let i = 0; i < 20 && s.state === "battle"; i++) {
      const cmd = nextAutoPlayCommand(s);
      if (cmd === null) break;
      execute(s, cmd);
    }
    expect(s.state).toBe("over");
    expect(s.over!.victory).toEqual(winner);
    expect(s.replay!.lines.length).toBe(lines);
  });

  it("reset and rematch clear the history", () => {
    const s = battle();
    finishActivation(s);
    execute(s, "reset !");
    expect(execute(s, "rollback")[0]).toMatch(/not available in this phase/);
  });
});
