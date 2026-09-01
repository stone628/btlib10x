import { describe, expect, it } from "vitest";
import { getMechDef } from "../src/data/index.js";
import { getWeaponOrThrow } from "../src/data/weapon.schema.js";
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
        position: { col: 2, row: 4 },
        facing: "se",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 3, row: 4 },
        facing: "nw",
      },
    ],
    { terrain, critsDisabled: true },
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
      position: { col: 2, row: 2 },
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
      position: { col: 2, row: 4 },
      facing: "se" as const,
    };
    const units = [
      { ...base, id: "a", team: 0 },
      { ...base, id: "b", team: 1 },
    ];
    expect(() =>
      createBattle(units, {
        terrain: [
          { col: 3, row: 4, type: "lightWoods" },
          { col: 3, row: 4, type: "heavyWoods" },
        ],
      }),
    ).toThrow(/Duplicate terrain definition for hex 3,4/);
  });

  it("initializes armor and ammo from the definition", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    expect(hbk.damage.armor).toEqual(getMechDef("HBK-4G")!.armor);
    expect(hbk.shotsLeft["1"]).toBe(10);
    expect(hbk.phaseStartDamage).toEqual(hbk.damage);
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
    expect(() => executeMove(state, "hbk", [{ kind: "enter", to: { col: 1, row: 4 } }])).toThrow(
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
          position: { col: 2, row: 4 },
          facing: "se",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 11, row: 11 },
          facing: "nw",
        },
      ],
      { terrain: [{ col: 3, row: 4, type: "lightWoods" }] },
    );
    const state = startMovementTurn(setup);
    declareMove(state, "hbk", "walk");
    executeMove(state, "hbk", [
      { kind: "enter", to: { col: 3, row: 4 } },
      { kind: "turn", facings: 1 },
    ]);
    const hbk = getUnit(state, "hbk");
    expect(hbk.mpSpent).toBe(3); // 1 turn + 2 light woods
    expect(hbk.position).toEqual({ col: 3, row: 4 });
  });

  it("rejects running backward", () => {
    const state = startMovementTurn(hbkVsEnf());
    declareMove(state, "hbk", "run");
    expect(() => executeMove(state, "hbk", [{ kind: "enter", to: { col: 1, row: 3 } }])).toThrow(
      /backward/,
    );
  });

  it("rejects ground steps that are neither straight ahead nor straight back", () => {
    const state = startMovementTurn(hbkVsEnf());
    declareMove(state, "hbk", "walk");
    // Facing "se" from (0,2): south (0,3) is adjacent but not the forward or
    // backward hexside -> illegal without turning first.
    expect(() => executeMove(state, "hbk", [{ kind: "enter", to: { col: 2, row: 5 } }])).toThrow(
      /straight ahead or straight back/,
    );
  });

  it("allows walking straight backward", () => {
    const state = startMovementTurn(hbkVsEnf());
    declareMove(state, "hbk", "walk");
    executeMove(state, "hbk", [{ kind: "enter", to: { col: 1, row: 3 } }]);
    const hbk = getUnit(state, "hbk");
    expect(hbk.position).toEqual({ col: 1, row: 3 });
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
    expect(hbk.position).toEqual({ col: 2, row: 4 });
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
        position: { col: 2, row: 4 },
        facing: "se",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 11, row: 11 },
        facing: "nw",
      },
    ]);
    const state = startMovementTurn(setup);
    declareMove(state, "hbk", "walk");
    executeMove(state, "hbk", [
      { kind: "enter", to: { col: 3, row: 4 } }, // forward (se)
      { kind: "turn", facings: 2 }, // now facing sw
      { kind: "enter", to: { col: 2, row: 5 } }, // new forward (sw)
    ]);
    const hbk = getUnit(state, "hbk");
    expect(hbk.position).toEqual({ col: 2, row: 5 });
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
        position: { col: 2, row: 4 },
        facing: "se",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 3, row: 4 },
        facing: "nw",
      },
    ]);
    const state = startMovementTurn(setup);
    declareMove(state, "hbk", "walk");
    expect(() => executeMove(state, "hbk", [{ kind: "enter", to: { col: 3, row: 4 } }])).toThrow(
      /end movement in 3,4: occupied by enf/,
    );
  });

  it("rejects moves exceeding the mode budget", () => {
    const setup = createBattle([
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: 2, row: 4 },
        facing: "se",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 11, row: 11 },
        facing: "nw",
      },
    ]);
    const state = startMovementTurn(setup);
    declareMove(state, "hbk", "walk"); // walking 4
    // Straight southeast line: even columns step se across at the same row,
    // odd columns step one row down, always one col over.
    const steps = [
      { col: 3, row: 4 },
      { col: 4, row: 5 },
      { col: 5, row: 5 },
      { col: 6, row: 6 },
      { col: 7, row: 6 },
    ].map((to) => ({ kind: "enter" as const, to }));
    expect(() => executeMove(state, "hbk", steps)).toThrow(/budget/);
  });

  it("stand-still forbids steps and turns", () => {
    const state = startMovementTurn(hbkVsEnf());
    declareMove(state, "hbk", "standStill");
    expect(() => executeMove(state, "hbk", [{ kind: "enter", to: { col: 1, row: 4 } }])).toThrow(
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
          position: { col: 2, row: 4 },
          facing: "se",
        },
        {
          id: "wvr",
          model: "WVR-6R",
          team: 1,
          gunnery: 4,
          position: { col: 3, row: 4 },
          facing: "nw",
        },
      ],
      {},
    );
    const state = startMovementTurn(setup);
    declareMove(state, "grf", "jump");
    // Hop through the enemy-occupied hex (allowed while jumping) and land beyond it.
    executeMove(state, "grf", [
      { kind: "enter", to: { col: 3, row: 4 } },
      { kind: "enter", to: { col: 4, row: 5 } },
    ]);
    const grf = getUnit(state, "grf");
    expect(grf.position).toEqual({ col: 4, row: 5 });
    expect(grf.mpSpent).toBe(2);
    expect(grf.jumpedThisTurn).toBe(true);
  });
});

