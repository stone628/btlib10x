import { describe, expect, it } from "vitest";
import {
  advancePhase,
  checkVictory,
  createBattle,
  declareAttacks,
  declareMove,
  executeMove,
  getUnit,
  nextActor,
  resolveDeclaredAttacks,
  rollInitiativePhase,
} from "../src/rules/game.js";
import type { BattleState } from "../src/rules/game.js";
import { getWeapon } from "../src/data/weapons.js";
import { scriptedRng } from "./helpers.js";

function hbkVsEnf(terrain: Record<string, "clear" | "lightWoods" | "heavyWoods"> = {}): BattleState {
  return createBattle(
    [
      { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 0, row: 2 }, facing: "se" },
      { id: "enf", model: "ENF-4R", team: 1, gunnery: 4, position: { col: 1, row: 2 }, facing: "nw" },
    ],
    { terrain },
  );
}

/** Initiative always 6 vs 4 -> team 0 wins; both sides skip movement. */
function startMovementTurn(state: BattleState, rng = scriptedRng(3, 3, 3, 1)): BattleState {
  return rollInitiativePhase(state, rng);
}

/** Movement phase resolved with nobody moving -> ready for weapon attacks. */
function startAttackTurn(state: BattleState, rng?: ReturnType<typeof scriptedRng>): BattleState {
  return advancePhase(startMovementTurn(state, rng));
}

describe("createBattle", () => {
  it("rejects duplicate ids, unknown models, and bad gunnery", () => {
    const base = { id: "a", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 0, row: 0 }, facing: "n" as const };
    expect(() => createBattle([base, base])).toThrow(/Duplicate unit id/);
    expect(() =>
      createBattle([base, { ...base, id: "b", model: "MAD-3R" }]),
    ).toThrow(/Unknown 'Mech model/);
    expect(() =>
      createBattle([base, { ...base, id: "b", gunnery: 8 }]),
    ).toThrow(/Gunnery/);
  });

  it("initializes armor and ammo from the definition", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    expect(hbk.armor).toEqual(state.defs["HBK-4G"]!.armor);
    expect(hbk.ammoLeft["0"]).toBe(10);
    expect(hbk.phaseStartArmor).toEqual(hbk.armor);
    expect(state.phase).toBe("initiative");
    expect(state.turn).toBe(1);
  });
});

