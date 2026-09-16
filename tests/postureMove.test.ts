import { describe, expect, it } from "vitest";
import { neighbor } from "../src/core/hex.js";
import { executeMove, getUnit, rollInitiativePhase } from "../src/rules/game.js";
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
  expect(run(s, `add hunchy ${model} 9 9 n${pilotArg}`)).toHaveLength(1);
  expect(run(s, `add cicada ${model} 9 8 s${pilotArg}`)).toHaveLength(1);
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
  it("mode drop/crawl are gone; bare mode standup defaults to standstill", () => {
    const { s } = started();
    expect(run(s, "mode drop")[0]).toMatch(/^error:/);
    expect(run(s, "mode crawl")[0]).toMatch(/^error:/);
    expect(run(s, "mode crawl")[0]).toMatch(/valid modes:/);
    forceProne(s, S.currentActor(s)!.id);
    expect(run(s, "mode standup foo")[0]).toMatch(/^error:/);
    expect(run(s, "mode walk")[0]).toMatch(/valid modes:/);
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

  it("bare mode prone defaults to turn; prone turn + place turns sharing one walk budget", () => {
    const { s, actor } = started();
    run(s, "mode prone");
    expect(s.moveMode).toBe("prone");
    expect(s.postureMove).toBe("walk");
    expect(s.moveCandidate).not.toBeNull();
    // Turn-only map: every landing stays in place.
    for (const l of s.moveCandidate!.revealed) {
      expect(l.hex).toEqual(s.battle!.units[actor]!.position);
    }
    const before = s.battle!.units[actor]!;
    const landing = s.moveCandidate!.revealed.find((l) => l.facing !== before.facing)!;
    expect(landing).toBeDefined();
    const spent = landing.path[landing.path.length - 1]!.totalMp;
    run(s, `place ${landing.hex.col} ${landing.hex.row} ${landing.facing}`);
    const heatBefore = s.battle!.units[actor]!.heat;
    run(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.position).toEqual(before.position);
    expect(unit.facing).toBe(landing.facing);
    expect(unit.moveMode).toBe("walk");
    expect(unit.mpSpent).toBe(1 + spent); // drop 1 + turn fragments
    expect(unit.heat).toBe(heatBefore + 2); // drop 1 + turn 1
  });

  it("mode prone pronestill drops in place with no candidate map", () => {
    const { s, actor } = started();
    run(s, "mode prone pronestill");
    expect(s.moveMode).toBe("prone");
    expect(s.postureMove).toBe("standStill");
    expect(s.moveCandidate).toBeNull();
    expect(run(s, `place 9 9 n`)[0]).toMatch(/^error:/);
    const heatBefore = s.battle!.units[actor]!.heat;
    run(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.mpSpent).toBe(1);
    expect(unit.heat).toBe(heatBefore + 1); // drop only, no turn heat
  });

  it("prone mode turn + place turns in place with +1 heat", () => {
    const { s, actor } = started();
    forceProne(s, actor);
    const before = s.battle!.units[actor]!;
    run(s, "mode turn");
    expect(s.moveMode).toBe("turn");
    expect(s.moveCandidate).not.toBeNull();
    const landing = s.moveCandidate!.revealed.find((l) => l.facing !== before.facing)!;
    expect(landing).toBeDefined();
    expect(landing.hex).toEqual(before.position);
    run(s, `place ${landing.hex.col} ${landing.hex.row} ${landing.facing}`);
    const heatBefore = s.battle!.units[actor]!.heat;
    run(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.position).toEqual(before.position);
    expect(unit.facing).toBe(landing.facing);
    expect(unit.moveMode).toBe("walk");
    expect(unit.heat).toBe(heatBefore + 1);
  });

  it("prone mode pronestill holds with no heat and no candidate", () => {
    const { s, actor } = started();
    forceProne(s, actor);
    run(s, "mode pronestill");
    expect(s.moveMode).toBe("pronestill");
    expect(s.moveCandidate).toBeNull();
    expect(run(s, "place 9 9 n")[0]).toMatch(/^error:/);
    const heatBefore = s.battle!.units[actor]!.heat;
    run(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.heat).toBe(heatBefore);
  });

  it("standing mode turn/pronestill are rejected with the valid-modes hint", () => {
    const { s } = started();
    expect(run(s, "mode turn")[0]).toMatch(/valid modes:/);
    expect(run(s, "mode pronestill")[0]).toMatch(/valid modes:/);
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

describe("engine prone turn", () => {
  function proneBattle(): ReturnType<typeof createTestBattle> {
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

  it("turns in place for 1 MP per hexside, multiple turns allowed", () => {
    const state = proneBattle();
    getUnit(state, "hbk").prone = true;
    executeMove(state, "hbk", "walk", [
      { kind: "turn", facings: 1 },
      { kind: "turn", facings: 1 },
    ]);
    const unit = state.units.hbk!;
    expect(unit.prone).toBe(true);
    expect(unit.position).toEqual({ col: 3, row: 3 });
    expect(unit.facing).toBe("se");
    expect(unit.mpSpent).toBe(2);
    expect(unit.movesThisTurn).toEqual([]);
  });

  it("rejects hex enters while prone", () => {
    const state = proneBattle();
    const to = neighbor({ col: 3, row: 3 }, "n");
    getUnit(state, "hbk").prone = true;
    expect(() => executeMove(state, "hbk", "walk", [{ kind: "enter", to }])).toThrow(
      /turn or pronestill only/,
    );
  });

  it("rejects zero-hex jump declarations", () => {
    const state = proneBattle();
    expect(() => executeMove(state, "hbk", "jump", [])).toThrow(/at least 1 hex/);
  });
});
