import { describe, expect, it } from "vitest";
import { getMechDefFor } from "../src/data/index.js";
import { nextAutoPlayCommand } from "../web/autoplay.js";
import * as S from "../web/session.js";
import { execute } from "./helpers.js";

function run(s: S.Session, cmd: string): string[] {
  return execute(s, cmd);
}

/**
 * Build a two-unit battle and drive it into the weapon attack phase (both
 * units have moved), returning the session. The current actor is whoever
 * acts next in the weapon attack phase.
 */
function sessionAtWeaponAttack(): S.Session {
  const s = S.newSession(7);
  s.critsDisabled = true;
  run(s, "map quickstart");
  run(s, "add hunchy HBK-4G 0 4 9 9 n");
  run(s, "add cicada CDA-3MA 1 4 9 8 s");
  run(s, "start");
  // Movement phase: both units move (walk), advancing to weapon attack.
  for (let i = 0; i < 2; i++) {
    if (s.battle!.phase === "movement") {
      S.declareMode(s, "walk");
      S.commitMove(s);
    }
  }
  return s;
}

describe("nextAutoPlayCommand (autoplay demo driver)", () => {
  it("omits weapons destroyed by a critical slot hit from the fire command", () => {
    const s = sessionAtWeaponAttack();
    expect(s.battle!.phase).toBe("weaponAttack");

    const actor = S.currentActor(s)!;
    const def = getMechDefFor(actor);
    // Find a plain (non-ammo) weapon mount on the acting unit and mark it
    // destroyed, simulating a prior-turn critical-slot hit.
    const target = Object.entries(def.weapons).find(([, m]) => m.shots === undefined);
    expect(target, "acting unit should have a non-ammo weapon").toBeDefined();
    const destroyedIndex = Number(target![0]);
    actor.destroyedWeapons.push(destroyedIndex);

    const cmds = [nextAutoPlayCommand(s), nextAutoPlayCommand(s)].filter(
      (c): c is string => c !== null && c !== "help",
    );
    const cmd = cmds[cmds.length - 1];
    expect(cmd).toMatch(/^fire /);
    const indexes = cmd!
      .replace(/^fire \S+\s*/, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    expect(indexes).not.toContain(destroyedIndex);
  });
});
