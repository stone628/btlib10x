import { describe, expect, it } from "vitest";
import { getMechDef } from "../src/data/index.js";
import { getWeaponDefFor } from "../src/data/weapon.schema.js";
import { ammoWeaponTotals, pooledShotsLeft } from "../src/rules/ammo.js";
import type { BattleState, TerrainHexDef, UnitInit } from "../src/rules/game.js";
import {
  actorQueue,
  advancePhase,
  checkVictory,
  declareAttacks,
  executeMove,
  getUnit,
  nextActor,
  resolveAllAttacks,
  rollInitiativePhase,
} from "../src/rules/game.js";
import { resolutionLines } from "../web/format.js";
import { createTestBattle, scriptedRng } from "./helpers.js";

function hbkVsEnf(terrain: readonly TerrainHexDef[] = []): BattleState {
  const units: UnitInit[] = [
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
      position: { col: 3, row: 5 },
      facing: "nw",
    },
  ];
  return createTestBattle(terrain, units, true);
}

/** Initiative rolls the first-inserted unit's team low (1+1) so it loses
 *  and acts first. Tests asserting a specific initiative winner pass an
 *  explicit `rng`. */
function startMovementTurn(state: BattleState, rng = scriptedRng(1, 1, 4, 4)): BattleState {
  rollInitiativePhase(state, rng);
  return state;
}

/** Movement phase resolved with nobody moving -> ready for weapon attacks. */
function startAttackTurn(
  state: BattleState,
  rng: ReturnType<typeof scriptedRng> = scriptedRng(1, 1, 4, 4),
): BattleState {
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
    expect(() => createTestBattle([], [base, base], false)).toThrow(/Duplicate unit id/);
    expect(() =>
      createTestBattle([], [base, { ...base, id: "b", model: "MAD-3R" }], false),
    ).toThrow(/Unknown 'Mech model/);
    expect(() => createTestBattle([], [base, { ...base, id: "b", gunnery: 8 }], false)).toThrow(
      /Gunnery/,
    );
  });

  it("rejects duplicate terrain hex definitions", () => {
    const base = {
      model: "HBK-4G",
      gunnery: 4,
      position: { col: 2, row: 4 },
      facing: "se" as const,
    };
    const units: UnitInit[] = [
      { ...base, id: "a", team: 0 },
      { ...base, id: "b", team: 1 },
    ];
    expect(() =>
      createTestBattle(
        [
          { col: 3, row: 4, type: "lightWoods" },
          { col: 3, row: 4, type: "heavyWoods" },
        ],
        units,
        false,
        4,
        5,
      ),
    ).toThrow(/Duplicate terrain definition for hex 3,4/);
  });

  it("initializes armor and ammo from the definition", () => {
    const state = hbkVsEnf();
    const hbk = getUnit(state, "hbk");
    expect(hbk.damage.armor).toEqual(getMechDef("HBK-4G")!.armor);
    expect(ammoWeaponTotals(getMechDef("HBK-4G")!, hbk.ammoBins)["4"]).toBe(10);
    expect(hbk.phaseStartDamage).toEqual(hbk.damage);
    expect(state.phase).toBe("initiative");
    expect(state.turn).toBe(1);
  });
});

