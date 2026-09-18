import { describe, expect, it } from "vitest";
import * as S from "../web/session.js";
import { execute } from "./helpers.js";

function run(s: S.Session, cmd: string): string[] {
  return execute(s, cmd);
}

function started(): S.Session {
  const s = S.newSession(7);
  s.critsDisabled = true;
  expect(run(s, "map quickstart")[0]).toContain("15x16");
  expect(run(s, "add hunchy HBK-4G 9 9 n")).toHaveLength(1);
  expect(run(s, "add cicada HBK-4G 9 8 s")).toHaveLength(1);
  run(s, "start");
  return s;
}

/** Drain the movement phase by walking in place until weapon phase opens.
 *  Two units → two movement activations per round; cap iterations to break
 *  any inadvertent loop. */
function burnMovePhase(s: S.Session): void {
  let guard = 0;
  while (s.app === "battle" && s.battle!.phase === "movement") {
    S.declareMode(s, "walk");
    S.commitMove(s);
    if (++guard > 64) throw new Error("burnMovePhase did not advance");
  }
}

/** Drive a session to `app === "over"` by ejecting both units. Bounded. */
function driveToOver(s: S.Session): void {
  let guard = 0;
  while (s.app === "battle") {
    if (++guard > 200) throw new Error("driveToOver did not finish");
    if (s.battle!.phase === "movement") {
      // Eject whoever's acting this turn.
      S.declareMode(s, "eject");
      try {
        S.commitMove(s);
      } catch {
        // Some units can't eject (already ejected). Skip the round.
        S.commitMove(s);
      }
    } else {
      // Pass through attack phase.
      run(s, "done");
    }
  }
}

describe("per-AppState context invariants", () => {
  it("setup: all per-phase contexts are null, only setup populated", () => {
    const s = S.newSession(42);
    expect(s.move).toBeNull();
    expect(s.attack).toBeNull();
    expect(s.over).toBeNull();
    expect(s.battle).toBeNull();
    expect(s.setup.roster).toEqual([]);
  });

  it("battle + movement: move allocated, attack null, over null", () => {
    const s = started();
    expect(s.app).toBe("battle");
    expect(s.battle!.phase).toBe("movement");
    expect(s.move).not.toBeNull();
    expect(s.attack).toBeNull();
    expect(s.over).toBeNull();
    expect(s.move!.actorId).toBe(S.currentActor(s)!.id);
  });

  it("battle + attack: move null, attack allocated with torsoTwist front, over null", () => {
    const s = started();
    burnMovePhase(s);
    expect(s.battle!.phase).toBe("weaponAttack");
    expect(s.move).toBeNull();
    expect(s.attack).not.toBeNull();
    expect(s.over).toBeNull();
    expect(s.attack!.torsoTwist).toBe("front");
    expect(s.attack!.fireDecls).toEqual([]);
  });

  it("over: move null, attack null, over populated with victory", () => {
    const s = S.newSession(42);
    s.critsDisabled = true;
    run(s, "map quickstart");
    run(s, "add a HBK-4G 5 5 n");
    run(s, "add b HBK-4G 6 5 s");
    run(s, "start");
    driveToOver(s);
    expect(s.app).toBe("over");
    expect(s.over).not.toBeNull();
    expect(s.move).toBeNull();
    expect(s.attack).toBeNull();
    expect(s.over!.victory).toBeDefined();
  });

  it("phase transition reallocates the active context; inactive side stays null", () => {
    const s = started();
    const moveBefore = s.move;
    burnMovePhase(s);
    expect(s.battle!.phase).toBe("weaponAttack");
    expect(s.move).toBeNull();
    expect(s.attack).not.toBeNull();
    expect(moveBefore).not.toBe(s.attack);
  });

  it("actor change inside the same phase reallocates the context", () => {
    const s = started();
    const firstActor = s.move!.actorId;
    burnMovePhase(s);
    expect(s.attack).not.toBeNull();
    const firstAttackActor = s.attack!.actorId;
    // Pass-fire hands off to cicada's attack activation: same phase, new actor.
    run(s, "done");
    expect(s.battle!.phase).toBe("weaponAttack");
    expect(s.attack).not.toBeNull();
    expect(firstAttackActor).not.toBe(s.attack!.actorId);
    expect(s.attack!.torsoTwist).toBe("front");
    expect(firstActor).not.toBe(s.attack!.actorId);
  });

  it("declareMode throws when not in movement phase", () => {
    const s = started();
    burnMovePhase(s);
    expect(s.battle!.phase).toBe("weaponAttack");
    expect(() => S.declareMode(s, "walk")).toThrow(/requires the movement phase/i);
  });

  it("setTorsoTwist throws when not in weaponAttack phase", () => {
    const s = started();
    expect(s.battle!.phase).toBe("movement");
    expect(() => S.setTorsoTwist(s, "left")).toThrow(/requires the weaponAttack phase/i);
  });

  it("fresh attack context always starts with torsoTwist: front", () => {
    const s = started();
    burnMovePhase(s);
    const firstAttackActor = s.attack!.actorId;
    expect(s.attack!.torsoTwist).toBe("front");
    run(s, "torso right");
    expect(s.attack!.torsoTwist).toBe("rightSide");
    // Pass-fire on first attacker advances to next activation; twist should
    // reset whenever a fresh attack context is allocated.
    run(s, "done");
    expect(s.battle!.phase).toBe("weaponAttack");
    expect(s.attack).not.toBeNull();
    // Either the same actor across rounds (fresh twist) or a different actor
    // (also fresh twist): in both cases torsoTwist must equal "front".
    if (s.attack!.actorId === firstAttackActor) {
      expect(s.attack!.torsoTwist).toBe("front");
    } else {
      expect(s.attack!.torsoTwist).toBe("front");
    }
  });

  it("commit rollback preserves the move context only", () => {
    const s = started();
    const actor = S.currentActor(s)!.id;
    run(s, "mode walk");
    s.move!.moveSteps = [{ kind: "enter", to: { col: 1, row: 1 } }];
    const out = run(s, "done");
    expect(out[0]).toMatch(/^error:/);
    expect(s.move).not.toBeNull();
    expect(s.move!.actorId).toBe(actor);
    expect(s.move!.moveSteps).toHaveLength(1);
  });
});