describe("movement phase", () => {
  it("enforces phase ordering", () => {
    expect(() => declareMove(hbkVsEnf(), "hbk", "walk")).toThrow(/phase/);
  });

  it("requires a declared movement mode before executing", () => {
    let state = startMovementTurn(hbkVsEnf());
    state = { ...state, phase: "movement" as const };
    expect(() => executeMove(state, "hbk", [{ kind: "enter", to: { col: -1, row: 2 } }])).toThrow(
      /Declare a movement mode/,
    );
  });

  it("charges MP for terrain and facing changes within budget", () => {
    const setup = createBattle([
      { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 0, row: 2 }, facing: "se" },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 9, row: 9 },
        facing: "nw",
      },
    ], { terrain: { "1,2": "lightWoods" } });
    let state = startMovementTurn(setup);
    state = declareMove(state, "hbk", "walk");
    state = executeMove(state, "hbk", [
      { kind: "enter", to: { col: 1, row: 2 } },
      { kind: "turn", facings: 1 },
    ]);
    const hbk = getUnit(state, "hbk");
    expect(hbk.mpSpent).toBe(3); // 1 turn + 2 light woods
    expect(hbk.position).toEqual({ col: 1, row: 2 });
  });

  it("rejects running backward", () => {
    let state = startMovementTurn(hbkVsEnf());
    state = declareMove(state, "hbk", "run");
    expect(() => executeMove(state, "hbk", [{ kind: "enter", to: { col: -1, row: 1 } }])).toThrow(
      /backward/,
    );
  });

  it("rejects ending in an occupied hex but allows friendly pass-through", () => {
    let state = startMovementTurn(hbkVsEnf());
    state = declareMove(state, "hbk", "walk");
    expect(() => executeMove(state, "hbk", [{ kind: "enter", to: { col: 1, row: 2 } }])).toThrow(
      /occupied/,
    );
  });

  it("rejects moves exceeding the mode budget", () => {
    const setup = createBattle([
      { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 0, row: 2 }, facing: "se" },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 9, row: 9 },
        facing: "nw",
      },
    ]);
    let state = startMovementTurn(setup);
    state = declareMove(state, "hbk", "walk"); // walking 4
    // Straight southeast line (odd-q: the column parity alternates the row drift).
    const steps = [
      { col: 1, row: 2 },
      { col: 2, row: 3 },
      { col: 3, row: 3 },
      { col: 4, row: 4 },
      { col: 5, row: 4 },
    ].map((to) => ({ kind: "enter" as const, to }));
    expect(() => executeMove(state, "hbk", steps)).toThrow(/budget/);
  });

  it("stand-still forbids steps and turns", () => {
    let state = startMovementTurn(hbkVsEnf());
    state = declareMove(state, "hbk", "standStill");
    expect(() => executeMove(state, "hbk", [{ kind: "enter", to: { col: -1, row: 2 } }])).toThrow(
      /Standing still forbids entering/,
    );
    expect(() => executeMove(state, "hbk", [{ kind: "turn", facings: 1 }])).toThrow(
      /forbids facing changes/,
    );
  });

  it("alternates activation via nextActor", () => {
    let state = startMovementTurn(hbkVsEnf()); // team 0 wins initiative
    expect(nextActor(state)).toBe("enf");
    state = declareMove(state, "hbk", "walk");
    state = executeMove(state, "hbk", []);
    expect(nextActor(state)).toBe("enf");
  });

  it("jumping pays 1 MP per hex entered and may pass over enemies", () => {
    const setup = createBattle(
      [
        { id: "grf", model: "GRF-1N", team: 0, gunnery: 4, position: { col: 0, row: 2 }, facing: "se" },
        { id: "wvr", model: "WVR-6R", team: 1, gunnery: 4, position: { col: 1, row: 2 }, facing: "nw" },
      ],
      {},
    );
    let state = startMovementTurn(setup);
    state = declareMove(state, "grf", "jump");
    // Hop through the enemy-occupied hex (allowed while jumping) and land beyond it.
    state = executeMove(state, "grf", [
      { kind: "enter", to: { col: 1, row: 2 } },
      { kind: "enter", to: { col: 2, row: 2 } },
    ]);
    const grf = getUnit(state, "grf");
    expect(grf.position).toEqual({ col: 2, row: 2 });
    expect(grf.mpSpent).toBe(2);
    expect(grf.jumpedThisTurn).toBe(true);
  });
});