describe("nextActor with unequal forces", () => {
  function fourVsTwo(teamOfFour: 0 | 1): BattleState {
    type Entry = {
      id: string;
      model: "HBK-4G" | "ENF-4R";
      team: 0 | 1;
      gunnery: number;
      position: { col: number; row: number };
      facing: "n" | "ne" | "se" | "s" | "sw" | "nw";
    };
    const units: Entry[] = [];
    for (let i = 0; i < 4; i++) {
      units.push({
        id: `a${i}`,
        model: "HBK-4G",
        team: teamOfFour,
        gunnery: 4,
        position: { col: i, row: 0 },
        facing: "ne",
      });
    }
    for (let i = 0; i < 2; i++) {
      units.push({
        id: `b${i}`,
        model: "ENF-4R",
        team: (1 - teamOfFour) as 0 | 1,
        gunnery: 4,
        position: { col: 5 + i, row: 0 },
        facing: "sw",
      });
    }
    return createBattle(units, { critsDisabled: true });
  }

  /** Walk every alive unit through declareMove + executeMove with empty paths, recording turn order. */
  function activationOrder(state: BattleState): string[] {
    const order: string[] = [];
    for (let step = 0; step < 6; step++) {
      const id = nextActor(state);
      if (id === null) break;
      order.push(id);
      declareMove(state, id, "standStill");
      executeMove(state, id, []);
    }
    return order;
  }

  it("spec example: team of 4 loses initiative, winner (team of 2) moves last", () => {
    // team0=4-Mech, team1=2-Mech. Roll initiative so team 1 wins.
    const state = startMovementTurn(fourVsTwo(0), scriptedRng(1, 1, 3, 3));
    expect(state.initiativeWinnerTeam).toBe(1);
    // Per §3: loser moves ⌊4/2⌋=2 units, winner moves 1, alternating starting with loser.
    expect(activationOrder(state)).toEqual(["a0", "a1", "b0", "a2", "a3", "b1"]);
  });

  it("team of 2 loses initiative: winner (team of 4) still moves last; loser (team of 2) goes first", () => {
    // team0=4-Mech, team1=2-Mech. team 0 wins via higher roll.
    const state = startMovementTurn(fourVsTwo(0), scriptedRng(3, 3, 1, 1));
    expect(state.initiativeWinnerTeam).toBe(0);
    const order = activationOrder(state);
    expect(order[0]).toMatch(/^b/); // loser (team 1) moves first
    expect(order.at(-1)).toMatch(/^a/); // winner (team 0) moves last
    expect(order.filter((id) => id.startsWith("b"))).toEqual(["b0", "b1"]);
    expect(order.filter((id) => id.startsWith("a"))).toEqual(["a0", "a1", "a2", "a3"]);
  });

  it("winner of initiative always moves last regardless of which side is larger", () => {
    // 4-Mech on team 1 (iterates first, so team 1 rolls first). Larger side wins.
    const largerWins = startMovementTurn(fourVsTwo(1), scriptedRng(3, 3, 1, 1));
    expect(largerWins.initiativeWinnerTeam).toBe(1);
    expect(activationOrder(largerWins).at(-1)).toBe("a3");

    // 4-Mech on team 0 (iterates first, so team 0 rolls first). Larger side wins.
    const largerWinsAlso = startMovementTurn(fourVsTwo(0), scriptedRng(3, 3, 1, 1));
    expect(largerWinsAlso.initiativeWinnerTeam).toBe(0);
    expect(activationOrder(largerWinsAlso).at(-1)).toBe("a3");
  });

  it("with equal force sizes, ordering falls back to simple loser-first alternation", () => {
    const state = startMovementTurn(hbkVsEnf());
    expect(state.initiativeWinnerTeam).toBe(0);
    expect(activationOrder(state)).toEqual(["enf", "hbk"]);
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
          position: { col: 2, row: 4 },
          facing: "nw",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 3, row: 4 },
          facing: "nw",
        },
      ]),
    );
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }])).toThrow(
      /front firing arc/,
    );

    // Two heavy woods between -> blocked LOS.
    state = startAttackTurn(
      hbkVsEnf([
        { col: 1, row: 4, type: "heavyWoods" },
        { col: 4, row: 4, type: "heavyWoods" },
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
          position: { col: 2, row: 4 },
          facing: "se",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 5, row: 4 },
          facing: "nw",
        },
      ],
      {
        terrain: [
          { col: 3, row: 4, type: "heavyWoods" },
          { col: 4, row: 4, type: "heavyWoods" },
        ],
      },
    );
    state = startAttackTurn(state);
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }])).toThrow(
      /blocked/,
    );

    // Out of range.
    const ac20 = getWeaponOrThrow("Autocannon/20");
    state = createBattle([
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: 2, row: 4 },
        facing: "se",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: ac20.long + 3, row: 2 },
        facing: "nw",
      },
    ]);
    state = startAttackTurn(state);
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }])).toThrow(
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
          position: { col: 2, row: 4 },
          facing: "se",
        },
        {
          id: "hbk",
          model: "HBK-4G",
          team: 1,
          gunnery: 4,
          position: { col: 11, row: 4 },
          facing: "nw",
        },
      ],
      {
        terrain: [
          { col: 5, row: 4, type: "lightWoods" },
          { col: 7, row: 4, type: "lightWoods" },
          { col: 11, row: 4, type: "heavyWoods" },
        ],
      },
    );
    state = startAttackTurn(state);
    // Large laser (array index 1 -> weaponIndex 2), distance 9, +2 woods intervening, +2 heavy target.
    expect(() => declareAttacks(state, "enf", [{ weaponIndex: 2, targetId: "hbk" }])).toThrow(
      /auto-miss|abort/,
    );
  });

  it("deducts ammo at declaration and allows one target per turn", () => {
    const state = startAttackTurn(hbkVsEnf());
    declareAttacks(state, "hbk", [
      { weaponIndex: 1, targetId: "enf" },
      { weaponIndex: 2, targetId: "enf" },
    ]);
    expect(getUnit(state, "hbk").shotsLeft["1"]).toBe(9);
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 3, targetId: "enf" }])).toThrow(
      /already declared/,
    );
  });

  it("rejects declaring the same weapon more than once per turn", () => {
    const state = startAttackTurn(hbkVsEnf());
    expect(() =>
      declareAttacks(state, "hbk", [
        { weaponIndex: 1, targetId: "enf" },
        { weaponIndex: 1, targetId: "enf" },
      ]),
    ).toThrow(/may only be declared once/);
  });

  it("resolves scripted attacks immediately and commits kills only at end of phase", () => {
    const state = startAttackTurn(hbkVsEnf());
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }]);
    // Turn 1: AC/20 (20 dmg) hits CT (roll 5) -> front 23 - 20 = 3 left.
    resolveDeclaredAttacks(state, "hbk", scriptedRng(2, 3, 3, 4));
    expect(getUnit(state, "enf").damage.armor.centerTorso).toBe(3);
    expect(getUnit(state, "enf").destroyed).toBe(false);

    advancePhase(state); // weaponAttack -> end
    expect(getUnit(state, "enf").destroyed).toBe(false); // survived with 3 CT

    advancePhase(state); // end -> initiative, turn 2
    expect(state.turn).toBe(2);
    expect(getUnit(state, "hbk").moveMode).toBeNull();
    expect(getUnit(state, "hbk").declaredAttacks).toHaveLength(0);

    rollInitiativePhase(state, scriptedRng(3, 3, 3, 1));
    advancePhase(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }]);
    resolveDeclaredAttacks(state, "hbk", scriptedRng(6, 6, 3, 4)); // hit CT again
    expect(getUnit(state, "enf").damage.armor.centerTorso).toBe(0);
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
        position: { col: 2, row: 4 },
        facing: "se",
      },
      {
        id: "cda",
        model: "CDA-3MA",
        team: 1,
        gunnery: 4,
        position: { col: 3, row: 4 },
        facing: "nw",
      },
    ]);
    const state = startAttackTurn(setup);
    declareAttacks(state, "her", [{ weaponIndex: 3, targetId: "cda", rapidFire: true }]);
    expect(getUnit(state, "her").shotsLeft["3"]).toBe(18); // 2 shots spent up front
    resolveDeclaredAttacks(state, "her", scriptedRng(1, 1)); // natural 2 -> jam
    const her = getUnit(state, "her");
    expect(her.jammedWeapons).toEqual([3]);
    expect(getUnit(state, "cda").damage.armor.centerTorso).toBe(
      getMechDef("CDA-3MA")!.armor.centerTorso,
    );
  });

  it("fires a single shot by default and a double-tap only when rapidFire is set on an Ultra AC/5", () => {
    const setup = () =>
      createBattle([
        {
          id: "her",
          model: "HER-5SA",
          team: 0,
          gunnery: 4,
          position: { col: 2, row: 4 },
          facing: "se",
        },
        {
          id: "cda",
          model: "CDA-3MA",
          team: 1,
          gunnery: 4,
          position: { col: 3, row: 4 },
          facing: "nw",
        },
      ]);

    // Omitted rapidFire -> single shot (1 UAC/5 hit = 5 dmg, 1 ammo spent).
    const single = startAttackTurn(setup());
    declareAttacks(single, "her", [{ weaponIndex: 3, targetId: "cda" }]);
    expect(getUnit(single, "her").shotsLeft["3"]).toBe(19); // 1 shot spent up front
    const singleBefore = getUnit(single, "cda").damage.armor.centerTorso;
    // to-hit 4 (2,2), single location rolls 7 -> CT (no cluster roll for 1 shot).
    resolveDeclaredAttacks(single, "her", scriptedRng(2, 2, 3, 4));
    expect(singleBefore - getUnit(single, "cda").damage.armor.centerTorso).toBe(5);

    // rapidFire: true -> double-tap (2 x UAC/5 = 10 dmg, 2 ammo spent).
    const state = startAttackTurn(setup());
    declareAttacks(state, "her", [{ weaponIndex: 3, targetId: "cda", rapidFire: true }]);
    expect(getUnit(state, "her").shotsLeft["3"]).toBe(18); // 2 shots spent up front
    const before = getUnit(state, "cda").damage.armor.centerTorso;
    // to-hit 4 (2,2), cluster 8 (4,4) -> both shots hit; both hit CT (roll 7).
    resolveDeclaredAttacks(state, "her", scriptedRng(2, 2, 4, 4, 3, 4, 3, 4));
    expect(before - getUnit(state, "cda").damage.armor.centerTorso).toBe(10);
  });

  it("rejects rapidFire on a weapon that is not rapid-fire", () => {
    const state = startAttackTurn(hbkVsEnf());
    // HBK weapon 4 is a Small Laser (no rapidFireShots).
    expect(() =>
      declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf", rapidFire: true }]),
    ).toThrow(/is not rapid-fire/);
  });
});

describe("passedAttacks", () => {
  it("nextActor skips units that have passed this phase", () => {
    const state = startAttackTurn(hbkVsEnf());
    expect(nextActor(state)).toBe("enf");
    getUnit(state, "enf").passedAttacks = true;
    expect(nextActor(state)).toBe("hbk");
  });

  it("passedAttacks resets at the end of the turn", () => {
    const state = startAttackTurn(hbkVsEnf());
    getUnit(state, "enf").passedAttacks = true;
    advancePhase(state); // weaponAttack -> end
    advancePhase(state); // end -> initiative, turn 2
    expect(getUnit(state, "enf").passedAttacks).toBe(false);
  });
});
