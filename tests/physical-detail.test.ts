/**
 * Physical-attack damage detail + crit rendering (weapon parity).
 * A kick that lands must print the armor `before->after` chain via the
 * shared `blastDetail` formatter, and internal-structure damage must attach
 * crits rendered with the same `critLines` formatter as weapon hits.
 */
import { describe, expect, it } from "vitest";
import type { HexCoord } from "../src/core/types";
import type { BattleState, GameEvent, TeamId, UnitInit } from "../src/rules/game";
import { buildUnitInit, requireUnit, resolveAllAttacks } from "../src/rules/game";
import { physicalResolutionLines } from "../web/session.attack";
import { createTestBattle, scriptedRng } from "./helpers";

function unit(
  id: string,
  team: TeamId,
  pos: HexCoord,
  facing: "n" | "ne" | "se" | "s" | "sw" | "nw",
): UnitInit {
  return buildUnitInit(id, "HBK-4G", team, pos, facing);
}

/** hbk (team 1) at (2,2)/s facing enf (team 2) at (2,3)/n, crits enabled. */
function faceToFace(): BattleState {
  const state = createTestBattle(
    [],
    [unit("hbk", 1, { col: 2, row: 2 }, "s"), unit("enf", 2, { col: 2, row: 3 }, "n")],
    false,
  );
  state.phase = "attack";
  return state;
}

function kickEvents(state: BattleState, rng: ReturnType<typeof scriptedRng>): GameEvent[] {
  state.units.hbk!.declaredPhysicalAttacks.push({ type: "kick", targetId: "enf" });
  const events: GameEvent[] = [];
  resolveAllAttacks(state, rng, events);
  return events;
}

function meleeResolution(events: GameEvent[]) {
  const melee = events.find((e) => e.kind === "physicalAttackResolved");
  expect(melee?.kind).toBe("physicalAttackResolved");
  if (melee?.kind !== "physicalAttackResolved") throw new Error("unreachable");
  return melee.resolution;
}

describe("physical damage detail lines", () => {
  it("kick hit prints the armor before->after chain like weapon hits", () => {
    const state = faceToFace();
    // To-hit (4,4)=8 vs 3, location (2)=rightLeg front, kick PSR (4,4).
    // 10 dmg vs 20 armor: no IS stripped, so no determining roll.
    const events = kickEvents(state, scriptedRng(4, 4, 2, 4, 4));
    const res = meleeResolution(events);
    expect(res.hit).toBe(true);
    expect(res.damageToTarget).toHaveLength(1);
    expect(res.application).not.toBeNull();

    const text = physicalResolutionLines(res).join("\n");
    expect(text).toContain("hits: RL(10)");
    expect(text).toMatch(/RLA 20->10\b/);
    expect(res.crits).toEqual([]);
    expect(text).not.toContain("crit roll");
  });

  it("kick that strips IS attaches crits rendered with the weapon crit formatter", () => {
    const state = faceToFace();
    requireUnit(state, "enf").damage.armor.rightLeg = 4;
    // To-hit (4,4)=8, location (2)=rightLeg, determining (3,4)=7 none,
    // kick PSR (4,4).
    const events = kickEvents(state, scriptedRng(4, 4, 2, 3, 4, 4, 4));
    const res = meleeResolution(events);
    expect(res.hit).toBe(true);
    expect(res.application).not.toBeNull();
    expect(res.crits).toHaveLength(1);

    const text = physicalResolutionLines(res).join("\n");
    expect(text).toMatch(/RLA 4->0\*/);
    expect(text).toMatch(/RLI \d+->\d+/);
    expect(text).toContain("crit roll 2D6 = 7");
  });
});