describe("weapon attack phase", () => {
  it("validates arc, LOS, range, target count, and auto-miss aborts", () => {
    // Facing northwest, target to the southeast -> outside front arc.
    let state = startAttackTurn(createBattle([
      { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 0, row: 2 }, facing: "nw" },
      { id: "enf", model: "ENF-4R", team: 1, gunnery: 4, position: { col: 1, row: 2 }, facing: "nw" },
    ]));
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 0, targetId: "enf" }])).toThrow(
      /front firing arc/,
    );

    // Two heavy woods between -> blocked LOS.
    state = startAttackTurn(hbkVsEnf({
      "-1,2": "heavyWoods",
      "0,2": "clear",
      "1,2": "clear",
      "2,2": "heavyWoods",
    }));
    // Move units apart so intervening hexes exist.
    state = createBattle([
      { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 0, row: 2 }, facing: "se" },
      { id: "enf", model: "ENF-4R", team: 1, gunnery: 4, position: { col: 3, row: 2 }, facing: "nw" },
    ], { terrain: { "1,2": "heavyWoods", "2,2": "heavyWoods" } });
    state = startAttackTurn(state);
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 0, targetId: "enf" }])).toThrow(
      /blocked/,
    );

    // Out of range.
    const ac20 = getWeapon("Autocannon/20");
    state = createBattle([
      { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 0, row: 2 }, facing: "se" },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: ac20.long + 1, row: 2 },
        facing: "nw",
      },
    ]);
    state = startAttackTurn(state);
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 0, targetId: "enf" }])).toThrow(
      /long range/,
    );

    // Modified TN > 12 must be aborted at declaration.
    state = createBattle([
      { id: "enf", model: "ENF-4R", team: 0, gunnery: 7, position: { col: 0, row: 2 }, facing: "se" },
      { id: "hbk", model: "HBK-4G", team: 1, gunnery: 4, position: { col: 9, row: 2 }, facing: "nw" },
    ], { terrain: { "3,2": "lightWoods", "5,2": "lightWoods", "9,2": "heavyWoods" } });
    state = startAttackTurn(state);
    // Large laser (index 1), distance 9, +2 woods intervening, +2 heavy target.
    expect(() => declareAttacks(state, "enf", [{ weaponIndex: 1, targetId: "hbk" }])).toThrow(
      /auto-miss|abort/,
    );
  });

  it("deducts ammo at declaration and allows one target per turn", () => {
    let state = startAttackTurn(hbkVsEnf());
    state = declareAttacks(state, "hbk", [
      { weaponIndex: 0, targetId: "enf" },
      { weaponIndex: 1, targetId: "enf" },
    ]);
    expect(getUnit(state, "hbk").ammoLeft["0"]).toBe(9);
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 2, targetId: "enf" }])).toThrow(
      /already declared/,
    );
  });

  it("resolves scripted attacks immediately and commits kills only at end of phase", () => {
    let state = startAttackTurn(hbkVsEnf());
    state = declareAttacks(state, "hbk", [{ weaponIndex: 0, targetId: "enf" }]);
    // Turn 1: AC/20 (20 dmg) hits CT (roll 5) -> 23 - 20 = 3 left.
    state = resolveDeclaredAttacks(state, "hbk", scriptedRng(2, 3, 3, 4));
    expect(getUnit(state, "enf").armor["centerTorso"]).toBe(3);
    expect(getUnit(state, "enf").destroyed).toBe(false);

    state = advancePhase(state); // weaponAttack -> end
    expect(getUnit(state, "enf").destroyed).toBe(false); // survived with 3 CT

    state = advancePhase(state); // end -> initiative, turn 2
    expect(state.turn).toBe(2);
    expect(getUnit(state, "hbk").moveMode).toBeNull();
    expect(getUnit(state, "hbk").declaredAttacks).toHaveLength(0);

    state = rollInitiativePhase(state, scriptedRng(3, 3, 3, 1));
    state = advancePhase(state);
    state = declareAttacks(state, "hbk", [{ weaponIndex: 0, targetId: "enf" }]);
    state = resolveDeclaredAttacks(state, "hbk", scriptedRng(6, 6, 3, 4)); // hit CT again
    expect(getUnit(state, "enf").armor["centerTorso"]).toBe(0);
    expect(getUnit(state, "enf").destroyed).toBe(false); // not yet committed

    state = advancePhase(state); // weaponAttack -> end commits the kill
    const enf = getUnit(state, "enf");
    expect(enf.destroyed).toBe(true);
    expect(enf.removed).toBe(true);
    expect(state.events.some((e) => e.kind === "unitRemoved")).toBe(true);
    expect(checkVictory(state)).toEqual({ winnerTeam: 0, draw: false });
  });

  it("jams Ultra AC/5 double taps on a natural 2 and tracks the jam", () => {
    const setup = createBattle([
      { id: "her", model: "HER-5SA", team: 0, gunnery: 4, position: { col: 0, row: 2 }, facing: "se" },
      { id: "cda", model: "CDA-3MA", team: 1, gunnery: 4, position: { col: 1, row: 2 }, facing: "nw" },
    ]);
    let state = startAttackTurn(setup);
    state = declareAttacks(state, "her", [
      { weaponIndex: 2, targetId: "cda", shots: 2 },
    ]);
    expect(getUnit(state, "her").ammoLeft["2"]).toBe(18); // 2 shots spent up front
    state = resolveDeclaredAttacks(state, "her", scriptedRng(1, 1)); // natural 2 -> jam
    const her = getUnit(state, "her");
    expect(her.jammedWeapons).toEqual([2]);
    expect(getUnit(state, "cda").armor["centerTorso"]).toBe(
      state.defs["CDA-3MA"]!.armor["centerTorso"],
    );
  });
});