describe("movement phase", () => {
  it("enforces phase ordering", () => {
    expect(() => executeMove(hbkVsEnf(), "hbk", "walk", [])).toThrow(/phase/);
  });

  it("charges MP for terrain and facing changes within budget", () => {
    const units: UnitInit[] = [
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
    ];
    const setup = createTestBattle([{ col: 3, row: 5, type: "lightWoods" }], units, true);
    const state = startMovementTurn(setup);
    executeMove(state, "hbk", "walk", [
      { kind: "enter", to: { col: 3, row: 5 } },
      { kind: "turn", facings: 1 },
    ]);
    const hbk = getUnit(state, "hbk");
    expect(hbk.mpSpent).toBe(3); // 1 turn + 2 light woods
    expect(hbk.position).toEqual({ col: 3, row: 5 });
  });

  it("rejects running backward", () => {
    const state = startMovementTurn(hbkVsEnf());
    expect(() =>
      executeMove(state, "hbk", "run", [{ kind: "enter", to: { col: 1, row: 4 } }]),
    ).toThrow(/backward/);
  });

  it("rejects ground steps that are neither straight ahead nor straight back", () => {
    const state = startMovementTurn(hbkVsEnf());
    // Facing "se" from (2,4): south (2,5) is adjacent but not the forward or
    // backward hexside -> illegal without turning first.
    expect(() =>
      executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 2, row: 5 } }]),
    ).toThrow(/straight ahead or straight back/);
  });

  it("allows walking straight backward", () => {
    const state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 1, row: 4 } }]);
    const hbk = getUnit(state, "hbk");
    expect(hbk.position).toEqual({ col: 1, row: 4 });
    expect(hbk.mpSpent).toBe(1);
  });

  it("rejects a backward step that changes level", () => {
    const state = startMovementTurn(hbkVsEnf([{ col: 1, row: 4, type: "clear", level: 1 }]));
    expect(() =>
      executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 1, row: 4 } }]),
    ).toThrow(/cannot change level/);
  });

  it("charges +1 MP to descend a level and caps forward level change at 2", () => {
    // hbk at (2,4) level 1 facing se: turn s (1 MP), enter (2,5) level 0
    // (1 MP + 1 descent) = 3 total.
    const state = startMovementTurn(
      hbkVsEnf([
        { col: 2, row: 4, type: "clear", level: 1 },
        { col: 2, row: 5, type: "clear", level: 0 },
      ]),
    );
    executeMove(state, "hbk", "walk", [
      { kind: "turn", facings: 1 },
      { kind: "enter", to: { col: 2, row: 5 } },
    ]);
    expect(getUnit(state, "hbk").mpSpent).toBe(3);

    // A 2-level climb forward is legal: turn s (1 MP), enter (2,5) at level 2
    // (1 MP + 2 climb) = 4 total.
    const state2 = startMovementTurn(
      hbkVsEnf([
        { col: 2, row: 4, type: "clear", level: 0 },
        { col: 2, row: 5, type: "clear", level: 2 },
      ]),
    );
    executeMove(state2, "hbk", "walk", [
      { kind: "turn", facings: 1 },
      { kind: "enter", to: { col: 2, row: 5 } },
    ]);
    expect(getUnit(state2, "hbk").mpSpent).toBe(4);
  });

  it("counts turning MP against the mode budget", () => {
    let state = startMovementTurn(hbkVsEnf());
    expect(() => executeMove(state, "hbk", "walk", [{ kind: "turn", facings: 5 }])).toThrow(
      /budget/,
    );

    state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "walk", [{ kind: "turn", facings: 2 }]);
    const hbk = getUnit(state, "hbk");
    expect(hbk.mpSpent).toBe(2); // 2 hexsides x 1 MP
    expect(hbk.facing).toBe("sw"); // se rotated two hexsides clockwise
    expect(hbk.position).toEqual({ col: 2, row: 4 });
  });

  it("charges counterclockwise turns one MP per hexside", () => {
    let state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "walk", [{ kind: "turn", facings: -1 }]);
    const hbk = getUnit(state, "hbk");
    expect(hbk.facing).toBe("ne"); // se rotated one hexside counterclockwise
    expect(hbk.mpSpent).toBe(1);

    // Pricing is by absolute hexside count: -5 blows the walking budget too.
    state = startMovementTurn(hbkVsEnf());
    expect(() => executeMove(state, "hbk", "walk", [{ kind: "turn", facings: -5 }])).toThrow(
      /budget/,
    );
  });

  it("re-evaluates forward/backward relative to facing after each turn", () => {
    const units: UnitInit[] = [
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
    ];
    const setup = createTestBattle([], units, true);
    const state = startMovementTurn(setup);
    executeMove(state, "hbk", "walk", [
      { kind: "enter", to: { col: 3, row: 5 } }, // forward (se)
      { kind: "turn", facings: 2 }, // now facing sw
      { kind: "enter", to: { col: 2, row: 5 } }, // new forward (sw)
    ]);
    const hbk = getUnit(state, "hbk");
    expect(hbk.position).toEqual({ col: 2, row: 5 });
    expect(hbk.facing).toBe("sw");
    expect(hbk.mpSpent).toBe(4); // 2 enters + 2-hexside turn
  });

  it("rejects ending in an occupied hex but allows friendly pass-through", () => {
    const units: UnitInit[] = [
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
        position: { col: 3, row: 5 },
        facing: "nw",
      },
    ];
    const setup = createTestBattle([], units, true);
    const state = startMovementTurn(setup);
    expect(() =>
      executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 3, row: 5 } }]),
    ).toThrow(/end movement in 3,5: occupied by enf/);
  });

  it("rejects moves exceeding the mode budget", () => {
    const units: UnitInit[] = [
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
    ];
    const setup = createTestBattle([], units, true);
    const state = startMovementTurn(setup);
    // Straight southeast line: even columns step se down to the next row,
    // odd columns step se across at the same row, always one col over.
    const steps = [
      { col: 3, row: 5 },
      { col: 4, row: 5 },
      { col: 5, row: 6 },
      { col: 6, row: 6 },
      { col: 7, row: 7 },
    ].map((to) => ({ kind: "enter" as const, to }));
    expect(() => executeMove(state, "hbk", "walk", steps)).toThrow(/budget/);
  });

  it("stand-still forbids steps and turns", () => {
    const state = startMovementTurn(hbkVsEnf());
    expect(() =>
      executeMove(state, "hbk", "standStill", [{ kind: "enter", to: { col: 1, row: 4 } }]),
    ).toThrow(/Standing still forbids entering/);
    expect(() => executeMove(state, "hbk", "standStill", [{ kind: "turn", facings: 1 }])).toThrow(
      /forbids facing changes/,
    );
  });

  it("alternates activation via nextActor", () => {
    const state = startMovementTurn(hbkVsEnf()); // first-iterated team loses
    expect(nextActor(state)).toBe("hbk");
    executeMove(state, "hbk", "walk", []);
    expect(nextActor(state)).toBe("enf");
  });

  it("jumping pays 1 MP per hex entered and may pass over enemies", () => {
    const units: UnitInit[] = [
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
    ];
    const setup = createTestBattle([], units, false);
    const state = startMovementTurn(setup);
    // Hop through the enemy-occupied hex (allowed while jumping) and land beyond it.
    executeMove(state, "grf", "jump", [
      { kind: "enter", to: { col: 3, row: 4 } },
      { kind: "enter", to: { col: 4, row: 4 } },
    ]);
    const grf = getUnit(state, "grf");
    expect(grf.position).toEqual({ col: 4, row: 4 });
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
    return createTestBattle([], units, true);
  }

  /** Walk every alive unit through declareMove + executeMove with empty paths, recording turn order. */
  function activationOrder(state: BattleState): string[] {
    const order: string[] = [];
    for (let step = 0; step < 6; step++) {
      const id = nextActor(state);
      if (id === null) break;
      order.push(id);
      executeMove(state, id, "standStill", []);
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
    expect(state.initiativeWinnerTeam).toBe(1);
    expect(activationOrder(state)).toEqual(["hbk", "enf"]);
  });
});

