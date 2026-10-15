import { describe, expect, it } from "vitest";
import { neighbor } from "../src/core/hex";
import type { RevealedLanding } from "../src/index";
import { buildUnitInit, executeMove, requireUnit, rollInitiativePhase } from "../src/rules/game";
import { pathMp } from "../src/rules/movement";
import {
  budgetFor,
  newSession,
  postureCostFor,
  requireMovementActor,
  type Session,
} from "../web/terminal/session";
import { createTestBattle, disableCritical, execute, scriptedRng } from "./helpers";

/** Started quickstart battle; returns session plus acting-unit id. */
function started(piloting?: number, model = "HBK-4G"): { s: Session; actor: string } {
  const s = newSession(7);
  expect(execute(s, "map quickstart")[0]).toContain("15x16");
  const pilotArg = piloting === undefined ? "" : ` ${piloting}`;
  // NB: facing token before piloting per `add` arg parsing. Both units share
  // model + piloting so either initiative winner can run the script.
  expect(execute(s, `add hunchy ${model} 9 9 n${pilotArg}`)).toHaveLength(1);
  expect(execute(s, `add cicada ${model} 9 8 s${pilotArg}`)).toHaveLength(1);
  expect(execute(s, "start")[0]).toContain("BATTLE STARTED");
  disableCritical(s);
  return { s, actor: requireMovementActor(s).id };
}

function forceProne(s: Session, id: string): void {
  s.battle!.units[id]!.prone = true;
}

/** First candidate landing with actual steps (skips the in-place facing set). */
function steppedLanding(s: Session): { col: number; row: number; facing: string; spent: number } {
  const landings = s.move!.moveCandidate!.revealed;
  const landing = landings.find((l: { path: readonly unknown[] }) => l.path.length > 0)!;
  expect(landing).toBeDefined();
  return {
    col: landing.hex.col,
    row: landing.hex.row,
    facing: landing.facing,
    spent: pathMp(landing.path),
  };
}

