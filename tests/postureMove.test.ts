import { describe, expect, it } from "vitest";
import { neighbor } from "../src/core/hex.js";
import { executeMove, requireUnit, rollInitiativePhase } from "../src/rules/game.js";
import { budgetFor, currentActor, newSession, type Session } from "../web/session.js";
import { createTestBattle, execute, scriptedRng } from "./helpers.js";

function run(s: Session, cmd: string): string[] {
  return execute(s, cmd);
}

/** Started quickstart battle; returns session plus acting-unit id. */
function started(piloting?: number, model = "HBK-4G"): { s: Session; actor: string } {
  const s = newSession(7);
  s.critsDisabled = true;
  expect(run(s, "map quickstart")[0]).toContain("15x16");
  const pilotArg = piloting === undefined ? "" : ` ${piloting}`;
  // NB: facing token before piloting per `add` arg parsing. Both units share
  // model + piloting so either initiative winner can run the script.
  expect(run(s, `add hunchy ${model} 9 9 n${pilotArg}`)).toHaveLength(1);
  expect(run(s, `add cicada ${model} 9 8 s${pilotArg}`)).toHaveLength(1);
  expect(run(s, "start")[0]).toContain("BATTLE STARTED");
  return { s, actor: currentActor(s)!.id };
}

function forceProne(s: Session, id: string): void {
  s.battle!.units[id]!.prone = true;
}