describe("actorQueue", () => {
  /** 4-vs-2 state with team 1 winning initiative (see fourVsTwo above). */
  function fourVsTwoState(): BattleState {
    const units: UnitInit[] = [];
    for (let i = 0; i < 4; i++) {
      units.push({
        id: `a${i}`,
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: i, row: 0 },
        facing: "ne",
      });
    }
    for (let i = 0; i < 2; i++) {
      units.push({
        id: `b${i}`,
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 5 + i, row: 0 },
        facing: "sw",
      });
    }
    return startMovementTurn(createTestBattle([], units, true), scriptedRng(1, 1, 3, 3));
  }

  it("fresh movement phase orders loser-first alternation and matches nextActor", () => {
    const state = startMovementTurn(hbkVsEnf()); // first-iterated team loses
    const q = actorQueue(state);
    expect(q.acted).toEqual([]);
    expect(q.pending.map((av) => av.id)).toEqual(["hbk", "enf"]);
    expect(q.pending[0]?.id).toBe(nextActor(state));
  });

  it("moves acted units from pending to acted", () => {
    const state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "walk", []);
    const q = actorQueue(state);
    expect(q.acted.map((av) => av.id)).toEqual(["hbk"]);
    expect(q.pending.map((av) => av.id)).toEqual(["enf"]);
    expect(nextActor(state)).toBe("enf");
  });

  it("weaponAttack queue excludes shutdown and passed units", () => {
    const state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "walk", []);
    advancePhase(state); // movement -> weaponAttack
    getUnit(state, "hbk").shutdown = "heat";
    getUnit(state, "enf").passedAttacks = true;
    const q = actorQueue(state);
    expect(q.acted).toEqual([]);
    expect(q.pending).toEqual([]);
  });

  it("rebuilds per phase with a fresh acted pool", () => {
    const state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "walk", []);
    executeMove(state, "enf", "walk", []);
    expect(actorQueue(state).acted.map((av) => av.id)).toEqual(["hbk", "enf"]);
    advancePhase(state); // movement -> weaponAttack
    const q = actorQueue(state);
    expect(q.acted.map((av) => av.id)).toEqual([]);
    expect(q.pending.map((av) => av.id)).toEqual(["hbk", "enf"]);
  });

  it("matches the unequal-force activation order", () => {
    const state = fourVsTwoState();
    expect(actorQueue(state).pending.map((av) => av.id)).toEqual([
      "a0",
      "a1",
      "b0",
      "a2",
      "a3",
      "b1",
    ]);
  });

  it("front-loads shut-down units in the movement phase", () => {
    const state = startMovementTurn(hbkVsEnf(), scriptedRng(2, 2, 6, 6)); // team 1 wins
    getUnit(state, "hbk").shutdown = "heat";
    const q = actorQueue(state);
    expect(q.pending.map((av) => av.id)).toEqual(["hbk", "enf"]);
    expect(nextActor(state)).toBe("hbk");
  });
});

