import { describe, expect, it } from "vitest";
import {
  commitMovement,
  declareMovementMode,
  newSession,
  requireMovementActor,
  type Session,
  setTorsoTwist,
} from "../web/session";
import { disableCritical, execute } from "./helpers";

function started(): { s: Session; actor: string } {
  const s = newSession(7);
  expect(execute(s, "map quickstart")[0]).toContain("15x16");
  expect(execute(s, "add hunchy HBK-4G 9 9 n")).toHaveLength(1);
  expect(execute(s, "add cicada HBK-4G 9 8 s")).toHaveLength(1);
  expect(execute(s, "start")[0]).toContain("BATTLE STARTED");
  disableCritical(s);
  return { s, actor: requireMovementActor(s).id };
}

/** Drain the movement phase by walking in place until weapon phase opens.
 *  Two units → two movement activations per round; cap iterations to break
 *  any inadvertent loop. */
function burnMovePhase(s: Session): void {
  let guard = 0;
  while (s.state === "battle" && s.battle!.phase === "movement") {
    declareMovementMode(s, "walk");
    commitMovement(s);
    if (++guard > 64) throw new Error("burnMovePhase did not advance");
  }
}

/** Drive a session to `app === "over"` by ejecting both units. Bounded. */
function driveToOver(s: Session): void {
  let guard = 0;
  while (s.state === "battle") {
    if (++guard > 200) throw new Error("driveToOver did not finish");
    if (s.battle!.phase === "movement") {
      // Eject whoever's acting this turn.
      declareMovementMode(s, "eject");
      try {
        commitMovement(s);
      } catch {
        // Some units can't eject (already ejected). Skip the round.
        commitMovement(s);
      }
    } else {
      // Pass through attack phase.
      execute(s, "done");
    }
  }
}

describe("per-AppState context invariants", () => {
  it("setup: all per-phase contexts are null, only setup populated", async () => {
    const s = newSession(42);
    expect(s.move).toBeNull();
    expect(s.attack).toBeNull();
    expect(s.over).toBeNull();
    expect(s.battle).toBeNull();
    expect(s.setup.roster).toEqual([]);
  });

  it("battle + movement: move allocated, attack null, over null", async () => {
    const { s } = await started();
    expect(s.state).toBe("battle");
    expect(s.battle!.phase).toBe("movement");
    expect(s.move).not.toBeNull();
    expect(s.attack).toBeNull();
    expect(s.over).toBeNull();
    expect(s.move!.actorId).toBe(requireMovementActor(s).id);
  });

  it("battle + attack: move null, attack allocated with torsoTwist front, over null", async () => {
    const { s } = await started();
    burnMovePhase(s);
    expect(s.battle!.phase).toBe("attack");
    expect(s.move).toBeNull();
    expect(s.attack).not.toBeNull();
    expect(s.over).toBeNull();
    expect(s.attack!.torsoTwist).toBe("front");
    expect(s.attack!.weaponDecls).toEqual([]);
  });

  it("over: move null, attack null, over populated with victory", async () => {
    const s = newSession(42);
    execute(s, "map quickstart");
    execute(s, "add a HBK-4G 5 5 n");
    execute(s, "add b HBK-4G 6 5 s");
    execute(s, "start");
    disableCritical(s);
    await driveToOver(s);
    expect(s.state).toBe("over");
    expect(s.over).not.toBeNull();
    expect(s.move).toBeNull();
    expect(s.attack).toBeNull();
    expect(s.over!.victory).toBeDefined();
  });

  it("phase transition reallocates the active context; inactive side stays null", async () => {
    const { s } = await started();
    const moveBefore = s.move;
    burnMovePhase(s);
    expect(s.battle!.phase).toBe("attack");
    expect(s.move).toBeNull();
    expect(s.attack).not.toBeNull();
    expect(moveBefore).not.toBe(s.attack);
  });

  it("actor change inside the same phase reallocates the context", async () => {
    const { s } = await started();
    const firstActor = s.move!.actorId;
    burnMovePhase(s);
    expect(s.attack).not.toBeNull();
    const firstAttackActor = s.attack!.actorId;
    // Pass-fire hands off to cicada's attack activation: same phase, new actor.
    execute(s, "done");
    expect(s.battle!.phase).toBe("attack");
    expect(s.attack).not.toBeNull();
    expect(firstAttackActor).not.toBe(s.attack!.actorId);
    expect(s.attack!.torsoTwist).toBe("front");
    expect(firstActor).not.toBe(s.attack!.actorId);
  });

  it("declareMode throws when not in movement phase", async () => {
    const { s } = await started();
    burnMovePhase(s);
    expect(s.battle!.phase).toBe("attack");
    expect(() => declareMovementMode(s, "walk")).toThrow(/requires the movement phase/i);
  });

  it("setTorsoTwist throws when not in weaponAttack phase", async () => {
    const { s } = await started();
    expect(s.battle!.phase).toBe("movement");
    expect(() => setTorsoTwist(s, "leftSide")).toThrow(/requires the attack phase/i);
  });

  it("fresh attack context always starts with torsoTwist: front", async () => {
    const { s } = await started();
    burnMovePhase(s);
    const firstAttackActor = s.attack!.actorId;
    expect(s.attack!.torsoTwist).toBe("front");
    execute(s, "torso right");
    expect(s.attack!.torsoTwist).toBe("rightSide");
    // Pass-fire on first attacker advances to next activation; twist should
    // reset whenever a fresh attack context is allocated.
    execute(s, "done");
    expect(s.battle!.phase).toBe("attack");
    expect(s.attack).not.toBeNull();
    // Either the same actor across rounds (fresh twist) or a different actor
    // (also fresh twist): in both cases torsoTwist must equal "front".
    if (s.attack!.actorId === firstAttackActor) {
      expect(s.attack!.torsoTwist).toBe("front");
    } else {
      expect(s.attack!.torsoTwist).toBe("front");
    }
  });

  it("commit rollback preserves the move context only", async () => {
    const { s } = await started();
    const actor = requireMovementActor(s).id;
    execute(s, "mode walk");
    s.move!.moveSteps = [{ kind: "enter", to: { col: 1, row: 1 } }];
    const out = execute(s, "done");
    expect(out[0]).toMatch(/^error:/);
    expect(s.move).not.toBeNull();
    expect(s.move!.actorId).toBe(actor);
    expect(s.move!.moveSteps).toHaveLength(1);
  });
});
