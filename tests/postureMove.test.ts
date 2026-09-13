import { describe, expect, it } from "vitest";
import { neighbor } from "../src/core/hex.js";
import { dropProne, executeMove, rollInitiativePhase } from "../src/rules/game.js";
import * as S from "../web/session.js";
import { createTestBattle, execute, scriptedRng } from "./helpers.js";

function run(s: S.Session, cmd: string): string[] {
  return execute(s, cmd);
}

/** Started quickstart battle; returns session plus acting-unit id. */
function started(piloting?: number, model = "HBK-4G"): { s: S.Session; actor: string } {
  const s = S.newSession(7);
  s.critsDisabled = true;
  expect(run(s, "map quickstart")[0]).toContain("15x16");
  const pilotArg = piloting === undefined ? "" : ` ${piloting}`;
  // NB: facing token before piloting per `add` arg parsing. Both units share
  // model + piloting so either initiative winner can run the script.
  expect(run(s, `add hunchy ${model} 0 4 9 9 n${pilotArg}`)).toHaveLength(1);
  expect(run(s, `add cicada ${model} 1 4 9 8 s${pilotArg}`)).toHaveLength(1);
  expect(run(s, "start")[0]).toContain("BATTLE STARTED");
  return { s, actor: S.currentActor(s)!.id };
}

function forceProne(s: S.Session, id: string): void {
  s.battle!.units[id]!.prone = true;
}

/** First candidate landing with actual steps (skips the in-place facing set). */
function steppedLanding(s: S.Session): { col: number; row: number; facing: string; spent: number } {
  const landings = s.moveCandidate!.revealed;
  const landing = landings.find((l) => l.path.length > 0)!;
  expect(landing).toBeDefined();
  const last = landing.path[landing.path.length - 1]!;
  return {
    col: landing.hex.col,
    row: landing.hex.row,
    facing: landing.facing,
    spent: last.totalMp,
  };
}

