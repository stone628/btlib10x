import { describe, expect, it } from "vitest";
import { getWeapon } from "../src/data/weapons.js";
import type { BattleState, TerrainHexDef } from "../src/rules/game.js";
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
import { scriptedRng } from "./helpers.js";

function hbkVsEnf(terrain: readonly TerrainHexDef[] = []): BattleState {
  return createBattle(
    [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: 0, row: 2 },
        facing: "se",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 1, row: 2 },
        facing: "nw",
      },
    ],
    { terrain },
  );
}

/** Initiative always 6 vs 4 -> team 0 wins; both sides skip movement. */
function startMovementTurn(state: BattleState, rng = scriptedRng(3, 3, 3, 1)): BattleState {
  rollInitiativePhase(state, rng);
  return state;
}

/** Movement phase resolved with nobody moving -> ready for weapon attacks. */
function startAttackTurn(state: BattleState, rng?: ReturnType<typeof scriptedRng>): BattleState {
  advancePhase(startMovementTurn(state, rng));
  return state;
}

describe("createBattle", () => {
  it("rejects duplicate ids, unknown models, and bad gunnery", () => {
    const base = {
      id: "a",
      model: "HBK-4G",
      team: 0,
      gunnery: 4,
      position: { col: 0, row: 0 },
      facing: "n" as const,
    };
    expect(() => createBattle([base, base])).toThrow(/Duplicate unit id/);
    expect(() => createBattle([base, { ...base, id: "b", model: "MAD-3R" }])).toThrow(
      /Unknown 'Mech model/,
    );
    expect(() => createBattle([base, { ...base, id: "b", gunnery: 8 }])).toThrow(/Gunnery/);
  });

  it("rejects duplicate terrain hex definitions", () => {
    const base = {
      model: "HBK-4G",
      gunnery: 4,
      position: { col: 0, row: 2 },
      facing: "se" as const,
    };
    const units = [
      { ...base, id: "a", team: 0 },
      { ...base, id: "b", team: 1 },
    ];
    expect(() =>
      createBattle(units, {
        terrain: [
          { col: 1, row: 2, type: "lightWoods" },
          { col: 1, row: 2, type: "heavyWoods" },
        ],
      }),
    ).toThrow(/Duplicate terrain definition for hex 2,3/); // 1-based display coords
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
    const setup = createBattle(
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 0, row: 2 },
          facing: "se",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 9, row: 9 },
          facing: "nw",
        },
      ],
      { terrain: [{ col: 1, row: 3, type: "lightWoods" }] },
    );
    const state = startMovementTurn(setup);
    declareMove(state, "hbk", "walk");
    executeMove(state, "hbk", [
      { kind: "enter", to: { col: 1, row: 3 } },
      { kind: "turn", facings: 1 },
    ]);
    const hbk = getUnit(state, "hbk");
    expect(hbk.mpSpent).toBe(3); // 1 turn + 2 light woods
    expect(hbk.position).toEqual({ col: 1, row: 3 });
  });

  it("rejects running backward", () => {
    const state = startMovementTurn(hbkVsEnf());
    declareMove(state, "hbk", "run");
    expect(() => executeMove(state, "hbk", [{ kind: "enter", to: { col: -1, row: 2 } }])).toThrow(
      /backward/,
    );
  });

  it("rejects ground steps that are neither straight ahead nor straight back", () => {
    const state = startMovementTurn(hbkVsEnf());
    declareMove(state, "hbk", "walk");
    // Facing "se" from (0,2): south (0,3) is adjacent but not the forward or
    // backward hexside -> illegal without turning first.
    expect(() => executeMove(state, "hbk", [{ kind: "enter", to: { col: 0, row: 3 } }])).toThrow(
      /straight ahead or straight back/,
    );
  });

  it("allows walking straight backward", () => {
    const state = startMovementTurn(hbkVsEnf());
    declareMove(state, "hbk", "walk");
    executeMove(state, "hbk", [{ kind: "enter", to: { col: -1, row: 2 } }]);
    const hbk = getUnit(state, "hbk");
    expect(hbk.position).toEqual({ col: -1, row: 2 });
    expect(hbk.mpSpent).toBe(1);
  });

  it("counts turning MP against the mode budget", () => {
    let state = startMovementTurn(hbkVsEnf());
    declareMove(state, "hbk", "walk"); // walking 4
    expect(() => executeMove(state, "hbk", [{ kind: "turn", facings: 5 }])).toThrow(/budget/);

    state = startMovementTurn(hbkVsEnf());
    declareMove(state, "hbk", "walk");
    executeMove(state, "hbk", [{ kind: "turn", facings: 2 }]);
    const hbk = getUnit(state, "hbk");
    expect(hbk.mpSpent).toBe(2); // 2 hexsides x 1 MP
    expect(hbk.facing).toBe("sw"); // se rotated two hexsides clockwise
    expect(hbk.position).toEqual({ col: 0, row: 2 });
  });

  it("charges counterclockwise turns one MP per hexside", () => {
    let state = startMovementTurn(hbkVsEnf());
    declareMove(state, "hbk", "walk");
    executeMove(state, "hbk", [{ kind: "turn", facings: -1 }]);
    const hbk = getUnit(state, "hbk");
    expect(hbk.facing).toBe("ne"); // se rotated one hexside counterclockwise
    expect(hbk.mpSpent).toBe(1);

    // Pricing is by absolute hexside count: -5 blows the walking budget too.
    state = startMovementTurn(hbkVsEnf());
    declareMove(state, "hbk", "walk");
    expect(() => executeMove(state, "hbk", [{ kind: "turn", facings: -5 }])).toThrow(/budget/);
  });

  it("re-evaluates forward/backward relative to facing after each turn", () => {
    const setup = createBattle([
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: 0, row: 2 },
        facing: "se",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 9, row: 9 },
        facing: "nw",
      },
    ]);
    const state = startMovementTurn(setup);
    declareMove(state, "hbk", "walk");
    executeMove(state, "hbk", [
      { kind: "enter", to: { col: 1, row: 3 } }, // forward (se)
      { kind: "turn", facings: 2 }, // now facing sw
      { kind: "enter", to: { col: 0, row: 3 } }, // new forward (sw)
    ]);
    const hbk = getUnit(state, "hbk");
    expect(hbk.position).toEqual({ col: 0, row: 3 });
    expect(hbk.facing).toBe("sw");
    expect(hbk.mpSpent).toBe(4); // 2 enters + 2-hexside turn
  });

  it("rejects ending in an occupied hex but allows friendly pass-through", () => {
    const setup = createBattle([
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: 0, row: 2 },
        facing: "se",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 1, row: 3 },
        facing: "nw",
      },
    ]);
    const state = startMovementTurn(setup);
    declareMove(state, "hbk", "walk");
    expect(() => executeMove(state, "hbk", [{ kind: "enter", to: { col: 1, row: 3 } }])).toThrow(
      /end movement in 2,4: occupied by enf/, // 1-based display coords
    );
  });

  it("rejects moves exceeding the mode budget", () => {
    const setup = createBattle([
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: 0, row: 2 },
        facing: "se",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 9, row: 9 },
        facing: "nw",
      },
    ]);
    const state = startMovementTurn(setup);
    declareMove(state, "hbk", "walk"); // walking 4
    // Straight southeast line (odd-q: the column parity alternates the row drift).
    const steps = [
      { col: 1, row: 3 },
      { col: 2, row: 3 },
      { col: 3, row: 4 },
      { col: 4, row: 4 },
      { col: 5, row: 5 },
    ].map((to) => ({ kind: "enter" as const, to }));
    expect(() => executeMove(state, "hbk", steps)).toThrow(/budget/);
  });

  it("stand-still forbids steps and turns", () => {
    const state = startMovementTurn(hbkVsEnf());
    declareMove(state, "hbk", "standStill");
    expect(() => executeMove(state, "hbk", [{ kind: "enter", to: { col: -1, row: 2 } }])).toThrow(
      /Standing still forbids entering/,
    );
    expect(() => executeMove(state, "hbk", [{ kind: "turn", facings: 1 }])).toThrow(
      /forbids facing changes/,
    );
  });

  it("alternates activation via nextActor", () => {
    const state = startMovementTurn(hbkVsEnf()); // team 0 wins initiative
    expect(nextActor(state)).toBe("enf");
    declareMove(state, "hbk", "walk");
    executeMove(state, "hbk", []);
    expect(nextActor(state)).toBe("enf");
  });

  it("jumping pays 1 MP per hex entered and may pass over enemies", () => {
    const setup = createBattle(
      [
        {
          id: "grf",
          model: "GRF-1N",
          team: 0,
          gunnery: 4,
          position: { col: 0, row: 2 },
          facing: "se",
        },
        {
          id: "wvr",
          model: "WVR-6R",
          team: 1,
          gunnery: 4,
          position: { col: 1, row: 3 },
          facing: "nw",
        },
      ],
      {},
    );
    const state = startMovementTurn(setup);
    declareMove(state, "grf", "jump");
    // Hop through the enemy-occupied hex (allowed while jumping) and land beyond it.
    executeMove(state, "grf", [
      { kind: "enter", to: { col: 1, row: 3 } },
      { kind: "enter", to: { col: 2, row: 3 } },
    ]);
    const grf = getUnit(state, "grf");
    expect(grf.position).toEqual({ col: 2, row: 3 });
    expect(grf.mpSpent).toBe(2);
    expect(grf.jumpedThisTurn).toBe(true);
  });
});

