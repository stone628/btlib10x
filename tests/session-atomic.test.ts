import { describe, expect, it } from "vitest";
import * as S from "../web/session.js";
import { execute, scriptedRng } from "./helpers.js";

function run(s: S.Session, cmd: string): string[] {
  return execute(s, cmd);
}

/** Started quickstart battle; returns session plus acting-unit id. */
function started(piloting?: number): { s: S.Session; actor: string } {
  const s = S.newSession(7);
  s.critsDisabled = true;
  expect(run(s, "map quickstart")[0]).toContain("15x16");
  const pilotArg = piloting === undefined ? "" : ` ${piloting}`;
  expect(run(s, `add hunchy HBK-4G 9 9 n${pilotArg}`)).toHaveLength(1);
  expect(run(s, `add cicada HBK-4G 9 8 s${pilotArg}`)).toHaveLength(1);
  expect(run(s, "start")[0]).toContain("BATTLE STARTED");
  return { s, actor: S.currentActor(s)!.id };
}

/** Drain the movement phase by walking in place until the weapon phase opens. */
function burnMovePhase(s: S.Session): void {
  while (s.app === "battle" && s.battle!.phase === "movement") {
    S.declareMode(s, "walk");
    S.commitMove(s);
  }
}

describe("commitAtomic rollback", () => {
  it("failed standup+move restores battle, rng, and session buffers", () => {
    const { s, actor } = started(4);
    s.battle!.units[actor]!.prone = true;
    run(s, "mode standup");
    expect(s.move!.moveMode).toBe("standup");

    const heatBefore = s.battle!.units[actor]!.heat;
    const rng = scriptedRng(6, 6, 6, 6);
    s.rng = rng;
    const rngSnap = rng.snapshot();
    // Illegal enter step: attemptStandUp draws 2D6 first, then executeMove
    // throws, so the commit consumed rng before failing.
    s.move!.moveSteps = [{ kind: "enter", to: { col: 0, row: 0 } }];

    expect(() => S.commitMove(s)).toThrow(/Standing still forbids entering hexes/);

    // Rng rewound: retry sees identical sequence.
    expect(rng.snapshot()).toBe(rngSnap);
    expect(rng.remaining()).toBe(4);
    // Battle rewound: standup effects (prone cleared, heat) gone; no log stored.
    expect("events" in s.battle!).toBe(false);
    expect(s.battle!.units[actor]!.prone).toBe(true);
    expect(s.battle!.units[actor]!.heat).toBe(heatBefore);
    expect(s.battle!.units[actor]!.mpSpent).toBe(0);
    expect(s.battle!.units[actor]!.declaredAttacks ?? []).toEqual([]);
    // Session buffers preserved: declaration intact, actor still current.
    expect(s.move!.moveMode).toBe("standup");
    expect(s.move!.moveSteps).toHaveLength(1);
    expect(s.move!.actorId).toBe(actor);

    // Retry with legal (empty) steps succeeds on identical rolls and returns
    // the live battle object.
    s.move!.moveSteps = [];
    const res = S.commitMove(s);
    expect(res.state).toBe(s.battle);
    expect(res.newEvents.length).toBeGreaterThan(0);
    expect(s.battle!.units[actor]!.prone).toBe(false);
    expect(rng.remaining()).toBe(2);
  });

  it("failed commitFire mid-resolution restores battle, rng, and session", () => {
    const { s } = started();
    burnMovePhase(s);
    expect(s.battle!.phase).toBe("weaponAttack");
    const first = S.currentActor(s)!.id;
    const firstTarget = first === "hunchy" ? "cicada" : "hunchy";
    // First unit declares + commits: rival still pending, so drive resolves
    // nothing and draws no rng.
    expect(run(s, `fire ${firstTarget} 1`)[0]).toContain("queued");
    expect(run(s, `fire ${firstTarget} 2`)[0]).toContain("queued");
    run(s, "done");
    const attacker = S.currentActor(s)!.id;
    const target = attacker === "hunchy" ? "cicada" : "hunchy";
    // Two ammo-free medium lasers (CLI weapon numbers are 1-based: HBK-4G
    // weapons 1+2 are the arm medium lasers): declaration draws no rng.
    expect(run(s, `fire ${target} 1`)[0]).toContain("queued");
    expect(run(s, `fire ${target} 2`)[0]).toContain("queued");

    const damageBefore = structuredClone(s.battle!.units[target]!.damage);
    // Per hitting laser: to-hit 2D6 + location 2D6. Script covers three full
    // lasers (all CT hits, TN hit) plus one to-hit die; the fourth laser's
    // second to-hit die hits the exhausted script after partial battle
    // mutation (damage applied, buffers cleared, actor nulled).
    const rng = scriptedRng(6, 6, 3, 4, 6, 6, 3, 4, 6, 6, 3, 4, 6);
    s.rng = rng;
    const rngSnap = rng.snapshot();

    expect(() => S.commitFire(s)).toThrow(/RNG script exhausted/);

    expect(rng.snapshot()).toBe(rngSnap);
    expect(rng.remaining()).toBe(13);
    expect(s.battle!.units[target]!.damage).toEqual(damageBefore);
    expect(s.battle!.units[attacker]!.declaredAttacks).toEqual([]);
    // First unit committed successfully before the scripted rng was
    // installed: its declarations predate the snapshot and survive.
    expect(s.battle!.units[first]!.declaredAttacks).toHaveLength(2);
    expect(s.attack!.actorId).toBe(attacker);
    expect(s.attack!.fireDecls).toHaveLength(2);
    expect(s.attack!.torsoTwist).toBe("front");
  });

  it("successful commits return the live battle object", () => {
    const { s } = started();
    const actor = S.currentActor(s)!.id;
    S.declareMode(s, "walk");
    const res = S.commitMove(s);
    expect(res.state).toBe(s.battle);
    expect(res.newEvents.length).toBeGreaterThan(0);
    expect(res.newEvents.some((e) => e.kind === "moveDeclared")).toBe(true);
    expect(S.currentActor(s)?.id).not.toBe(actor);
  });
});