/** First candidate landing with actual steps (skips the in-place facing set). */
function steppedLanding(s: Session): { col: number; row: number; facing: string; spent: number } {
  const landings = s.move!.moveCandidate!.revealed;
  const landing = landings.find((l: { path: readonly unknown[] }) => l.path.length > 0)!;
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
    forceProne(s, currentActor(s)!.id);
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
    expect(s.move!.moveMode).toBe("standup");
    expect(s.move!.postureMove).toBe("standStill");
    expect(s.move!.moveCandidate).toBeNull();
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
    expect(s.move!.moveMode).toBe("prone");
    expect(s.move!.postureMove).toBe("walk");
    expect(s.move!.moveCandidate).not.toBeNull();
    // Turn-only map: every landing stays in place.
    for (const l of s.move!.moveCandidate!.revealed) {
      expect(l.hex).toEqual(s.battle!.units[actor]!.position);
    }
    const before = s.battle!.units[actor]!;
    const landing = s.move!.moveCandidate!.revealed.find((l) => l.facing !== before.facing)!;
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
    expect(unit.heat).toBe(heatBefore); // deferred until heat phase
    expect(unit.heatPending).toBe(1); // drop 0 + turn 1
  });

  it("mode prone pronestill drops in place with no candidate map", () => {
    const { s, actor } = started();
    run(s, "mode prone pronestill");
    expect(s.move!.moveMode).toBe("prone");
    expect(s.move!.postureMove).toBe("standStill");
    expect(s.move!.moveCandidate).toBeNull();
    expect(run(s, `place 9 9 n`)[0]).toMatch(/^error:/);
    const heatBefore = s.battle!.units[actor]!.heat;
    run(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.mpSpent).toBe(1);
    expect(unit.heat).toBe(heatBefore); // drop only, no heat
  });

  it("prone mode turn + place turns in place with +1 heat", () => {
    const { s, actor } = started();
    forceProne(s, actor);
    const before = s.battle!.units[actor]!;
    run(s, "mode turn");
    expect(s.move!.moveMode).toBe("turn");
    expect(s.move!.moveCandidate).not.toBeNull();
    const landing = s.move!.moveCandidate!.revealed.find((l) => l.facing !== before.facing)!;
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
    expect(unit.heat).toBe(heatBefore);
    expect(unit.heatPending).toBe(1);
  });

  it("prone mode pronestill holds with no heat and no candidate", () => {
    const { s, actor } = started();
    forceProne(s, actor);
    run(s, "mode pronestill");
    expect(s.move!.moveMode).toBe("pronestill");
    expect(s.move!.moveCandidate).toBeNull();
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
    const landing = s.move!.moveCandidate!.revealed.find(
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
    expect(s.move!.moveMode).toBe("standup");
    expect(s.move!.postureMove).toBe("walk");
    expect(s.move!.moveCandidate).not.toBeNull();
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
    expect(s.move!.postureMove).toBe("jump");
    expect(s.move!.moveCandidate).not.toBeNull();
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
    expect(s.move!.moveSteps.length).toBeGreaterThan(0);
    // Natural 2 on the PSR always fails; over-provision fall dice.
    s.rng = scriptedRng(1, 1, ...Array.from({ length: 30 }, () => 3));
    run(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.position).toEqual(from);
    expect(s.move!.moveMode).toBeNull();
    expect(s.move!.moveSteps).toHaveLength(0);
    expect(s.move!.placedLanding).toBeNull();
  });

  it("candidate landings fit the shared (reduced) budget", () => {
    const { s, actor } = started(0);
    forceProne(s, actor);
    run(s, "mode standup walk");
    const budget = budgetFor(s);
    for (const landing of s.move!.moveCandidate!.revealed) {
      const last = landing.path[landing.path.length - 1];
      expect(last?.totalMp ?? 0).toBeLessThanOrEqual(budget);
    }
  });

  it("standup offers the start hex in every facing for free (TW p.50)", () => {
    const { s, actor } = started(0);
    forceProne(s, actor);
    const from = { ...s.battle!.units[actor]!.position };
    run(s, "mode standup walk");
    const revealed = s.move!.moveCandidate!.revealed;
    const startEntries = revealed.filter(
      (l: { hex: { col: number; row: number } }) =>
        l.hex.col === from.col && l.hex.row === from.row,
    );
    const facings = new Set(startEntries.map((l: { facing: string }) => l.facing));
    for (const f of ["n", "ne", "se", "s", "sw", "nw"]) {
      expect(facings.has(f)).toBe(true);
      const entry = startEntries.find((l: { facing: string }) => l.facing === f);
      expect(entry?.path).toEqual([]);
    }
  });

  it("standup + place picks a free facing: no MP turn, no steps (TW p.50)", () => {
    const { s, actor } = started(0);
    forceProne(s, actor);
    const from = { ...s.battle!.units[actor]!.position };
    const unitFacing = s.battle!.units[actor]!.facing;
    // Pick a non-unit facing — otherwise it's the stay-in-place pick (no
    // facing change) and `moveFinalFacing` stays null.
    const freeFacing = unitFacing === "n" ? "s" : "n";
    run(s, "mode standup walk");
    run(s, `place ${from.col} ${from.row} ${freeFacing}`);
    expect(s.move!.moveSteps).toEqual([]);
    expect(s.move!.moveFinalFacing).toBe(freeFacing);
    s.rng = scriptedRng(...Array.from({ length: 40 }, () => 6));
    run(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(false);
    expect(unit.position).toEqual(from);
    expect(unit.facing).toBe(freeFacing);
    // 2 MP for standing; no MP charged for the free facing pick.
    expect(unit.mpSpent).toBe(2);
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
          piloting: 5,
          position: { col: 3, row: 3 },
          facing: "n",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          piloting: 5,
          position: { col: 5, row: 5 },
          facing: "s",
        },
      ],
      true,
    );
    rollInitiativePhase(state, scriptedRng(3, 3, 4, 4), []);
    return state;
  }

  it("turns in place for 1 MP per hexside, multiple turns allowed", () => {
    const state = proneBattle();
    requireUnit(state, "hbk").prone = true;
    executeMove(
      state,
      "hbk",
      "walk",
      [
        { kind: "turn", facings: 1 },
        { kind: "turn", facings: 1 },
      ],
      [],
    );
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
    requireUnit(state, "hbk").prone = true;
    expect(() => executeMove(state, "hbk", "walk", [{ kind: "enter", to }], [])).toThrow(
      /turn or pronestill only/,
    );
  });

  it("rejects zero-hex jump declarations", () => {
    const state = proneBattle();
    expect(() => executeMove(state, "hbk", "jump", [], [])).toThrow(/at least 1 hex/);
  });
});