describe("posture-change then move", () => {
  it("mode drop/crawl are gone; bare mode standup defaults to standstill", async () => {
    const { s } = await started();
    expect(execute(s, "mode drop")[0]).toMatch(/^error:/);
    expect(execute(s, "mode crawl")[0]).toMatch(/^error:/);
    expect(execute(s, "mode crawl")[0]).toMatch(/valid modes:/);
    forceProne(s, requireMovementActor(s).id);
    expect(execute(s, "mode standup foo")[0]).toMatch(/^error:/);
    expect(execute(s, "mode walk")[0]).toMatch(/valid modes:/);
  });

  it("bare mode standup + done stands in place with no candidate map", async () => {
    // Piloting 0 → PSR target 0 → auto-success, no RNG drawn.
    const { s, actor } = await started(0);
    forceProne(s, actor);
    const from = { ...s.battle!.units[actor]!.position };
    const facing = s.battle!.units[actor]!.facing;
    execute(s, "mode standup");
    expect(s.move!.moveMode).toBe("standup");
    expect(s.move!.postureMove).toBe("standStill");
    expect(s.move!.moveCandidate?.revealed).toStrictEqual([] as RevealedLanding[]);
    expect(execute(s, "place 9 9 n")[0]).toMatch(/^error:/);
    execute(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(false);
    expect(unit.position).toEqual(from);
    expect(unit.facing).toBe(facing);
    expect(unit.moveMode).toBe("walk");
    expect(unit.mpSpent).toBe(2);
  });

  it("bare mode prone defaults to turn; prone turn + place turns sharing one walk budget", async () => {
    const { s, actor } = await started();
    execute(s, "mode prone");
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
    const spent = pathMp(landing.path);
    execute(s, `place ${landing.hex.col} ${landing.hex.row} ${landing.facing}`);
    const heatBefore = s.battle!.units[actor]!.heat;
    execute(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.position).toEqual(before.position);
    expect(unit.facing).toBe(landing.facing);
    expect(unit.moveMode).toBe("walk");
    expect(unit.mpSpent).toBe(1 + spent); // drop 1 + turn fragments
    expect(unit.heat).toBe(heatBefore); // deferred until heat phase
    expect(unit.heatPending).toBe(1); // drop 0 + turn 1
  });

  it("mode prone pronestill drops in place with no candidate map", async () => {
    const { s, actor } = await started();
    execute(s, "mode prone pronestill");
    expect(s.move!.moveMode).toBe("prone");
    expect(s.move!.postureMove).toBe("standStill");
    expect(s.move!.moveCandidate?.revealed).toStrictEqual([] as RevealedLanding[]);
    expect(execute(s, `place 9 9 n`)[0]).toMatch(/^error:/);
    const heatBefore = s.battle!.units[actor]!.heat;
    execute(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.mpSpent).toBe(1);
    expect(unit.heat).toBe(heatBefore); // drop only, no heat
  });

  it("prone mode turn + place turns in place with +1 heat", async () => {
    const { s, actor } = await started();
    forceProne(s, actor);
    const before = s.battle!.units[actor]!;
    execute(s, "mode turn");
    expect(s.move!.moveMode).toBe("turn");
    expect(s.move!.moveCandidate).not.toBeNull();
    const landing = s.move!.moveCandidate!.revealed.find((l) => l.facing !== before.facing)!;
    expect(landing).toBeDefined();
    expect(landing.hex).toEqual(before.position);
    execute(s, `place ${landing.hex.col} ${landing.hex.row} ${landing.facing}`);
    const heatBefore = s.battle!.units[actor]!.heat;
    execute(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.position).toEqual(before.position);
    expect(unit.facing).toBe(landing.facing);
    expect(unit.moveMode).toBe("walk");
    expect(unit.heat).toBe(heatBefore);
    expect(unit.heatPending).toBe(1);
  });

  it("prone mode pronestill holds with no heat and no candidate", async () => {
    const { s, actor } = await started();
    forceProne(s, actor);
    execute(s, "mode pronestill");
    expect(s.move!.moveMode).toBe("pronestill");
    expect(s.move!.moveCandidate?.revealed).toStrictEqual([] as RevealedLanding[]);
    expect(execute(s, "place 9 9 n")[0]).toMatch(/^error:/);
    const heatBefore = s.battle!.units[actor]!.heat;
    execute(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.heat).toBe(heatBefore);
  });

  it("standing mode turn/pronestill are rejected with the valid-modes hint", async () => {
    const { s } = await started();
    expect(execute(s, "mode turn")[0]).toMatch(/valid modes:/);
    expect(execute(s, "mode pronestill")[0]).toMatch(/valid modes:/);
  });

  it("mode prone + done without place just drops in place", async () => {
    const { s, actor } = await started();
    const from = { ...s.battle!.units[actor]!.position };
    execute(s, "mode prone");
    execute(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.position).toEqual(from);
    expect(unit.mpSpent).toBe(1);
  });

  it("in-place turn via place covers the old turn command", async () => {
    const { s, actor } = await started();
    const before = s.battle!.units[actor]!;
    const from = { ...before.position };
    execute(s, "mode prone");
    const landing = s.move!.moveCandidate!.revealed.find(
      (l) => l.hex.col === from.col && l.hex.row === from.row && l.facing !== before.facing,
    )!;
    expect(landing).toBeDefined();
    const spent = pathMp(landing.path);
    execute(s, `place ${landing.hex.col} ${landing.hex.row} ${landing.facing}`);
    execute(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.position).toEqual(from);
    expect(unit.facing).toBe(landing.facing);
    expect(unit.mpSpent).toBe(1 + spent); // drop 1 + turn fragments
    expect(execute(s, "turn left")[0]).toMatch(/^error:/);
  });

  it("mode standup walk + place stands then moves (stand 2 + steps)", async () => {
    // Piloting 0 → PSR target 0 → auto-success, no RNG drawn.
    const { s, actor } = await started(0);
    forceProne(s, actor);
    execute(s, "mode standup walk");
    expect(s.move!.moveMode).toBe("standup");
    expect(s.move!.postureMove).toBe("walk");
    expect(s.move!.moveCandidate).not.toBeNull();
    const target = steppedLanding(s);
    execute(s, `place ${target.col} ${target.row} ${target.facing}`);
    s.rng = scriptedRng(...Array.from({ length: 40 }, () => 6));
    execute(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(false);
    expect(unit.position).toEqual({ col: target.col, row: target.row });
    expect(unit.moveMode).toBe("walk");
    expect(unit.mpSpent).toBe(2 + target.spent);
  });

  it("mode standup jump is rejected: a 'Mech that stood cannot jump (TW p.49)", async () => {
    const { s, actor } = await started(0, "GRF-1N");
    forceProne(s, actor);
    expect(execute(s, "mode standup jump")[0]).toMatch(/^error:/);
    expect(s.battle!.units[actor]!.prone).toBe(true);
  });

  it("standing up to walk charges the stand heat plus the walk heat (HEAT-03)", async () => {
    const { s, actor } = await started(0);
    forceProne(s, actor);
    execute(s, "mode standup walk");
    const target = steppedLanding(s);
    execute(s, `place ${target.col} ${target.row} ${target.facing}`);
    s.rng = scriptedRng(...Array.from({ length: 40 }, () => 6));
    execute(s, "done");
    expect(s.battle!.units[actor]!.heatPending).toBe(2);
  });

  it("failed standup discards the queued place and ends the activation", async () => {
    const { s, actor } = await started(4);
    forceProne(s, actor);
    const from = { ...s.battle!.units[actor]!.position };
    execute(s, "mode standup walk");
    const target = steppedLanding(s);
    execute(s, `place ${target.col} ${target.row} ${target.facing}`);
    expect(s.move!.moveSteps.length).toBeGreaterThan(0);
    // Natural 2 on the PSR always fails; over-provision fall dice.
    s.rng = scriptedRng(1, 1, ...Array.from({ length: 30 }, () => 3));
    execute(s, "done");
    const unit = s.battle!.units[actor]!;
    expect(unit.prone).toBe(true);
    expect(unit.position).toEqual(from);
    expect(s.move!.moveMode).toBeNull();
    expect(s.move!.moveSteps).toHaveLength(0);
    expect(s.move!.placedLanding).toBeNull();
  });

  it("candidate landings fit the shared (reduced) budget", async () => {
    const { s, actor } = await started(0);
    forceProne(s, actor);
    execute(s, "mode standup walk");
    const budget = budgetFor(requireMovementActor(s), s.move!);
    for (const landing of s.move!.moveCandidate!.revealed) {
      expect(pathMp(landing.path)).toBeLessThanOrEqual(budget);
    }
  });

  it("a 1-MP stand charges only the walking budget it has (TW p.50)", async () => {
    const { s, actor } = await started(0);
    forceProne(s, actor);
    // HBK-4G walks 4; heat 15 cuts walking to 1, running to 2 (TW p.159).
    s.battle!.units[actor]!.heat = 15;
    execute(s, "mode standup run");
    expect(postureCostFor(s)).toBe(1);
    // A Minimum Movement stand is the turn's only MP expenditure (TW p.49):
    // nothing is left of the running budget.
    expect(budgetFor(requireMovementActor(s), s.move!)).toBe(0);
  });

  it("standup offers the start hex in every facing for free (TW p.50)", async () => {
    const { s, actor } = await started(0);
    forceProne(s, actor);
    const from = { ...s.battle!.units[actor]!.position };
    execute(s, "mode standup walk");
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

  it("standup + place picks a free facing: no MP turn, no steps (TW p.50)", async () => {
    const { s, actor } = await started(0);
    forceProne(s, actor);
    const from = { ...s.battle!.units[actor]!.position };
    const unitFacing = s.battle!.units[actor]!.facing;
    // Pick a non-unit facing — otherwise it's the stay-in-place pick (no
    // facing change) and `moveFinalFacing` stays null.
    const freeFacing = unitFacing === "n" ? "s" : "n";
    execute(s, "mode standup walk");
    execute(s, `place ${from.col} ${from.row} ${freeFacing}`);
    expect(s.move!.moveSteps).toEqual([]);
    expect(s.move!.moveFinalFacing).toBe(freeFacing);
    s.rng = scriptedRng(...Array.from({ length: 40 }, () => 6));
    execute(s, "done");
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
        buildUnitInit("hbk", "HBK-4G", 1, { col: 3, row: 3 }, "n"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 5, row: 5 }, "s"),
      ],
      true,
    );
    rollInitiativePhase(state, scriptedRng(3, 3, 4, 4), []);
    return state;
  }

  it("turns in place for 1 MP per hexside, multiple turns allowed", async () => {
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
      { rng: scriptedRng() },
    );
    const unit = state.units.hbk!;
    expect(unit.prone).toBe(true);
    expect(unit.position).toEqual({ col: 3, row: 3 });
    expect(unit.facing).toBe("se");
    expect(unit.mpSpent).toBe(2);
    expect(unit.hexesMovedThisTurn).toBe(0);
  });

  it("rejects hex enters while prone", async () => {
    const state = proneBattle();
    const to = neighbor({ col: 3, row: 3 }, "n");
    requireUnit(state, "hbk").prone = true;
    expect(() =>
      executeMove(state, "hbk", "walk", [{ kind: "enter", to }], [], { rng: scriptedRng() }),
    ).toThrow(/turn or pronestill only/);
  });

  it("rejects zero-hex jump declarations", async () => {
    const state = proneBattle();
    expect(() => executeMove(state, "hbk", "jump", [], [], { rng: scriptedRng() })).toThrow(
      /at least 1 hex/,
    );
  });
});