describe("weapon attack phase", () => {
  it("classifies the firing arc of accepted side and rear attacks", () => {
    // HBK-4G mounts: 1 = ML leftArm, 2 = ML rightArm, 3 = SL head, 4 = AC/20
    // rightTorso. Per-weapon firing arcs (TW p.105) gate the declaration.
    const cases: Array<{
      facing: string;
      targetPos: { col: number; row: number };
      expected: string;
      expectedDir: string;
      weaponIndex: number;
    }> = [
      // Target east-southeast -> rear arc; no HBK weapon bears (throws below).
      {
        facing: "nw",
        targetPos: { col: 3, row: 5 },
        expected: "rear",
        expectedDir: "",
        weaponIndex: 0,
      },
      // Target to the northeast (exactly on the n|ne boundary) -> right side
      // arc on both candidate bearings; only the right-arm ML fires.
      {
        facing: "nw",
        targetPos: { col: 3, row: 3 },
        expected: "rightSide",
        expectedDir: "leftSide",
        weaponIndex: 2,
      },
      // Target due south -> left side arc; only the left-arm ML fires.
      {
        facing: "nw",
        targetPos: { col: 2, row: 5 },
        expected: "leftSide",
        expectedDir: "rightSide",
        weaponIndex: 1,
      },
      // Target to the northwest -> front arc; any weapon fires. The attacker
      // stands behind the nw-facing target, so the attack direction is rear.
      {
        facing: "nw",
        targetPos: { col: 1, row: 4 },
        expected: "front",
        expectedDir: "rear",
        weaponIndex: 4,
      },
    ];
    for (const c of cases) {
      const units: UnitInit[] = [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 2, row: 4 },
          facing: c.facing as UnitInit["facing"],
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: c.targetPos,
          facing: "nw",
        },
      ];
      const state = startAttackTurn(createTestBattle([], units, true));
      if (c.weaponIndex === 0) {
        // Rear arc: no front/side weapon may be declared into it.
        for (const wi of [1, 2, 3, 4]) {
          expect(() =>
            declareAttacks(state, "hbk", [{ weaponIndex: wi, targetId: "enf" }]),
          ).toThrow(/cannot fire into the rear arc/);
        }
        continue;
      }
      declareAttacks(state, "hbk", [{ weaponIndex: c.weaponIndex, targetId: "enf" }]);
      expect(state.units.hbk!.declaredAttacks).toEqual([
        expect.objectContaining({
          weaponIndex: c.weaponIndex,
          targetId: "enf",
          arc: c.expected,
          attackDirection: c.expectedDir,
        }),
      ]);
    }
  });

  it("blocks weapons whose mounting arc does not cover the target", () => {
    // Target due south of a nw-facing attacker -> left side arc: the
    // right-arm ML, head SL and right-torso AC/20 may not fire.
    const units: UnitInit[] = [
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
        position: { col: 2, row: 5 },
        facing: "nw",
      },
    ];
    const state = startAttackTurn(createTestBattle([], units, true));
    for (const wi of [2, 3, 4]) {
      expect(() => declareAttacks(state, "hbk", [{ weaponIndex: wi, targetId: "enf" }])).toThrow(
        /cannot fire into the leftSide arc/,
      );
    }
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }]);
    expect(state.units.hbk!.declaredAttacks[0]).toEqual(
      expect.objectContaining({ weaponIndex: 1, arc: "leftSide" }),
    );
  });

  it("resolves attack direction against the TARGET's facing (rear armor)", () => {
    // Attacker faces the target squarely (front firing arc) but stands in
    // the target's rear arc: hits roll on the front/rear column and drain
    // the rear torso armor pool.
    const units: UnitInit[] = [
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
        position: { col: 3, row: 5 },
        facing: "se", // facing away from the attacker
      },
    ];
    const state = startAttackTurn(createTestBattle([], units, true));
    declareAttacks(state, "hbk", [{ weaponIndex: 2, targetId: "enf" }]);
    const decl = state.units.hbk!.declaredAttacks[0]!;
    expect(decl.arc).toBe("front");
    expect(decl.attackDirection).toBe("rear");
    const rearBefore = getUnit(state, "enf").damage.armorRear.centerTorso!;
    const frontBefore = getUnit(state, "enf").damage.armor.centerTorso;
    const isBefore = getUnit(state, "enf").damage.internalStructure.centerTorso;
    // to-hit 12 (6,6) hits; location 7 (3,4) -> center torso; 5 ML damage
    // strips the 4-point rear pool then 1 internal structure.
    resolveAllAttacks(state, scriptedRng(6, 6, 3, 4));
    const enf = getUnit(state, "enf");
    expect(rearBefore).toBe(4);
    expect(enf.damage.armorRear.centerTorso!).toBe(0);
    expect(enf.damage.internalStructure.centerTorso).toBe(isBefore - 1);
    expect(enf.damage.armor.centerTorso).toBe(frontBefore);
    const event = state.events.find((e) => e.kind === "attackResolved")!;
    expect(event.kind === "attackResolved" && event.resolution.arc).toBe("rear");
  });

  it("rolls side-arc attacks on the side hit-location table", () => {
    // Attacker in the target's LEFT side: location roll 4 -> left arm on the
    // left-side column (front column would give right arm).
    const units: UnitInit[] = [
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
        position: { col: 3, row: 5 },
        facing: "ne", // attacker lies in its left side arc
      },
    ];
    const state = startAttackTurn(createTestBattle([], units, true));
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }]);
    const decl = state.units.hbk!.declaredAttacks[0]!;
    expect(decl.arc).toBe("front");
    expect(decl.attackDirection).toBe("leftSide");
    // to-hit 12 (6,6) hits; location 4 (2,2) -> leftArm on the left-side table.
    resolveAllAttacks(state, scriptedRng(6, 6, 2, 2));
    const event = state.events.find((e) => e.kind === "attackResolved")!;
    if (event.kind !== "attackResolved") throw new Error("bad event");
    expect(event.resolution.groups).toEqual([
      { location: "leftArm", damage: 5, throughArmor: false },
    ]);
    expect(event.resolution.arc).toBe("leftSide");
  });

  it("lets rear-facing torso weapons fire into the rear arc only (AS7-D)", () => {
    const units: UnitInit[] = [
      {
        id: "as7",
        model: "AS7-D",
        team: 0,
        gunnery: 4,
        position: { col: 2, row: 4 },
        facing: "nw", // target sits in the rear arc
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 3, row: 5 },
        facing: "nw",
      },
    ];
    const state = startAttackTurn(createTestBattle([], units, true));
    // Front-firing weapons reject the rear-arc target.
    expect(() => declareAttacks(state, "as7", [{ weaponIndex: 3, targetId: "enf" }])).toThrow(
      /cannot fire into the rear arc/,
    );
    // The two rear-facing CT Medium Lasers (indices 1-2) bear.
    declareAttacks(state, "as7", [
      { weaponIndex: 1, targetId: "enf" },
      { weaponIndex: 2, targetId: "enf" },
    ]);
    expect(state.units.as7!.declaredAttacks).toHaveLength(2);
  });

  it("validates LOS, range, target count, and auto-miss aborts", () => {
    let units: UnitInit[] = [];
    let state: BattleState;

    // Two heavy woods between -> blocked LOS.
    state = startAttackTurn(
      hbkVsEnf([
        { col: 1, row: 4, type: "heavyWoods" },
        { col: 4, row: 4, type: "heavyWoods" },
      ]),
    );
    // Move units apart so intervening hexes exist.
    units = [
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
    ];
    state = createTestBattle(
      [
        { col: 3, row: 4, type: "heavyWoods" },
        { col: 4, row: 4, type: "heavyWoods" },
      ],
      units,
      true,
    );
    state = startAttackTurn(state);
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }])).toThrow(
      /blocked/,
    );

    // Out of range.
    const ac20 = getWeaponDefFor({ weapon: "AC/20" });
    units = [
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
    ];
    state = createTestBattle([], units, true);
    state = startAttackTurn(state);
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }])).toThrow(
      /long range/,
    );

    // Modified TN > 12 must be aborted at declaration.
    units = [
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
    ];
    state = createTestBattle(
      [
        { col: 5, row: 4, type: "lightWoods" },
        { col: 7, row: 4, type: "lightWoods" },
        { col: 11, row: 4, type: "heavyWoods" },
      ],
      units,
      true,
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
      { weaponIndex: 4, targetId: "enf" },
      { weaponIndex: 2, targetId: "enf" },
    ]);
    expect(ammoWeaponTotals(getMechDef("HBK-4G")!, getUnit(state, "hbk").ammoBins)["4"]).toBe(9);
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 2, targetId: "enf" }])).toThrow(
      /current actor/,
    );
  });

  it("rejects declaring the same weapon more than once per turn", () => {
    const state = startAttackTurn(hbkVsEnf());
    expect(() =>
      declareAttacks(state, "hbk", [
        { weaponIndex: 4, targetId: "enf" },
        { weaponIndex: 4, targetId: "enf" },
      ]),
    ).toThrow(/may only be declared once/);
  });

  it("resolves scripted attacks immediately and commits kills only at end of phase", () => {
    const state = startAttackTurn(hbkVsEnf());
    declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }]);
    // Turn 1: AC/20 (20 dmg) hits CT (roll 5) -> CT 27 - 20 = 7 left.
    // 20+ damage PSR (needs 6: 3+3 succeeds, no fall).
    resolveAllAttacks(state, scriptedRng(2, 3, 3, 4, 3, 3));
    expect(getUnit(state, "enf").damage.armor.centerTorso).toBe(7);
    expect(getUnit(state, "enf").destroyed).toBe("not");

    advancePhase(state); // weaponAttack -> end
    expect(getUnit(state, "enf").destroyed).toBe("not"); // survived with 7 CT

    advancePhase(state); // end -> initiative, turn 2
    expect(state.turn).toBe(2);
    expect(getUnit(state, "hbk").moveMode).toBeNull();
    expect(getUnit(state, "hbk").declaredAttacks).toHaveLength(0);

    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4));
    advancePhase(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }]);
    resolveAllAttacks(state, scriptedRng(6, 6, 3, 4, 3, 3)); // hit CT again
    expect(getUnit(state, "enf").damage.armor.centerTorso).toBe(0);
    expect(getUnit(state, "enf").destroyed).toBe("not"); // CT IS still up (16-13=3)

    advancePhase(state); // weaponAttack -> end
    advancePhase(state); // end -> initiative, turn 3
    expect(state.turn).toBe(3);
    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4));
    advancePhase(state);
    declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }]);
    resolveAllAttacks(state, scriptedRng(6, 6, 3, 4)); // CT IS gone
    expect(getUnit(state, "enf").destroyed).toBe("centerTorsoDestroyed"); // killed immediately
    expect(getUnit(state, "enf").removed).toBe("destroyed");

    advancePhase(state); // weaponAttack -> end (kill already committed)
    const enf = getUnit(state, "enf");
    expect(enf.destroyed).toBe("centerTorsoDestroyed");
    expect(enf.removed).toBe("destroyed");
    expect(state.events.some((e) => e.kind === "unitRemoved")).toBe(true);
    expect(checkVictory(state)).toEqual({ winnerTeam: 0, draw: false });
  });

  it("resolves attacks simultaneously: a unit killed by an earlier attacker still fires", () => {
    const state = hbkVsEnf();
    // Enforcer center torso is one AC/20 hit from death (armor 0, IS 5).
    const enf = getUnit(state, "enf");
    enf.damage.armor.centerTorso = 0;
    enf.damage.internalStructure.centerTorso = 5;
    const hbkCt = () => getUnit(state, "hbk").damage.armor.centerTorso;

    startAttackTurn(state);
    // Both declare before resolution; roster order puts hbk first.
    declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }]); // AC/20 (1-based)
    declareAttacks(state, "enf", [{ weaponIndex: 1, targetId: "hbk" }]); // AC/10 (1-based)

    // Rolls: hbk to-hit 3+3=6 >= TN 4, location 3+4=7 -> CT (kills enf);
    // then enf to-hit 3+3=6 >= TN 4, location 3+4=7 -> hbk CT.
    resolveAllAttacks(state, scriptedRng(3, 3, 3, 4, 3, 3, 3, 4));

    expect(enf.destroyed).toBe("centerTorsoDestroyed");
    expect(enf.removed).toBe("destroyed");
    // Enforcer's declared AC/10 still resolved despite hbk killing it first.
    expect(
      state.events.some(
        (e) => e.kind === "attackResolved" && e.unitId === "enf" && e.targetId === "hbk",
      ),
    ).toBe(true);
    expect(hbkCt()).toBe(31 - 10);
  });

  it("jams Ultra AC/5 double taps on a natural 2 and tracks the jam", () => {
    const units: UnitInit[] = [
      {
        id: "her",
        model: "HER-5SA",
        team: 0,
        gunnery: 4,
        position: { col: 2, row: 4 },
        facing: "ne",
      },
      {
        id: "cda",
        model: "CDA-3MA",
        team: 1,
        gunnery: 4,
        position: { col: 3, row: 4 },
        facing: "nw",
      },
    ];
    const setup = createTestBattle([], units, true);
    const state = startAttackTurn(setup);
    declareAttacks(state, "her", [{ weaponIndex: 3, targetId: "cda", rapidFire: true }]);
    expect(ammoWeaponTotals(getMechDef("HER-5SA")!, getUnit(state, "her").ammoBins)["3"]).toBe(18); // 2 shots spent up front
    resolveAllAttacks(state, scriptedRng(1, 1)); // natural 2 -> jam
    const her = getUnit(state, "her");
    expect(her.jammedWeapons).toEqual([3]);
    expect(getUnit(state, "cda").damage.armor.centerTorso).toBe(
      getMechDef("CDA-3MA")!.armor.centerTorso,
    );
  });

  it("fires a single shot by default and a double-tap only when rapidFire is set on an Ultra AC/5", () => {
    const units: UnitInit[] = [
      {
        id: "her",
        model: "HER-5SA",
        team: 0,
        gunnery: 4,
        position: { col: 2, row: 4 },
        facing: "ne",
      },
      {
        id: "cda",
        model: "CDA-3MA",
        team: 1,
        gunnery: 4,
        position: { col: 5, row: 4 },
        // Faces the attacker so the attack direction is front (location 7 -> CT).
        facing: "sw",
      },
    ];
    const setup = () => createTestBattle([], units, true);

    // Omitted rapidFire -> single shot (1 UAC/5 hit = 5 dmg, 1 ammo spent).
    const single = startAttackTurn(setup());
    declareAttacks(single, "her", [{ weaponIndex: 3, targetId: "cda" }]);
    expect(ammoWeaponTotals(getMechDef("HER-5SA")!, getUnit(single, "her").ammoBins)["3"]).toBe(19); // 1 shot spent up front
    const singleBefore = getUnit(single, "cda").damage.armor.centerTorso;
    // to-hit 4 (2,2), single location rolls 7 -> CT (no cluster roll for 1 shot).
    resolveAllAttacks(single, scriptedRng(2, 2, 3, 4));
    expect(singleBefore - getUnit(single, "cda").damage.armor.centerTorso).toBe(5);

    // rapidFire: true -> double-tap (2 x UAC/5 = 10 dmg, 2 ammo spent).
    const state = startAttackTurn(setup());
    declareAttacks(state, "her", [{ weaponIndex: 3, targetId: "cda", rapidFire: true }]);
    expect(ammoWeaponTotals(getMechDef("HER-5SA")!, getUnit(state, "her").ammoBins)["3"]).toBe(18); // 2 shots spent up front
    const before = getUnit(state, "cda").damage.armor.centerTorso;
    // to-hit 4 (2,2), cluster 8 (4,4) -> both shots hit; both hit CT (roll 7).
    resolveAllAttacks(state, scriptedRng(2, 2, 4, 4, 3, 4, 3, 4));
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

describe("streak missiles", () => {
  const streakUnits: UnitInit[] = [
    {
      id: "mc",
      model: "MC-MKII-2",
      team: 0,
      gunnery: 4,
      position: { col: 2, row: 4 },
      facing: "ne",
    },
    {
      id: "enf",
      model: "ENF-4R",
      team: 1,
      gunnery: 4,
      position: { col: 3, row: 4 },
      facing: "nw",
    },
  ];
  const streakSetup = () => startAttackTurn(createTestBattle([], streakUnits, true));

  it("defers ammo to resolution and lands full tubes with no cluster roll", () => {
    const state = streakSetup();
    expect(ammoWeaponTotals(getMechDef("MC-MKII-2")!, getUnit(state, "mc").ammoBins)["3"]).toBe(50);
    declareAttacks(state, "mc", [{ weaponIndex: 3, targetId: "enf" }]);
    // Declare spends nothing; launcher fires only on successful to-hit roll.
    expect(ammoWeaponTotals(getMechDef("MC-MKII-2")!, getUnit(state, "mc").ammoBins)["3"]).toBe(50);
    // to-hit 6 >= TN 4; four CT locations (7); one exposed tie-break die.
    resolveAllAttacks(state, scriptedRng(3, 3, 3, 4, 3, 4, 3, 4, 3, 4, 2));
    const mc = getUnit(state, "mc");
    expect(ammoWeaponTotals(getMechDef("MC-MKII-2")!, mc.ammoBins)["3"]).toBe(49);
    expect(mc.heat).toBe(3);
    const event = state.events.find((e) => e.kind === "attackResolved")!;
    expect(event.kind === "attackResolved" && event.resolution.clusterRoll).toBeNull();
    expect(event.kind === "attackResolved" && event.resolution.groups).toHaveLength(4);
  });

  it("auto-misses the second launcher when one shared shot remains", () => {
    const state = streakSetup();
    const mc = getUnit(state, "mc");
    // Shared pool drained to a single shot in one bin.
    mc.ammoBins["leftTorso:7"]!.shots = 0;
    mc.ammoBins["rightTorso:7"]!.shots = 1;
    expect(pooledShotsLeft(getMechDef("MC-MKII-2")!, mc.ammoBins, "CL Streak SRM 4")).toBe(1);
    // Mount 4 links zero bins (shared pool lives on mount 3): declare runs
    // unchecked for it, mirroring the live over-commit hole.
    declareAttacks(state, "mc", [
      { weaponIndex: 3, targetId: "enf" },
      { weaponIndex: 4, targetId: "enf" },
    ]);
    // First launcher: to-hit 6 >= TN 4, four CT locations (7). Single live
    // bin means no tie-break die; second launcher must draw zero dice.
    const rng = scriptedRng(3, 3, 3, 4, 3, 4, 3, 4, 3, 4);
    resolveAllAttacks(state, rng);
    expect(rng.remaining()).toBe(0);
    const events = state.events.filter((e) => e.kind === "attackResolved");
    expect(events).toHaveLength(2);
    const first = events[0]!;
    const second = events[1]!;
    if (first.kind !== "attackResolved" || second.kind !== "attackResolved")
      throw new Error("bad events");
    expect(first.resolution.hit).toBe(true);
    expect(first.resolution.groups).toHaveLength(4);
    expect(first.resolution.ammoExhausted).toBe(false);
    expect(second.resolution.hit).toBe(false);
    expect(second.resolution.ammoExhausted).toBe(true);
    expect(second.resolution.toHitRoll).toBeNull();
    expect(second.resolution.groups).toHaveLength(0);
    expect(second.resolution.application).toBeNull();
    expect(
      pooledShotsLeft(getMechDef("MC-MKII-2")!, getUnit(state, "mc").ammoBins, "CL Streak SRM 4"),
    ).toBe(0);
    // One volley fired: single launcher heat only.
    expect(getUnit(state, "mc").heat).toBe(3);
    const lines = resolutionLines("en", second.resolution);
    expect(lines.some((l) => l.includes("out of ammo"))).toBe(true);
  });

  it("spends no ammo and builds no heat on a streak miss", () => {
    const state = streakSetup();
    declareAttacks(state, "mc", [{ weaponIndex: 3, targetId: "enf" }]);
    const armorBefore = getUnit(state, "enf").damage.armor.centerTorso;
    resolveAllAttacks(state, scriptedRng(1, 2)); // to-hit 3 < TN 4
    const mc = getUnit(state, "mc");
    expect(ammoWeaponTotals(getMechDef("MC-MKII-2")!, mc.ammoBins)["3"]).toBe(50);
    expect(mc.heat).toBe(0);
    expect(getUnit(state, "enf").damage.armor.centerTorso).toBe(armorBefore);
    const event = state.events.find((e) => e.kind === "attackResolved")!;
    expect(event.kind === "attackResolved" && event.resolution.hit).toBe(false);
  });
});

describe("passedAttacks", () => {
  it("nextActor skips units that have passed this phase", () => {
    const state = startAttackTurn(hbkVsEnf());
    expect(nextActor(state)).toBe("hbk");
    getUnit(state, "hbk").passedAttacks = true;
    expect(nextActor(state)).toBe("enf");
  });

  it("passedAttacks resets at the end of the turn", () => {
    const state = startAttackTurn(hbkVsEnf());
    getUnit(state, "enf").passedAttacks = true;
    advancePhase(state); // weaponAttack -> end
    advancePhase(state); // end -> initiative, turn 2
    expect(getUnit(state, "enf").passedAttacks).toBe(false);
  });
});

describe("current-actor guard", () => {
  it("executeMove rejects a unit that is not head of the pending queue", () => {
    const state = startMovementTurn(hbkVsEnf());
    // hbk is head; advance through it so the queue head becomes enf.
    executeMove(state, "hbk", "standStill", []);
    expect(nextActor(state)).toBe("enf");
    expect(() => executeMove(state, "hbk", "walk", [])).toThrow(/not the current actor/);
  });

  it("executeMove rejects a unit that has already acted this phase", () => {
    const state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "walk", []);
    expect(state.actedThisPhase).toContain("hbk");
    expect(() => executeMove(state, "hbk", "walk", [])).toThrow(/not the current actor/);
  });

  it("executeMove rejects acting before initiative is rolled", () => {
    const state = hbkVsEnf(); // still in initiative phase
    expect(() => executeMove(state, "hbk", "walk", [])).toThrow(/current actor|initiative/);
  });

  it("executeMove rejects an unconscious unit (filtered from pending queue)", () => {
    const state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "walk", []); // hbk acts first
    getUnit(state, "enf").unconscious = true;
    // hbk is no longer eligible (already acted) and enf is filtered out.
    expect(nextActor(state)).toBeNull();
    expect(() => executeMove(state, "enf", "walk", [])).toThrow(/not the current actor/);
  });

  it("declareAttacks rejects a unit that is not head of the pending queue", () => {
    const state = startAttackTurn(hbkVsEnf());
    expect(() => declareAttacks(state, "enf", [{ weaponIndex: 1, targetId: "hbk" }])).toThrow(
      /not the current actor/,
    );
  });

  it("declareAttacks rejects a unit that passedAttacks this phase", () => {
    const state = startAttackTurn(hbkVsEnf());
    getUnit(state, "hbk").passedAttacks = true;
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }])).toThrow(
      /not the current actor/,
    );
  });

  it("declareAttacks rejects a shut-down unit in the weapon phase", () => {
    const state = startAttackTurn(hbkVsEnf());
    getUnit(state, "hbk").shutdown = "heat";
    // hbk is filtered out of the weapon phase queue (shutdown units skip),
    // leaving enf as the head.
    expect(nextActor(state)).toBe("enf");
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }])).toThrow(
      /not the current actor/,
    );
  });

  it("executeMove with skipActorCheck bypasses the head-of-queue guard", () => {
    const state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "standStill", []); // hbk consumes its turn
    // Without the bypass option this would throw; with it the call completes.
    // Walk toward the empty south-west hex (hbk at (2,4) facing "se" -> backing
    // west is invalid; turn first, then step along the row).
    expect(() =>
      executeMove(state, "hbk", "walk", [{ kind: "turn", facings: 1 }], {
        skipActorCheck: true,
      }),
    ).not.toThrow();
  });
});