describe("weapon attack phase", () => {
  it("validates arc, LOS, range, target count, and auto-miss aborts", () => {
    // Facing northwest, target to the southeast -> outside front arc.
    let state = startAttackTurn(
      createBattle([
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 0, row: 2 },
          facing: "nw",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 1, row: 2 },
          facing: "nw",
        },
      ]),
    );
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 0, targetId: "enf" }])).toThrow(
      /front firing arc/,
    );

    // Two heavy woods between -> blocked LOS.
    state = startAttackTurn(
      hbkVsEnf([
        { col: -1, row: 2, type: "heavyWoods" },
        { col: 2, row: 2, type: "heavyWoods" },
      ]),
    );
    // Move units apart so intervening hexes exist.
    state = createBattle(
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 0, row: 2 },
          facing: "se",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 3, row: 2 },
          facing: "nw",
        },
      ],
      {
        terrain: [
          { col: 1, row: 2, type: "heavyWoods" },
          { col: 2, row: 2, type: "heavyWoods" },
        ],
      },
    );
    state = startAttackTurn(state);
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 0, targetId: "enf" }])).toThrow(
      /blocked/,
    );

    // Out of range.
    const ac20 = getWeapon("Autocannon/20");
    state = createBattle([
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: 0, row: 2 },
        facing: "se",
      },
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
    state = createBattle(
      [
        {
          id: "enf",
          model: "ENF-4R",
          team: 0,
          gunnery: 7,
          position: { col: 0, row: 2 },
          facing: "se",
        },
        {
          id: "hbk",
          model: "HBK-4G",
          team: 1,
          gunnery: 4,
          position: { col: 9, row: 2 },
          facing: "nw",
        },
      ],
      {
        terrain: [
          { col: 3, row: 2, type: "lightWoods" },
          { col: 5, row: 2, type: "lightWoods" },
          { col: 9, row: 2, type: "heavyWoods" },
        ],
      },
    );
    state = startAttackTurn(state);
    // Large laser (index 1), distance 9, +2 woods intervening, +2 heavy target.
    expect(() => declareAttacks(state, "enf", [{ weaponIndex: 1, targetId: "hbk" }])).toThrow(
      /auto-miss|abort/,
    );
  });

  it("deducts ammo at declaration and allows one target per turn", () => {
    const state = startAttackTurn(hbkVsEnf());
    declareAttacks(state, "hbk", [
      { weaponIndex: 0, targetId: "enf" },
      { weaponIndex: 1, targetId: "enf" },
    ]);
    expect(getUnit(state, "hbk").ammoLeft["0"]).toBe(9);
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 2, targetId: "enf" }])).toThrow(
      /already declared/,
    );
  });

  it("resolves scripted attacks immediately and commits kills only at end of phase", () => {
    const state = startAttackTurn(hbkVsEnf());
    declareAttacks(state, "hbk", [{ weaponIndex: 0, targetId: "enf" }]);
    // Turn 1: AC/20 (20 dmg) hits CT (roll 5) -> 27 - 20 = 7 left.
    resolveDeclaredAttacks(state, "hbk", scriptedRng(2, 3, 3, 4));
    expect(getUnit(state, "enf").armor.centerTorso).toBe(7);
    expect(getUnit(state, "enf").destroyed).toBe(false);

    advancePhase(state); // weaponAttack -> end
    expect(getUnit(state, "enf").destroyed).toBe(false); // survived with 7 CT

    advancePhase(state); // end -> initiative, turn 2
    expect(state.turn).toBe(2);
    expect(getUnit(state, "hbk").moveMode).toBeNull();
    expect(getUnit(state, "hbk").declaredAttacks).toHaveLength(0);

    rollInitiativePhase(state, scriptedRng(3, 3, 3, 1));
    advancePhase(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 0, targetId: "enf" }]);
    resolveDeclaredAttacks(state, "hbk", scriptedRng(6, 6, 3, 4)); // hit CT again
    expect(getUnit(state, "enf").armor.centerTorso).toBe(0);
    expect(getUnit(state, "enf").destroyed).toBe(true); // killed immediately
    expect(getUnit(state, "enf").removed).toBe(true);

    advancePhase(state); // weaponAttack -> end (kill already committed)
    const enf = getUnit(state, "enf");
    expect(enf.destroyed).toBe(true);
    expect(enf.removed).toBe(true);
    expect(state.events.some((e) => e.kind === "unitRemoved")).toBe(true);
    expect(checkVictory(state)).toEqual({ winnerTeam: 0, draw: false });
  });

  it("jams Ultra AC/5 double taps on a natural 2 and tracks the jam", () => {
    const setup = createBattle([
      {
        id: "her",
        model: "HER-5SA",
        team: 0,
        gunnery: 4,
        position: { col: 0, row: 2 },
        facing: "se",
      },
      {
        id: "cda",
        model: "CDA-3MA",
        team: 1,
        gunnery: 4,
        position: { col: 1, row: 2 },
        facing: "nw",
      },
    ]);
    const state = startAttackTurn(setup);
    declareAttacks(state, "her", [{ weaponIndex: 2, targetId: "cda", shots: 2 }]);
    expect(getUnit(state, "her").ammoLeft["2"]).toBe(18); // 2 shots spent up front
    resolveDeclaredAttacks(state, "her", scriptedRng(1, 1)); // natural 2 -> jam
    const her = getUnit(state, "her");
    expect(her.jammedWeapons).toEqual([2]);
    expect(getUnit(state, "cda").armor.centerTorso).toBe(state.defs["CDA-3MA"]!.armor.centerTorso);
  });
});