describe("posture-change then move", () => {
  it("mode drop is gone; bare mode standup defaults to standstill", () => {
    const { s } = started();
    expect(run(s, "mode drop")[0]).toMatch(/^error:/);
    forceProne(s, S.currentActor(s)!.id);
    expect(run(s, "mode standup foo")[0]).toMatch(/^error:/);
  });

  it("bare mode standup + done stands in place with no candidate map", () => {
    // Piloting 0 → PSR target 0 → auto-success, no RNG drawn.
    const { s, actor } = started(0);
    forceProne(s, actor);
    const from = { ...s.battle!.units[actor]!.position };
    const facing = s.battle!.units[actor]!.facing;
    run(s, "mode standup");
    expect(s.moveMode).toBe("standup");
    expect(s.postureMove).toBe("standStill");
    expect(s.moveCandidate).toBeNull();
    expect(run(s, "place 9 9 n")[0]).toMatch(/^error:/);
    run(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(false);
    expect(unit.position).toEqual(from);
    expect(unit.facing).toBe(facing);
    expect(unit.moveMode).toBe("walk");
    expect(unit.mpSpent).toBe(2);
  });

  it("mode prone + place crawls sharing one walk budget (drop 1 + 2 per hex)", () => {
    const { s, actor } = started();
    run(s, "mode prone");
    expect(s.moveMode).toBe("prone");
    expect(s.moveCandidate).not.toBeNull();
    const target = steppedLanding(s);
    run(s, `place ${target.col} ${target.row} ${target.facing}`);
    // All-6s RNG: every terrain-entry PSR succeeds (12 always succeeds).
    s.rng = scriptedRng(...Array.from({ length: 40 }, () => 6));
    run(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.position).toEqual({ col: target.col, row: target.row });
    expect(unit.facing).toBe(target.facing);
    expect(unit.moveMode).toBe("walk");
    expect(unit.mpSpent).toBe(1 + target.spent);
  });

  it("mode prone + done without place just drops in place", () => {
    const { s, actor } = started();
    const from = { ...s.battle!.units[actor]!.position };
    run(s, "mode prone");
    run(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.position).toEqual(from);
    expect(unit.mpSpent).toBe(1);
  });

  it("in-place turn via place covers the old turn command", () => {
    const { s, actor } = started();
    const before = s.battle!.units[actor]!;
    const from = { ...before.position };
    run(s, "mode prone");
    const landing = s.moveCandidate!.revealed.find(
      (l) => l.hex.col === from.col && l.hex.row === from.row && l.facing !== before.facing,
    )!;
    expect(landing).toBeDefined();
    const spent = landing.path[landing.path.length - 1]!.totalMp;
    run(s, `place ${landing.hex.col} ${landing.hex.row} ${landing.facing}`);
    run(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.position).toEqual(from);
    expect(unit.facing).toBe(landing.facing);
    expect(unit.mpSpent).toBe(1 + spent); // drop 1 + turn fragments
    expect(run(s, "turn left")[0]).toMatch(/^error:/);
  });

  it("mode standup walk + place stands then moves (stand 2 + steps)", () => {
    // Piloting 0 → PSR target 0 → auto-success, no RNG drawn.
    const { s, actor } = started(0);
    forceProne(s, actor);
    run(s, "mode standup walk");
    expect(s.moveMode).toBe("standup");
    expect(s.postureMove).toBe("walk");
    expect(s.moveCandidate).not.toBeNull();
    const target = steppedLanding(s);
    run(s, `place ${target.col} ${target.row} ${target.facing}`);
    s.rng = scriptedRng(...Array.from({ length: 40 }, () => 6));
    run(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(false);
    expect(unit.position).toEqual({ col: target.col, row: target.row });
    expect(unit.moveMode).toBe("walk");
    expect(unit.mpSpent).toBe(2 + target.spent);
  });

  it("mode standup jump + place stands then jumps", () => {
    const { s, actor } = started(0, "GRF-1N");
    forceProne(s, actor);
    run(s, "mode standup jump");
    expect(s.postureMove).toBe("jump");
    expect(s.moveCandidate).not.toBeNull();
    const target = steppedLanding(s);
    run(s, `place ${target.col} ${target.row} ${target.facing}`);
    s.rng = scriptedRng(...Array.from({ length: 40 }, () => 6));
    run(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(false);
    expect(unit.position).toEqual({ col: target.col, row: target.row });
    expect(unit.facing).toBe(target.facing);
    expect(unit.moveMode).toBe("jump");
    expect(unit.mpSpent).toBe(2 + target.spent);
  });

  it("failed standup discards the queued place and ends the activation", () => {
    const { s, actor } = started(4);
    forceProne(s, actor);
    const from = { ...s.battle!.units[actor]!.position };
    run(s, "mode standup walk");
    const target = steppedLanding(s);
    run(s, `place ${target.col} ${target.row} ${target.facing}`);
    expect(s.moveSteps.length).toBeGreaterThan(0);
    // Natural 2 on the PSR always fails; over-provision fall dice.
    s.rng = scriptedRng(1, 1, ...Array.from({ length: 30 }, () => 3));
    run(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.position).toEqual(from);
    expect(s.moveMode).toBeNull();
    expect(s.moveSteps).toHaveLength(0);
    expect(s.placedLanding).toBeNull();
  });

  it("candidate landings fit the shared (reduced) budget", () => {
    const { s, actor } = started(0);
    forceProne(s, actor);
    run(s, "mode standup walk");
    const budget = S.budgetFor(s);
    for (const landing of s.moveCandidate!.revealed) {
      const last = landing.path[landing.path.length - 1];
      expect(last?.totalMp ?? 0).toBeLessThanOrEqual(budget);
    }
  });
});

describe("engine crawl", () => {
  function crawlBattle(): ReturnType<typeof createTestBattle> {
    const state = createTestBattle(
      [],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 3, row: 3 },
          facing: "n",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 5, row: 5 },
          facing: "s",
        },
      ],
      true,
    );
    rollInitiativePhase(state, scriptedRng(3, 3, 4, 4));
    return state;
  }

  it("crawls forward for flat 2 MP ignoring terrain", () => {
    const state = crawlBattle();
    dropProne(state, "hbk");
    const to = neighbor({ col: 3, row: 3 }, "n");
    executeMove(state, "hbk", [{ kind: "enter", to }]);
    const unit = state.units.hbk!;
    expect(unit.prone).toBe(true);
    expect(unit.position).toEqual(to);
    expect(unit.mpSpent).toBe(2);
    expect(unit.movesThisTurn).toEqual(["forward"]);
  });

  it("rejects backward crawl", () => {
    const state = crawlBattle();
    dropProne(state, "hbk");
    const to = neighbor({ col: 3, row: 3 }, "s");
    expect(() => executeMove(state, "hbk", [{ kind: "enter", to }])).toThrow(/only crawl forward/);
  });
});
