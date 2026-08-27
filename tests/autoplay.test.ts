import { describe, expect, it } from "vitest";
import { AUTOPLAY_INTERVAL_MS, nextAutoPlayCommand } from "../web/autoplay.js";
import * as S from "../web/session.js";
import { execute } from "./helpers.js";

/** Feed generated commands through the CLI until the script runs dry. */
function playThrough(s: S.Session, maxCommands = 500): void {
  for (let i = 0; i < maxCommands; i++) {
    const command = nextAutoPlayCommand(s);
    if (command === null) return;
    execute(s, command);
    s.lastAutoPlayCmd = command;
  }
  throw new Error("autoplay did not settle within budget");
}

describe("autoplay", () => {
  it("defaults to a 0.5s cadence", () => {
    expect(AUTOPLAY_INTERVAL_MS).toBe(500);
  });

  it("scripts setup from scratch, starting with reset semantics", () => {
    const s = S.newSession(7);
    // The driver assumes a blank slate; 'reset' (typed by the user first)
    // guarantees one regardless of prior state.
    execute(s, "reset");
    expect(nextAutoPlayCommand(s)).toBe("map test");
    execute(s, "map test");
    s.lastAutoPlayCmd = "map test";
    expect(nextAutoPlayCommand(s)).toBe("add hunchy HBK-4G 0 4 3 4 ne");
    execute(s, "add hunchy HBK-4G 0 4 3 4 ne");
    s.lastAutoPlayCmd = "add hunchy HBK-4G 0 4 3 4 ne";
    expect(nextAutoPlayCommand(s)).toBe("add cicada CDA-3MA 1 4 5 3 sw");
    execute(s, "add cicada CDA-3MA 1 4 5 3 sw");
    s.lastAutoPlayCmd = "add cicada CDA-3MA 1 4 5 3 sw";
    expect(nextAutoPlayCommand(s)).toBe("start");
    execute(s, "start");
    s.lastAutoPlayCmd = "start";
    expect(nextAutoPlayCommand(s)).toBe("board");
    expect(s.app).toBe("battle");
  });

  it("drives a full battle to victory using only generated commands", () => {
    const s = S.newSession(7);
    execute(s, "reset");
    playThrough(s);
    expect(s.app).toBe("over");
    expect(s.victory).not.toBeNull();
  });

  it("replays deterministically for a fixed seed", () => {
    const transcript = (): string[] => {
      const s = S.newSession(7);
      execute(s, "reset");
      playThrough(s);
      return s.battle!.events.flatMap((e) =>
        e.kind === "attackResolved"
          ? [`${e.unitId}:${e.resolution.weapon}:${e.resolution.toHitRoll}:${e.resolution.hit}`]
          : [],
      );
    };
    expect(transcript()).toEqual(transcript());
  });
});
