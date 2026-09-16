import { describe, expect, it } from "vitest";
import { suggestFireTargets } from "../src/rules/fireability.js";
import * as S from "../web/session.js";
import { execute } from "./helpers.js";

function run(s: S.Session, cmd: string): string[] {
  return execute(s, cmd);
}

function freshSetup(): S.Session {
  const s = S.newSession(42);
  s.critsDisabled = true;
  expect(run(s, "map quickstart")[0]).toContain("15x16");
  // Place two HBK-4Gs adjacent along the n/s axis with the bodies facing each
  // other so the head-to-head shot is in the front arc; we move them into a
  // side-arc configuration for the torso tests below.
  expect(run(s, "add hunchy HBK-4G 9 9 n")).toHaveLength(1);
  expect(run(s, "add cicada CDA-3MA 9 8 s")).toHaveLength(1);
  return s;
}

/** Drain the movement phase by walking in place until the weapon phase opens. */
function burnMovePhase(s: S.Session): void {
  while (s.app === "battle" && s.battle!.phase === "movement") {
    S.declareMode(s, "walk");
    S.commitMove(s);
  }
}

/** Place hunchy facing north, cicada at bearing "ne" (rightSide arc). */
function sideArcSetup(): S.Session {
  const s = S.newSession(42);
  s.critsDisabled = true;
  expect(run(s, "map quickstart")[0]).toContain("15x16");
  // hunchy at (9,9) facing n; cicada at (10,8) — bearing "ne" → hunchy's
  // rightSide arc when twist is "front", and the front arc when twist=left.
  expect(run(s, "add hunchy HBK-4G 9 9 n")).toHaveLength(1);
  expect(run(s, "add cicada CDA-3MA 10 8 s")).toHaveLength(1);
  run(s, "start");
  return s;
}

describe("torso command", () => {
  it("defaults the twist to front at attack-phase entry", () => {
    const s = freshSetup();
    run(s, "start");
    burnMovePhase(s);
    expect(s.battle!.phase).toBe("weaponAttack");
    expect(s.torsoTwist).toBe("front");
  });

  it("rejects the torso command outside the weapon attack phase", () => {
    const s = freshSetup();
    run(s, "start");
    expect(s.battle!.phase).toBe("movement");
    expect(run(s, "torso left")[0]).toMatch(/^error:/);
    expect(s.torsoTwist).toBe("front");
  });

  it("accepts front|left|right and updates the session state", () => {
    const s = sideArcSetup();
    burnMovePhase(s);
    expect(run(s, "torso left")[0]).toMatch(/torso twisted to/);
    expect(s.torsoTwist).toBe("leftSide");
    expect(run(s, "torso right")[0]).toMatch(/torso twisted to/);
    expect(s.torsoTwist).toBe("rightSide");
    expect(run(s, "torso front")[0]).toMatch(/torso twisted to/);
    expect(s.torsoTwist).toBe("front");
  });

  it("reports when the twist is already in the requested direction", () => {
    const s = sideArcSetup();
    burnMovePhase(s);
    run(s, "torso left");
    const out = run(s, "torso left");
    expect(out[0]).toMatch(/already facing/);
  });

  it("rejects unknown direction words", () => {
    const s = sideArcSetup();
    burnMovePhase(s);
    expect(run(s, "torso back")[0]).toMatch(/^error:.*front, left, or right/);
  });

  it("locks once a fire command is queued", () => {
    const s = sideArcSetup();
    burnMovePhase(s);
    expect(run(s, "fire cicada 2")[0]).toContain("queued");
    expect(run(s, "torso left")[0]).toMatch(/^error:.*locked/);
    expect(s.torsoTwist).toBe("front");
  });

  it("unlocks again after cancel", () => {
    const s = sideArcSetup();
    burnMovePhase(s);
    run(s, "fire cicada 2");
    expect(run(s, "torso left")[0]).toMatch(/^error:.*locked/);
    expect(run(s, "cancel")[0]).toMatch(/cancelled/);
    expect(s.fireDecls).toEqual([]);
    expect(run(s, "torso left")[0]).toMatch(/torso twisted to/);
    expect(s.torsoTwist).toBe("leftSide");
  });

  it("auto-suggestion reflects the current twist", () => {
    const s = sideArcSetup();
    burnMovePhase(s);
    const baseSugg = suggestFireTargets(s.battle!, "hunchy", "front");
    const baseEnf = baseSugg.targets.find((t) => t.targetId === "cicada")!;
    // With twist front: only the right-arm Medium Laser (weapon 2) reaches
    // the cicada (rightSide arc of the body).
    expect(baseEnf.weapons.map((w) => w.weaponIndex)).toEqual([2]);

    run(s, "torso left");
    const twistSugg = suggestFireTargets(s.battle!, "hunchy", "leftSide");
    const twistEnf = twistSugg.targets.find((t) => t.targetId === "cicada")!;
    expect(twistEnf.weapons.map((w) => w.weaponIndex).sort()).toEqual([1, 2, 3, 4]);
  });

  it("renders the current twist in the auto-hint suggestion", () => {
    const s = sideArcSetup();
    burnMovePhase(s);
    // `torso left` clears fireCandidate, so the auto-hint regenerates and is
    // appended to the torso command's own output.
    const out = run(s, "torso left").join("\n");
    expect(out).toMatch(/torso twist:\s*left/);
  });

  it("renders twist: front in the auto-hint when untwisted", () => {
    const s = sideArcSetup();
    burnMovePhase(s);
    const out = run(s, "status").join("\n");
    expect(out).toMatch(/torso twist:\s*front/);
  });

  it("resets the twist when a new actor becomes current", () => {
    const s = sideArcSetup();
    burnMovePhase(s);
    run(s, "torso left");
    expect(s.torsoTwist).toBe("leftSide");
    // Queue a fire so hunchy's turn ends and cicada becomes current.
    expect(run(s, "fire cicada 2")[0]).toContain("queued");
    run(s, "done");
    expect(S.currentActor(s)!.id).toBe("cicada");
    expect(s.torsoTwist).toBe("front");
    // Cicada's own twist should also start at "front".
    expect(s.torsoTwist).toBe("front");
  });
});
