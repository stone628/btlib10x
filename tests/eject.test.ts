import { describe, expect, it } from "vitest";
import { neighbor } from "../src/core/hex.js";
import { resolveWeaponAttack } from "../src/rules/attack.js";
import type { BattleState, UnitInit } from "../src/rules/game.js";
import {
  checkVictory,
  declareMove,
  ejectPilot,
  executeMove,
  getUnit,
  nextActor,
  partialCoverMod,
  rollInitiativePhase,
  wreckAt,
} from "../src/rules/game.js";
import { losClear } from "../src/rules/los.js";
import { reachableLandings } from "../src/rules/movement.js";
import { createTestBattle, scriptedRng } from "./helpers.js";

function hbkVsEnf(): BattleState {
  const units: UnitInit[] = [
    { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 2, row: 4 }, facing: "se" },
    { id: "enf", model: "ENF-4R", team: 1, gunnery: 4, position: { col: 5, row: 4 }, facing: "nw" },
  ];
  return createTestBattle([], units, true);
}

function startMovementTurn(state: BattleState, rng = scriptedRng(3, 3, 3, 1)): BattleState {
  rollInitiativePhase(state, rng);
  return state;
}

describe("eject", () => {
  it("requires the movement phase", () => {
    const state = hbkVsEnf();
    expect(() => ejectPilot(state, "hbk")).toThrow(/movement/);
  });

  it("removes the unit, marks it acted, emits events, and spawns a level-2 wreck", () => {
    const state = startMovementTurn(hbkVsEnf());
    ejectPilot(state, "hbk");
    const hbk = getUnit(state, "hbk");
    expect(hbk.removed).toBe("pilotEjected");
    expect(hbk.destroyed).toBe("not");
    expect(state.actedThisPhase).toContain("hbk");
    expect(state.wrecks["2,4"]).toEqual({ unitId: "hbk", level: 2 });
    expect(
      state.events.some(
        (e) => e.kind === "unitRemoved" && e.unitId === "hbk" && e.reason === "pilotEjected",
      ),
    ).toBe(true);
    expect(wreckAt(state, { col: 2, row: 4 })?.unitId).toBe("hbk");
  });

  it("rejects a unit already removed from play", () => {
    const state = startMovementTurn(hbkVsEnf());
    ejectPilot(state, "hbk");
    expect(() => ejectPilot(state, "hbk")).toThrow(/removed from play/);
  });

  it("allows a shut-down unit to eject", () => {
    const state = startMovementTurn(hbkVsEnf());
    getUnit(state, "hbk").shutdown = "manual";
    ejectPilot(state, "hbk");
    expect(getUnit(state, "hbk").removed).toBe("pilotEjected");
    expect(state.wrecks["2,4"]).toEqual({ unitId: "hbk", level: 2 });
  });

  it("skips the ejected unit in the actor queue and settles victory", () => {
    const state = startMovementTurn(hbkVsEnf());
    ejectPilot(state, "hbk");
    expect(nextActor(state)).toBe("enf");
    expect(checkVictory(state).winnerTeam).toBe(1);
  });

  it("blocks walking into a wreck hex", () => {
    const wreck = { col: 3, row: 4 };
    const start = neighbor(neighbor(wreck, "s"), "s");
    const units: UnitInit[] = [
      { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: wreck, facing: "n" },
      { id: "enf", model: "ENF-4R", team: 1, gunnery: 4, position: start, facing: "n" },
    ];
    const state = startMovementTurn(createTestBattle([], units, true));
    ejectPilot(state, "hbk");
    declareMove(state, "enf", "walk");
    expect(() =>
      executeMove(state, "enf", [
        { kind: "enter", to: neighbor(start, "n") },
        { kind: "enter", to: wreck },
      ]),
    ).toThrow(/wreck/);
  });

  it("blocks landing on a wreck hex", () => {
    const wreck = { col: 3, row: 4 };
    const start = neighbor(wreck, "n");
    const units: UnitInit[] = [
      { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: wreck, facing: "n" },
      { id: "enf", model: "ENF-4R", team: 1, gunnery: 4, position: start, facing: "s" },
    ];
    const state = startMovementTurn(createTestBattle([], units, true));
    ejectPilot(state, "hbk");
    expect(
      reachableLandings(start, "s", {
        mode: "jump",
        walking: 4,
        running: 7,
        jumping: 3,
        prone: false,
        grid: state,
        team: 1,
        wreckAt: (hex) => wreckAt(state, hex) !== undefined,
        occupantTeam: () => undefined,
      }).some((l) => l.hex.col === wreck.col && l.hex.row === wreck.row),
    ).toBe(false);
    declareMove(state, "enf", "jump");
    expect(() => executeMove(state, "enf", [{ kind: "enter", to: wreck }])).toThrow(/wreck/);
  });

  it("blocks LOS only when the wreck lies strictly between the endpoints", () => {
    const state = startMovementTurn(hbkVsEnf());
    getUnit(state, "hbk").position = { col: 3, row: 4 };
    const from = { col: 2, row: 4 };
    const to = { col: 4, row: 4 };
    expect(losClear(state, from, to)).toBe(true);
    ejectPilot(state, "hbk");
    expect(losClear(state, from, to, state.wrecks)).toBe(false);
    expect(losClear(state, from, { col: 3, row: 4 }, state.wrecks)).toBe(true);
  });

  it("grants +2 partial cover to a target adjacent to a wreck", () => {
    const wreck = { col: 3, row: 3 };
    const units: UnitInit[] = [
      { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: wreck, facing: "n" },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 3, row: 4 },
        facing: "s",
      },
      {
        id: "cda",
        model: "CDA-3MA",
        team: 0,
        gunnery: 4,
        position: { col: 2, row: 4 },
        facing: "se",
      },
    ];
    const state = startMovementTurn(createTestBattle([], units, true));
    ejectPilot(state, "hbk");
    expect(partialCoverMod(state, getUnit(state, "cda"), getUnit(state, "enf"))).toBe(2);
    getUnit(state, "enf").position = { col: 1, row: 5 };
    expect(partialCoverMod(state, getUnit(state, "cda"), getUnit(state, "enf"))).toBe(0);
  });

  it("strikes the cover on a leg roll and deals no damage", () => {
    const target = getUnit(startMovementTurn(hbkVsEnf()), "enf");
    const base = {
      gunnery: 0,
      attackerMoved: "standStill" as const,
      targetHexesMoved: 0,
      targetJumped: false,
      targetTerrain: "clear" as const,
      interveningTerrains: [] as const,
      distance: 1,
      weapon: "Small Laser",
      targetDamage: target.damage,
    };
    // Location roll 2+3=5 -> right leg; under cover it strikes the wreck.
    const covered = resolveWeaponAttack({
      ...base,
      rng: scriptedRng(6, 6, 2, 3),
      partialCoverMod: 2,
    });
    expect(covered.breakdown.terrainMod).toBe(2);
    expect(covered.breakdown.total).toBe(2);
    expect(covered.hit).toBe(true);
    expect(covered.groups).toHaveLength(0);
    expect(covered.application).toBeNull();
    // Control: without wreck cover the same rolls put damage on the leg.
    const open = resolveWeaponAttack({ ...base, rng: scriptedRng(6, 6, 2, 3) });
    expect(open.groups).toHaveLength(1);
    expect(open.groups[0]!.location).toBe("rightLeg");
  });
});
