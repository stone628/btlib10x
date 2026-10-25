import { describe, expect, it } from "vitest";
import type { TerrainHexDef } from "../src/core/types";
import { FACINGS, type Facing, type Rng } from "../src/core/types";
import { mechDef, mechDefFor } from "../src/data/index";
import { weaponDefFor } from "../src/data/weapon.schema";
import { ammoWeaponTotals, binsForWeaponName, pooledShotsLeft } from "../src/rules/ammo";
import type { AmsPolicy } from "../src/rules/ams";
import { classifyFiringArc, effectiveFacingForTwist, type Twist } from "../src/rules/arcs";
import { crittedWeapons, isSlotDestroyed, isWeaponCritted } from "../src/rules/critical";
import { DEFAULT_UNIT_POLICY } from "../src/rules/game/constants";
import { buildUnitInit } from "../src/rules/game/create";
import { declareAttacks, passAttack } from "../src/rules/game/declare";
import { advancePhase } from "../src/rules/game/loop";
import { executeMove } from "../src/rules/game/move";
import { requireUnit } from "../src/rules/game/queries";
import { resolveAllAttacks } from "../src/rules/game/resolveAttacks";
import { actorQueue, nextActor, rollInitiativePhase } from "../src/rules/game/turnOrder";
import type { BattleState, GameEvent, UnitInit } from "../src/rules/game/types";
import { critLines, resolutionLines } from "../web/terminal/session";
import { checkVictory, createTestBattle, overrideAmmoBin } from "./helpers/battle";
import { scriptedRng } from "./helpers/rng";

function hbkVsEnf(terrain: readonly TerrainHexDef[] = []): BattleState {
  const units: UnitInit[] = [
    buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
    buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 5 }, "nw"),
  ];
  return createTestBattle(terrain, units, true);
}

/** Initiative rolls the first-inserted unit's team low (1+1) so it loses
 *  and acts first. Tests asserting a specific initiative winner pass an
 *  explicit `rng`. */
function startMovementTurn(state: BattleState, rng = scriptedRng(1, 1, 4, 4)): BattleState {
  rollInitiativePhase(state, rng, []);
  return state;
}

/** Movement phase resolved with nobody moving -> ready for weapon attacks. */
function startAttackTurn(
  state: BattleState,
  rng: ReturnType<typeof scriptedRng> = scriptedRng(1, 1, 4, 4),
): BattleState {
  advancePhase(startMovementTurn(state, rng), [], scriptedRng());
  return state;
}

describe("createBattle", () => {
  it("rejects duplicate ids and unknown models", () => {
    const base: UnitInit = buildUnitInit("a", "HBK-4G", 1, { col: 2, row: 2 }, "n" as const);
    expect(() => createTestBattle([], [base, base], false)).toThrow(/Duplicate unit id/);
    expect(() =>
      createTestBattle([], [base, { ...base, id: "b", model: "ZZZ-9Z" }], false),
    ).toThrow(/Unknown 'Mech model/);
  });

  it("rejects unit starts off the board, at fractional hexes, or stacked (API-06)", () => {
    const a = buildUnitInit("a", "HBK-4G", 1, { col: 2, row: 2 }, "n");
    const b = buildUnitInit("b", "ENF-4R", 2, { col: 3, row: 3 }, "s");
    const at = (col: number, row: number): UnitInit => ({ ...b, position: { col, row } });
    const battle = (u: UnitInit) => createTestBattle([], [a, u], false, 4, 4);

    expect(() => battle(b)).not.toThrow();
    expect(() => battle(at(1, 1))).not.toThrow();
    expect(() => battle(at(4, 4))).not.toThrow();

    expect(() => battle(at(0, 3))).toThrow("Unit b starts off the 4x4 board at 0,3");
    expect(() => battle(at(3, 0))).toThrow(/Unit b starts off the 4x4 board/);
    expect(() => battle(at(5, 3))).toThrow(/Unit b starts off the 4x4 board/);
    expect(() => battle(at(3, 5))).toThrow(/Unit b starts off the 4x4 board/);
    expect(() => battle(at(-1, -1))).toThrow(/Unit b starts off the 4x4 board/);

    expect(() => battle(at(1.5, 3))).toThrow("Unit b starts at a non-integer hex 1.5,3");
    expect(() => battle(at(3, Number.NaN))).toThrow(/Unit b starts at a non-integer hex/);
    expect(() => battle(at(Number.POSITIVE_INFINITY, 3))).toThrow(/non-integer hex/);

    expect(() => battle(at(2, 2))).toThrow("Units a and b start in the same hex 2,2");
  });

  it("rejects duplicate terrain hex definitions", () => {
    const base: UnitInit = /* temporary */ /* temporary */ buildUnitInit(
      "temp",
      "HBK-4G",
      1,
      { col: 2, row: 4 },
      "se" as const,
    );
    const units: UnitInit[] = [
      { ...base, id: "a", team: 1 },
      { ...base, id: "b", team: 2, position: { col: 1, row: 4 } },
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
    const hbk = requireUnit(state, "hbk");
    expect(hbk.damage.armor).toEqual(mechDef("HBK-4G")!.armor);
    expect(ammoWeaponTotals(mechDef("HBK-4G")!, hbk)["4"]).toBe(10);
    expect(state.phase).toBe("initiative");
    expect(state.turn).toBe(1);
  });
});

describe("movement phase", () => {
  it("enforces phase ordering", () => {
    expect(() => executeMove(hbkVsEnf(), "hbk", "walk", [], [], { rng: scriptedRng() })).toThrow(
      /phase/,
    );
  });

  it("charges MP for terrain and facing changes within budget", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 11, row: 11 }, "nw"),
    ];
    const setup = createTestBattle([{ col: 3, row: 5, type: "lightWoods" }], units, true);
    const state = startMovementTurn(setup);
    executeMove(
      state,
      "hbk",
      "walk",
      [
        { kind: "enter", to: { col: 3, row: 5 } },
        { kind: "turn", facings: 1 },
      ],
      [],
      { rng: scriptedRng() },
    );
    const hbk = requireUnit(state, "hbk");
    expect(hbk.mpSpent).toBe(3); // 1 turn + 2 light woods
    expect(hbk.position).toEqual({ col: 3, row: 5 });
  });

  it("rejects running backward", () => {
    const state = startMovementTurn(hbkVsEnf());
    expect(() =>
      executeMove(state, "hbk", "run", [{ kind: "enter", to: { col: 1, row: 4 } }], [], {
        rng: scriptedRng(),
      }),
    ).toThrow(/backward/);
  });

  it("rejects ground steps that are neither straight ahead nor straight back", () => {
    const state = startMovementTurn(hbkVsEnf());
    // Facing "se" from (2,4): south (2,5) is adjacent but not the forward or
    // backward hexside -> illegal without turning first.
    expect(() =>
      executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 2, row: 5 } }], [], {
        rng: scriptedRng(),
      }),
    ).toThrow(/straight ahead or straight back/);
  });

  it("allows walking straight backward", () => {
    const state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 1, row: 4 } }], [], {
      rng: scriptedRng(),
    });
    const hbk = requireUnit(state, "hbk");
    expect(hbk.position).toEqual({ col: 1, row: 4 });
    expect(hbk.mpSpent).toBe(1);
  });

  it("rejects a backward step that changes level", () => {
    const state = startMovementTurn(hbkVsEnf([{ col: 1, row: 4, type: "clear", level: 1 }]));
    expect(() =>
      executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 1, row: 4 } }], [], {
        rng: scriptedRng(),
      }),
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
    executeMove(
      state,
      "hbk",
      "walk",
      [
        { kind: "turn", facings: 1 },
        { kind: "enter", to: { col: 2, row: 5 } },
      ],
      [],
      { rng: scriptedRng() },
    );
    expect(requireUnit(state, "hbk").mpSpent).toBe(3);

    // A 2-level climb forward is legal: turn s (1 MP), enter (2,5) at level 2
    // (1 MP + 2 climb) = 4 total.
    const state2 = startMovementTurn(
      hbkVsEnf([
        { col: 2, row: 4, type: "clear", level: 0 },
        { col: 2, row: 5, type: "clear", level: 2 },
      ]),
    );
    executeMove(
      state2,
      "hbk",
      "walk",
      [
        { kind: "turn", facings: 1 },
        { kind: "enter", to: { col: 2, row: 5 } },
      ],
      [],
      { rng: scriptedRng() },
    );
    expect(requireUnit(state2, "hbk").mpSpent).toBe(4);
  });

  it("counts turning MP against the mode budget", () => {
    let state = startMovementTurn(hbkVsEnf());
    expect(() =>
      executeMove(state, "hbk", "walk", [{ kind: "turn", facings: 5 }], [], { rng: scriptedRng() }),
    ).toThrow(/budget/);

    state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "walk", [{ kind: "turn", facings: 2 }], [], { rng: scriptedRng() });
    const hbk = requireUnit(state, "hbk");
    expect(hbk.mpSpent).toBe(2); // 2 hexsides x 1 MP
    expect(hbk.facing).toBe("sw"); // se rotated two hexsides clockwise
    expect(hbk.position).toEqual({ col: 2, row: 4 });
  });

  it("charges counterclockwise turns one MP per hexside", () => {
    let state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "walk", [{ kind: "turn", facings: -1 }], [], { rng: scriptedRng() });
    const hbk = requireUnit(state, "hbk");
    expect(hbk.facing).toBe("ne"); // se rotated one hexside counterclockwise
    expect(hbk.mpSpent).toBe(1);

    // Pricing is by absolute hexside count: -5 blows the walking budget too.
    state = startMovementTurn(hbkVsEnf());
    expect(() =>
      executeMove(state, "hbk", "walk", [{ kind: "turn", facings: -5 }], [], {
        rng: scriptedRng(),
      }),
    ).toThrow(/budget/);
  });

  it("re-evaluates forward/backward relative to facing after each turn", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 11, row: 11 }, "nw"),
    ];
    const setup = createTestBattle([], units, true);
    const state = startMovementTurn(setup);
    executeMove(
      state,
      "hbk",
      "walk",
      [
        { kind: "enter", to: { col: 3, row: 5 } }, // forward (se)
        { kind: "turn", facings: 2 }, // now facing sw
        { kind: "enter", to: { col: 2, row: 5 } }, // new forward (sw)
      ],
      [],
      { rng: scriptedRng() },
    );
    const hbk = requireUnit(state, "hbk");
    expect(hbk.position).toEqual({ col: 2, row: 5 });
    expect(hbk.facing).toBe("sw");
    expect(hbk.mpSpent).toBe(4); // 2 enters + 2-hexside turn
  });

  it("rejects ending in a friendly-occupied hex (an enemy hex is a charge)", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
      buildUnitInit("enf", "ENF-4R", 1, { col: 3, row: 5 }, "nw"),
      buildUnitInit("far", "HBK-4G", 2, { col: 8, row: 8 }, "n"),
    ];
    const setup = createTestBattle([], units, true);
    const state = startMovementTurn(setup);
    expect(() =>
      executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 3, row: 5 } }], [], {
        rng: scriptedRng(),
      }),
    ).toThrow(/end movement in 3,5: occupied by enf/);
  });

  it("rejects moves exceeding the mode budget", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 11, row: 11 }, "nw"),
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
    expect(() => executeMove(state, "hbk", "walk", steps, [], { rng: scriptedRng() })).toThrow(
      /budget/,
    );
  });

  it("stand-still forbids steps and turns", () => {
    const state = startMovementTurn(hbkVsEnf());
    expect(() =>
      executeMove(state, "hbk", "standStill", [{ kind: "enter", to: { col: 1, row: 4 } }], [], {
        rng: scriptedRng(),
      }),
    ).toThrow(/Standing still forbids entering/);
    expect(() =>
      executeMove(state, "hbk", "standStill", [{ kind: "turn", facings: 1 }], [], {
        rng: scriptedRng(),
      }),
    ).toThrow(/forbids facing changes/);
  });

  it("alternates activation via nextActor", () => {
    const state = startMovementTurn(hbkVsEnf()); // first-iterated team loses
    expect(nextActor(state)).toBe("hbk");
    executeMove(state, "hbk", "walk", [], [], { rng: scriptedRng() });
    expect(nextActor(state)).toBe("enf");
  });

  it("jumping pays 1 MP per hex entered and may pass over enemies", () => {
    const units: UnitInit[] = [
      buildUnitInit("grf", "GRF-1N", 1, { col: 2, row: 4 }, "se"),
      buildUnitInit("wvr", "WVR-6R", 2, { col: 3, row: 4 }, "nw"),
    ];
    const setup = createTestBattle([], units, false);
    const state = startMovementTurn(setup);
    // Hop through the enemy-occupied hex (allowed while jumping) and land beyond it.
    executeMove(
      state,
      "grf",
      "jump",
      [
        { kind: "enter", to: { col: 3, row: 4 } },
        { kind: "enter", to: { col: 4, row: 4 } },
      ],
      [],
      { rng: scriptedRng() },
    );
    const grf = requireUnit(state, "grf");
    expect(grf.position).toEqual({ col: 4, row: 4 });
    expect(grf.mpSpent).toBe(2);
    expect(grf.jumpedThisTurn).toBe(true);
  });
});

describe("nextActor with unequal forces", () => {
  function fourVsTwo(teamOfFour: 1 | 2): BattleState {
    const units: UnitInit[] = [];
    for (let i = 0; i < 4; i++) {
      units.push(buildUnitInit(`a${i}`, "HBK-4G", teamOfFour, { col: i + 1, row: 1 }, "ne"));
    }
    for (let i = 0; i < 2; i++) {
      units.push(
        buildUnitInit(`b${i}`, "ENF-4R", (3 - teamOfFour) as 1 | 2, { col: 6 + i, row: 1 }, "sw"),
      );
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
      executeMove(state, id, "standStill", [], [], { rng: scriptedRng() });
    }
    return order;
  }

  it("spec example: team of 4 loses initiative, winner (team of 2) moves last", () => {
    // team1=4-Mech, team2=2-Mech. Roll initiative so team 2 wins.
    const state = startMovementTurn(fourVsTwo(1), scriptedRng(1, 1, 3, 3));
    expect(state.initiativeWinnerTeam).toBe(2);
    // Per §3: loser moves ⌊4/2⌋=2 units, winner moves 1, alternating starting with loser.
    expect(activationOrder(state)).toEqual(["a0", "a1", "b0", "a2", "a3", "b1"]);
  });

  it("team of 2 loses initiative: winner (team of 4) still moves last; loser (team of 2) goes first", () => {
    // team1=4-Mech, team2=2-Mech. team 1 wins via higher roll.
    const state = startMovementTurn(fourVsTwo(1), scriptedRng(3, 3, 1, 1));
    expect(state.initiativeWinnerTeam).toBe(1);
    const order = activationOrder(state);
    expect(order[0]).toMatch(/^b/); // loser (team 2) moves first
    expect(order.at(-1)).toMatch(/^a/); // winner (team 1) moves last
    expect(order.filter((id) => id.startsWith("b"))).toEqual(["b0", "b1"]);
    expect(order.filter((id) => id.startsWith("a"))).toEqual(["a0", "a1", "a2", "a3"]);
  });

  it("winner of initiative always moves last regardless of which side is larger", () => {
    // 4-Mech on team 2 (iterates first, so team 2 rolls first). Larger side wins.
    const largerWins = startMovementTurn(fourVsTwo(2), scriptedRng(3, 3, 1, 1));
    expect(largerWins.initiativeWinnerTeam).toBe(2);
    expect(activationOrder(largerWins).at(-1)).toBe("a3");

    // 4-Mech on team 1 (iterates first, so team 1 rolls first). Larger side wins.
    const largerWinsAlso = startMovementTurn(fourVsTwo(1), scriptedRng(3, 3, 1, 1));
    expect(largerWinsAlso.initiativeWinnerTeam).toBe(1);
    expect(activationOrder(largerWinsAlso).at(-1)).toBe("a3");
  });

  it("with equal force sizes, ordering falls back to simple loser-first alternation", () => {
    const state = startMovementTurn(hbkVsEnf());
    expect(state.initiativeWinnerTeam).toBe(2);
    expect(activationOrder(state)).toEqual(["hbk", "enf"]);
  });
});

describe("actorQueue", () => {
  /** 4-vs-2 state with team 2 winning initiative (see fourVsTwo above). */
  function fourVsTwoState(): BattleState {
    const units: UnitInit[] = [];
    for (let i = 0; i < 4; i++) {
      units.push(buildUnitInit(`a${i}`, "HBK-4G", 1, { col: i + 1, row: 1 }, "ne"));
    }
    for (let i = 0; i < 2; i++) {
      units.push(buildUnitInit(`b${i}`, "ENF-4R", 2, { col: 6 + i, row: 1 }, "sw"));
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
    executeMove(state, "hbk", "walk", [], [], { rng: scriptedRng() });
    const q = actorQueue(state);
    expect(q.acted.map((av) => av.id)).toEqual(["hbk"]);
    expect(q.pending.map((av) => av.id)).toEqual(["enf"]);
    expect(nextActor(state)).toBe("enf");
  });

  it("weaponAttack queue excludes shutdown and passed units", () => {
    const state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "walk", [], [], { rng: scriptedRng() });
    advancePhase(state, [], scriptedRng()); // movement -> weaponAttack
    requireUnit(state, "hbk").shutdown = "heat";
    requireUnit(state, "enf").passedAttacks = true;
    const q = actorQueue(state);
    expect(q.acted).toEqual([]);
    expect(q.pending).toEqual([]);
  });

  it("rebuilds per phase with a fresh acted pool", () => {
    const state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "walk", [], [], { rng: scriptedRng() });
    executeMove(state, "enf", "walk", [], [], { rng: scriptedRng() });
    expect(actorQueue(state).acted.map((av) => av.id)).toEqual(["hbk", "enf"]);
    advancePhase(state, [], scriptedRng()); // movement -> weaponAttack
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
    const state = startMovementTurn(hbkVsEnf(), scriptedRng(2, 2, 6, 6)); // team 2 wins
    requireUnit(state, "hbk").shutdown = "heat";
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
      // firing arc on the attacker side; only the right-arm ML fires. The
      // attack direction is front: the n candidate is a front-diagonal
      // hexside under 'Mech 3-1-1-1 (TW p.119), and front wins the boundary.
      {
        facing: "nw",
        targetPos: { col: 3, row: 3 },
        expected: "rightSide",
        expectedDir: "front",
        weaponIndex: 2,
      },
      // Target due south -> left side firing arc; only the left-arm ML
      // fires. The attack direction is front (bearing n from the nw-facing
      // target is a front-diagonal hexside under 'Mech 3-1-1-1).
      {
        facing: "nw",
        targetPos: { col: 2, row: 5 },
        expected: "leftSide",
        expectedDir: "front",
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
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, c.facing as UnitInit["facing"]),
        buildUnitInit("enf", "ENF-4R", 2, c.targetPos, "nw"),
      ];
      const state = startAttackTurn(createTestBattle([], units, true));
      if (c.weaponIndex === 0) {
        // Rear arc: no front/side weapon may be declared into it.
        for (const wi of [1, 2, 3, 4]) {
          expect(() =>
            declareAttacks(
              state,
              "hbk",
              [{ weaponIndex: wi, targetId: "enf" }],
              [],
              [],
              scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
            ),
          ).toThrow(/cannot fire into the rear arc/);
        }
        continue;
      }
      declareAttacks(
        state,
        "hbk",
        [{ weaponIndex: c.weaponIndex, targetId: "enf" }],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      );
      expect(state.units.hbk!.declaredWeaponAttacks).toEqual([
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
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "nw"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 5 }, "nw"),
    ];
    const state = startAttackTurn(createTestBattle([], units, true));
    for (const wi of [2, 3, 4]) {
      expect(() =>
        declareAttacks(
          state,
          "hbk",
          [{ weaponIndex: wi, targetId: "enf" }],
          [],
          [],
          scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
        ),
      ).toThrow(/cannot fire into the leftSide arc/);
    }
    declareAttacks(
      state,
      "hbk",
      [{ weaponIndex: 1, targetId: "enf" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    expect(state.units.hbk!.declaredWeaponAttacks[0]).toEqual(
      expect.objectContaining({ weaponIndex: 1, arc: "leftSide" }),
    );
  });

  it("resolves attack direction against the TARGET's facing (rear armor)", () => {
    // Attacker faces the target squarely (front firing arc) but stands in
    // the target's rear arc: hits roll on the front/rear column and drain
    // the rear torso armor pool.
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
      /* facing away from the attacker */ buildUnitInit(
        "enf",
        "ENF-4R",
        2,
        { col: 3, row: 5 },
        "se",
      ),
    ];
    const state = startAttackTurn(createTestBattle([], units, true));
    declareAttacks(
      state,
      "hbk",
      [{ weaponIndex: 2, targetId: "enf" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    const decl = state.units.hbk!.declaredWeaponAttacks[0]!;
    expect(decl.arc).toBe("front");
    expect(decl.attackDirection).toBe("rear");
    const rearBefore = requireUnit(state, "enf").damage.armorRear.centerTorso!;
    const frontBefore = requireUnit(state, "enf").damage.armor.centerTorso;
    const isBefore = requireUnit(state, "enf").damage.internalStructure.centerTorso;
    // to-hit 12 (6,6) hits; location 7 (3,4) -> center torso; 5 ML damage
    // strips the 4-point rear pool then 1 internal structure.
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(6, 6, 3, 4), events);
    const enf = requireUnit(state, "enf");
    expect(rearBefore).toBe(4);
    expect(enf.damage.armorRear.centerTorso!).toBe(0);
    expect(enf.damage.internalStructure.centerTorso).toBe(isBefore - 1);
    expect(enf.damage.armor.centerTorso).toBe(frontBefore);
    const event = events.find((e) => e.kind === "attackResolved")!;
    expect(event.kind === "attackResolved" && event.resolution.arc).toBe("rear");
  });

  it("rolls side-arc attacks on the side hit-location table", () => {
    // Attacker in the target's LEFT side: location roll 4 -> left arm on the
    // left-side column (front column would give right arm).
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
      /* attacker lies in its left side arc */ buildUnitInit(
        "enf",
        "ENF-4R",
        2,
        { col: 3, row: 5 },
        "ne",
      ),
    ];
    const state = startAttackTurn(createTestBattle([], units, true));
    declareAttacks(
      state,
      "hbk",
      [{ weaponIndex: 1, targetId: "enf" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    const decl = state.units.hbk!.declaredWeaponAttacks[0]!;
    expect(decl.arc).toBe("front");
    expect(decl.attackDirection).toBe("leftSide");
    // to-hit 12 (6,6) hits; location 4 (2,2) -> leftArm on the left-side table.
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(6, 6, 2, 2), events);
    const event = events.find((e) => e.kind === "attackResolved")!;
    if (event.kind !== "attackResolved") throw new Error("bad event");
    expect(event.resolution.groups).toEqual([
      { location: "leftArm", damage: 5, throughArmor: false },
    ]);
    expect(event.resolution.arc).toBe("leftSide");
  });

  it("lets rear-facing torso weapons fire into the rear arc only (AS7-D)", () => {
    const units: UnitInit[] = [
      /* target sits in the rear arc */ buildUnitInit("as7", "AS7-D", 1, { col: 2, row: 4 }, "nw"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 5 }, "nw"),
    ];
    const state = startAttackTurn(createTestBattle([], units, true));
    // Front-firing weapons reject the rear-arc target.
    expect(() =>
      declareAttacks(
        state,
        "as7",
        [{ weaponIndex: 3, targetId: "enf" }],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      ),
    ).toThrow(/cannot fire into the rear arc/);
    // The two rear-facing CT Medium Lasers (indices 1-2) bear.
    declareAttacks(
      state,
      "as7",
      [
        { weaponIndex: 1, targetId: "enf" },
        { weaponIndex: 2, targetId: "enf" },
      ],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    expect(state.units.as7!.declaredWeaponAttacks).toHaveLength(2);
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
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 5, row: 4 }, "nw"),
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
    expect(() =>
      declareAttacks(
        state,
        "hbk",
        [{ weaponIndex: 1, targetId: "enf" }],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      ),
    ).toThrow(/blocked/);

    // Out of range.
    const ac20 = weaponDefFor({ weapon: "AC/20" });
    units = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
      buildUnitInit("enf", "ENF-4R", 2, { col: ac20.long + 3, row: 2 }, "nw"),
    ];
    state = createTestBattle([], units, true);
    state = startAttackTurn(state);
    expect(() =>
      declareAttacks(
        state,
        "hbk",
        [{ weaponIndex: 1, targetId: "enf" }],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      ),
    ).toThrow(/long range/);

    // Modified TN > 12 must be aborted at declaration.
    units = [
      buildUnitInit("enf", "ENF-4R", 1, { col: 2, row: 4 }, "se", 7),
      buildUnitInit("hbk", "HBK-4G", 2, { col: 11, row: 4 }, "nw"),
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
    expect(() =>
      declareAttacks(
        state,
        "enf",
        [{ weaponIndex: 2, targetId: "hbk" }],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      ),
    ).toThrow(/auto-miss|abort/);
  });

  it("deducts ammo at declaration and allows one target per turn", () => {
    const state = startAttackTurn(hbkVsEnf());
    declareAttacks(
      state,
      "hbk",
      [
        { weaponIndex: 4, targetId: "enf" },
        { weaponIndex: 2, targetId: "enf" },
      ],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    expect(ammoWeaponTotals(mechDef("HBK-4G")!, requireUnit(state, "hbk"))["4"]).toBe(9);
    expect(() =>
      declareAttacks(
        state,
        "hbk",
        [{ weaponIndex: 2, targetId: "enf" }],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      ),
    ).toThrow(/current actor/);
  });

  it("rejects declaring the same weapon more than once per turn", () => {
    const state = startAttackTurn(hbkVsEnf());
    expect(() =>
      declareAttacks(
        state,
        "hbk",
        [
          { weaponIndex: 4, targetId: "enf" },
          { weaponIndex: 4, targetId: "enf" },
        ],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      ),
    ).toThrow(/may only be declared once/);
  });

  it("resolves scripted attacks immediately and commits kills only at end of phase", () => {
    const state = startAttackTurn(hbkVsEnf());
    declareAttacks(
      state,
      "hbk",
      [{ weaponIndex: 4, targetId: "enf" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    // Turn 1: AC/20 (20 dmg) hits CT (roll 5) -> CT 23 - 20 = 3 left.
    // 20+ damage PSR (needs 6: 3+3 succeeds, no fall).
    resolveAllAttacks(state, scriptedRng(2, 3, 3, 4, 3, 3), []);
    expect(requireUnit(state, "enf").damage.armor.centerTorso).toBe(3);
    expect(requireUnit(state, "enf").destroyed).toBe("not");

    advancePhase(state, [], scriptedRng()); // weaponAttack -> end
    expect(requireUnit(state, "enf").destroyed).toBe("not"); // survived with 3 CT

    advancePhase(state, [], scriptedRng()); // end -> initiative, turn 2
    expect(state.turn).toBe(2);
    expect(requireUnit(state, "hbk").moveMode).toBeNull();
    expect(requireUnit(state, "hbk").declaredWeaponAttacks).toHaveLength(0);

    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
    advancePhase(state, [], scriptedRng());
    declareAttacks(
      state,
      "hbk",
      [{ weaponIndex: 4, targetId: "enf" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    const events: GameEvent[] = [];
    // Hit CT again; the destroyed Enforcer then takes the salvage fall
    // (TW p.128): direction 3, one group at 3+3, then the pilot's
    // consciousness roll for the fall's hit (3+3, SALV-09).
    resolveAllAttacks(state, scriptedRng(6, 6, 3, 4, 3, 3, 3, 3, 3, 3), events);
    expect(requireUnit(state, "enf").damage.armor.centerTorso).toBe(0);
    // 3 armor absorbs 3, remaining 17 hits CT IS 16 -> destroyed (killed immediately).
    expect(requireUnit(state, "enf").destroyed).toBe("centerTorsoDestroyed");
    expect(requireUnit(state, "enf").removed).toBe("destroyed");
    expect(events.some((e) => e.kind === "unitRemoved")).toBe(true);

    advancePhase(state, [], scriptedRng()); // weaponAttack -> end (kill already committed)
    const enf = requireUnit(state, "enf");
    expect(enf.destroyed).toBe("centerTorsoDestroyed");
    expect(enf.removed).toBe("destroyed");
    expect(checkVictory(state)).toEqual({ winnerTeam: 1, draw: false });
  });

  it("resolves attacks simultaneously: a unit killed by an earlier attacker still fires", () => {
    const state = hbkVsEnf();
    // Enforcer center torso is one AC/20 hit from death (armor 0, IS 5).
    const enf = requireUnit(state, "enf");
    enf.damage.armor.centerTorso = 0;
    enf.damage.internalStructure.centerTorso = 5;
    const hbkCt = () => requireUnit(state, "hbk").damage.armor.centerTorso;

    startAttackTurn(state);
    // Both declare before resolution; roster order puts hbk first.
    declareAttacks(
      state,
      "hbk",
      [{ weaponIndex: 4, targetId: "enf" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    ); // AC/20 (1-based)
    declareAttacks(
      state,
      "enf",
      [{ weaponIndex: 1, targetId: "hbk" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    ); // AC/10 (1-based)

    // Rolls: hbk to-hit 3+3=6 >= TN 4, location 3+4=7 -> CT (kills enf);
    // then enf to-hit 3+3=6 >= TN 4, location 3+4=7 -> hbk CT; then the
    // destroyed Enforcer's salvage fall (TW p.128): direction 1, 3+3, and
    // its pilot's consciousness roll (3+3, SALV-09).
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(3, 3, 3, 4, 3, 3, 3, 4, 1, 3, 3, 3, 3), events);

    expect(enf.destroyed).toBe("centerTorsoDestroyed");
    expect(enf.removed).toBe("destroyed");
    // Enforcer's declared AC/10 still resolved despite hbk killing it first.
    expect(
      events.some((e) => e.kind === "attackResolved" && e.unitId === "enf" && e.targetId === "hbk"),
    ).toBe(true);
    expect(hbkCt()).toBe(26 - 10);
  });

  it("jams Ultra AC/5 double taps on a natural 2 and tracks the jam", () => {
    const units: UnitInit[] = [
      buildUnitInit("her", "HER-5SA", 1, { col: 2, row: 4 }, "ne"),
      buildUnitInit("cda", "CDA-3MA", 2, { col: 3, row: 4 }, "nw"),
    ];
    const setup = createTestBattle([], units, true);
    const state = startAttackTurn(setup);
    declareAttacks(
      state,
      "her",
      [{ weaponIndex: 3, targetId: "cda", rapidFire: true }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    expect(ammoWeaponTotals(mechDef("HER-5SA")!, requireUnit(state, "her"))["3"]).toBe(18); // 2 shots spent up front
    resolveAllAttacks(state, scriptedRng(1, 1), []); // natural 2 -> jam
    const her = requireUnit(state, "her");
    expect(her.jammedWeapons).toEqual([3]);
    expect(requireUnit(state, "cda").damage.armor.centerTorso).toBe(
      mechDef("CDA-3MA")!.armor.centerTorso,
    );
  });

  it("fires a single shot by default and a double-tap only when rapidFire is set on an Ultra AC/5", () => {
    const units: UnitInit[] = [
      buildUnitInit("her", "HER-5SA", 1, { col: 2, row: 4 }, "ne"),
      /* Faces the attacker so the attack direction is front (location 7 -> CT). */ buildUnitInit(
        "cda",
        "CDA-3MA",
        2,
        { col: 5, row: 4 },
        "sw",
      ),
    ];
    const setup = () => createTestBattle([], units, true);

    // Omitted rapidFire -> single shot (1 UAC/5 hit = 5 dmg, 1 ammo spent).
    const single = startAttackTurn(setup());
    declareAttacks(
      single,
      "her",
      [{ weaponIndex: 3, targetId: "cda" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    expect(ammoWeaponTotals(mechDef("HER-5SA")!, requireUnit(single, "her"))["3"]).toBe(19); // 1 shot spent up front
    const singleBefore = requireUnit(single, "cda").damage.armor.centerTorso;
    // to-hit 4 (2,2), single location rolls 7 -> CT (no cluster roll for 1 shot).
    resolveAllAttacks(single, scriptedRng(2, 2, 3, 4), []);
    expect(singleBefore - requireUnit(single, "cda").damage.armor.centerTorso).toBe(5);

    // rapidFire: true -> double-tap (2 x UAC/5 = 10 dmg, 2 ammo spent).
    const state = startAttackTurn(setup());
    declareAttacks(
      state,
      "her",
      [{ weaponIndex: 3, targetId: "cda", rapidFire: true }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    expect(ammoWeaponTotals(mechDef("HER-5SA")!, requireUnit(state, "her"))["3"]).toBe(18); // 2 shots spent up front
    const before = requireUnit(state, "cda").damage.armor.centerTorso;
    // to-hit 4 (2,2), cluster 8 (4,4) -> both shots hit; both hit CT (roll 7).
    resolveAllAttacks(state, scriptedRng(2, 2, 4, 4, 3, 4, 3, 4), []);
    expect(before - requireUnit(state, "cda").damage.armor.centerTorso).toBe(10);
  });

  it("rejects rapidFire on a weapon that is not rapid-fire", () => {
    const state = startAttackTurn(hbkVsEnf());
    // HBK weapon 4 is a Small Laser (no rapidFireShots).
    expect(() =>
      declareAttacks(
        state,
        "hbk",
        [{ weaponIndex: 4, targetId: "enf", rapidFire: true }],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      ),
    ).toThrow(/is not rapid-fire/);
  });
});

describe("streak missiles", () => {
  const streakUnits: UnitInit[] = [
    buildUnitInit("mc", "MC-MKII-2", 1, { col: 2, row: 4 }, "ne"),
    buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 4 }, "nw"),
  ];
  const streakSetup = () => startAttackTurn(createTestBattle([], streakUnits, true));

  it("defers ammo to resolution and lands full tubes with no cluster roll", () => {
    const state = streakSetup();
    expect(ammoWeaponTotals(mechDef("MC-MKII-2")!, requireUnit(state, "mc"))["3"]).toBe(50);
    declareAttacks(
      state,
      "mc",
      [{ weaponIndex: 3, targetId: "enf" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    // Declare spends nothing; launcher fires only on successful to-hit roll.
    expect(ammoWeaponTotals(mechDef("MC-MKII-2")!, requireUnit(state, "mc"))["3"]).toBe(50);
    // to-hit 6 >= TN 4; four CT locations (7); one exposed tie-break die.
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(3, 3, 3, 4, 3, 4, 3, 4, 3, 4, 2), events);
    const mc = requireUnit(state, "mc");
    expect(ammoWeaponTotals(mechDef("MC-MKII-2")!, mc)["3"]).toBe(49);
    expect(mc.heat).toBe(0);
    expect(mc.heatPending).toBe(3);
    const event = events.find((e) => e.kind === "attackResolved")!;
    expect(event.kind === "attackResolved" && event.resolution.clusterRoll).toBeNull();
    expect(event.kind === "attackResolved" && event.resolution.groups).toHaveLength(4);
  });

  it("auto-misses the second launcher when one shared shot remains", () => {
    const state = streakSetup();
    const mc = requireUnit(state, "mc");
    // Shared pool drained to a single shot in one bin.
    mc.ammoBins["leftTorso:7"]! = 0;
    mc.ammoBins["rightTorso:7"]! = 1;
    expect(pooledShotsLeft(mechDef("MC-MKII-2")!, mc, "CL Streak SRM 4")).toBe(1);
    // Both mounts share one pool (mount 4 links zero bins directly):
    // streaks declare against the pooled shot and the resolver auto-misses
    // whichever launcher finds the pool dry.
    declareAttacks(
      state,
      "mc",
      [
        { weaponIndex: 3, targetId: "enf" },
        { weaponIndex: 4, targetId: "enf" },
      ],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    // First launcher: to-hit 6 >= TN 4, four CT locations (7). Single live
    // bin means no tie-break die; second launcher must draw zero dice.
    const rng = scriptedRng(3, 3, 3, 4, 3, 4, 3, 4, 3, 4);
    const allEvents: GameEvent[] = [];
    resolveAllAttacks(state, rng, allEvents);
    const events = allEvents.filter((e) => e.kind === "attackResolved");
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
    expect(second.resolution.applications).toEqual([]);
    expect(
      pooledShotsLeft(mechDef("MC-MKII-2")!, requireUnit(state, "mc"), "CL Streak SRM 4"),
    ).toBe(0);
    // One volley fired: single launcher heat only (deferred).
    expect(requireUnit(state, "mc").heat).toBe(0);
    expect(requireUnit(state, "mc").heatPending).toBe(3);
    const lines = resolutionLines(second.resolution);
    expect(lines.some((l) => l.includes("out of ammo"))).toBe(true);
  });

  it("spends no ammo and builds no heat on a streak miss", () => {
    const state = streakSetup();
    declareAttacks(
      state,
      "mc",
      [{ weaponIndex: 3, targetId: "enf" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    const armorBefore = requireUnit(state, "enf").damage.armor.centerTorso;
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(1, 2), events); // to-hit 3 < TN 4
    const mc = requireUnit(state, "mc");
    expect(ammoWeaponTotals(mechDef("MC-MKII-2")!, mc)["3"]).toBe(50);
    expect(mc.heat).toBe(0);
    expect(requireUnit(state, "enf").damage.armor.centerTorso).toBe(armorBefore);
    const event = events.find((e) => e.kind === "attackResolved")!;
    expect(event.kind === "attackResolved" && event.resolution.hit).toBe(false);
  });

  it("accumulates damage from multiple weapons against the same target in one volley", () => {
    // Use original hbkVsEnf positions: HBK at (2,4) facing SE, ENF at (3,5) facing NW
    // Attack direction is front. Front arc CT is roll 2 (through armor) or 7.
    const state = startAttackTurn(hbkVsEnf());
    declareAttacks(
      state,
      "hbk",
      [
        { weaponIndex: 2, targetId: "enf" }, // rightArm ML
        { weaponIndex: 1, targetId: "enf" }, // leftArm ML
      ],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    // RNG: to-hit rolls (need >= 4 for ML at range 1), then hit location rolls
    // Front arc CT is roll 7 (no through-armor). Use (3,4)=7 for both.
    // ML#1: to-hit 6 (3,3), hit loc CT (3,4)=7
    // ML#2: to-hit 6 (3,3), hit loc CT (3,4)=7
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(3, 3, 3, 4, 3, 3, 3, 4), events);
    const enf = requireUnit(state, "enf");
    // ENF-4R CT armor is 23. Two MLs (5 dmg each) hitting CT = 10 damage -> 13
    expect(enf.damage.armor.centerTorso).toBe(13);
    // Two attackResolved events
    const attacks = events.filter((e) => e.kind === "attackResolved");
    expect(attacks).toHaveLength(2);
  });

  it("logs the ammo-blast chain and chains the next shot's snapshot past the blast", () => {
    // Attacker HBK-4G fires AC/20 then a Medium Laser at a second HBK-4G.
    // The AC/20 pens the left torso and detonates its slot-1 bin (trimmed
    // to a single shot: 20 blast damage straight to IS, TW p.125); the
    // follow-up laser must see the post-blast CT, not the phase-start CT.
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
      buildUnitInit("tgt", "HBK-4G", 2, { col: 3, row: 5 }, "nw"),
    ];
    const state = startAttackTurn(createTestBattle([], units, false));
    const target = requireUnit(state, "tgt");
    // HBK-4G: LT armor 20 / IS 12, CT armor 26 / IS 16. Pre-crack LT armor
    // so the AC/20 (20 dmg) reaches IS without destroying the location
    // itself, and trim the hit bin to one shot (blast 20, no CT kill).
    target.damage.armor.leftTorso = 15;
    overrideAmmoBin(target.ammoBins, "leftTorso", 1, 1);
    declareAttacks(
      state,
      "hbk",
      [
        { weaponIndex: 4, targetId: "tgt" }, // AC/20
        { weaponIndex: 2, targetId: "tgt" }, // rightArm ML
      ],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    // AC/20: to-hit 6, loc 8 -> LT, determining 8 -> 1 crit, slot (1,1) ->
    // LT slot 1 (ammo); blast cascades roll 2 (no crit) twice. ML: to-hit
    // 6, loc 7 -> CT. Filler 3s cover pilot/consciousness/PSR dice.
    const rng = scriptedRng(3, 3, 4, 4, 4, 4, 1, 1, 1, 1, 1, 1, 3, 3, 3, 4, ...Array(60).fill(3));
    const events: GameEvent[] = [];
    resolveAllAttacks(state, rng, events);
    const attacks = events.filter((e) => e.kind === "attackResolved");
    expect(attacks).toHaveLength(2);
    const first = attacks[0]!;
    const second = attacks[1]!;
    if (first.kind !== "attackResolved" || second.kind !== "attackResolved")
      throw new Error("bad events");

    // The blast row carries its own IS-direct location chain.
    const blasts = first.resolution.crits
      .flatMap((c) => c.rows)
      .filter((r) => r.kind === "ammoExplosion");
    expect(blasts).toHaveLength(1);
    const blast = blasts[0]!;
    if (blast.kind !== "ammoExplosion") throw new Error("bad row");
    expect(blast.damage).toBe(20);
    expect(blast.application.steps.map((s) => s.location)).toEqual(["leftTorso", "centerTorso"]);
    expect(blast.application.steps.every((s) => s.pool === "structure")).toBe(true);
    const critText = first.resolution.crits.flatMap((c) => critLines(c)).join("\n");
    expect(critText).toMatch(/LTI/);
    expect(critText).toMatch(/CTI/);

    // AC/20: 15 armor + 5 IS (LT IS 12 -> 7); blast 20: LT IS 7 -> 0,
    // overflow 13 -> CT IS 16 -> 3, armor untouched. The laser's `before`
    // must reflect that, and its 5 damage then lands on CT armor 26 -> 21.
    const before = second.resolution.applications[0]?.before;
    expect(before?.internalStructure.leftTorso).toBe(0);
    expect(before?.internalStructure.centerTorso).toBe(3);
    expect(before?.armor.centerTorso).toBe(26);
    expect(requireUnit(state, "tgt").damage.armor.centerTorso).toBe(21);
  });
});

describe("passedAttacks", () => {
  it("nextActor skips units that have passed this phase", () => {
    const state = startAttackTurn(hbkVsEnf());
    expect(nextActor(state)).toBe("hbk");
    requireUnit(state, "hbk").passedAttacks = true;
    expect(nextActor(state)).toBe("enf");
  });

  it("passedAttacks resets at the end of the turn", () => {
    const state = startAttackTurn(hbkVsEnf());
    requireUnit(state, "enf").passedAttacks = true;
    advancePhase(state, [], scriptedRng()); // weaponAttack -> end
    advancePhase(state, [], scriptedRng()); // end -> initiative, turn 2
    expect(requireUnit(state, "enf").passedAttacks).toBe(false);
  });
});

describe("passAttack", () => {
  it("marks the current actor as passed and acted without changing anything else", () => {
    const state = startAttackTurn(hbkVsEnf());
    passAttack(state, "hbk");
    expect(requireUnit(state, "hbk").passedAttacks).toBe(true);
    expect(state.actedThisPhase).toContain("hbk");
    expect(nextActor(state)).toBe("enf");
  });

  it("requires the attack phase", () => {
    const state = startMovementTurn(hbkVsEnf());
    expect(() => passAttack(state, "hbk")).toThrow(/attack/);
  });

  it("rejects a unit that is not head of the pending queue", () => {
    const state = startAttackTurn(hbkVsEnf());
    expect(() => passAttack(state, "enf")).toThrow(/not the current actor/);
  });

  it("rejects a second pass once the unit has acted", () => {
    const state = startAttackTurn(hbkVsEnf());
    passAttack(state, "hbk");
    expect(() => passAttack(state, "hbk")).toThrow(/not the current actor/);
  });

  it("rejects a pass after the unit declared attacks", () => {
    const state = startAttackTurn(hbkVsEnf());
    declareAttacks(
      state,
      "hbk",
      [{ weaponIndex: 1, targetId: "enf" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    expect(() => passAttack(state, "hbk")).toThrow(/not the current actor/);
  });

  it("rejects a shut-down unit (filtered out of the weapon-phase queue)", () => {
    const state = startAttackTurn(hbkVsEnf());
    requireUnit(state, "hbk").shutdown = "heat";
    expect(nextActor(state)).toBe("enf");
    expect(() => passAttack(state, "hbk")).toThrow(/not the current actor/);
  });
});

describe("current-actor guard", () => {
  it("executeMove rejects a unit that is not head of the pending queue", () => {
    const state = startMovementTurn(hbkVsEnf());
    // hbk is head; advance through it so the queue head becomes enf.
    executeMove(state, "hbk", "standStill", [], [], { rng: scriptedRng() });
    expect(nextActor(state)).toBe("enf");
    expect(() => executeMove(state, "hbk", "walk", [], [], { rng: scriptedRng() })).toThrow(
      /not the current actor/,
    );
  });

  it("executeMove rejects a unit that has already acted this phase", () => {
    const state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "walk", [], [], { rng: scriptedRng() });
    expect(state.actedThisPhase).toContain("hbk");
    expect(() => executeMove(state, "hbk", "walk", [], [], { rng: scriptedRng() })).toThrow(
      /not the current actor/,
    );
  });

  it("executeMove rejects acting before initiative is rolled", () => {
    const state = hbkVsEnf(); // still in initiative phase
    expect(() => executeMove(state, "hbk", "walk", [], [], { rng: scriptedRng() })).toThrow(
      /current actor|initiative/,
    );
  });

  it("executeMove rejects an unconscious unit (filtered from pending queue)", () => {
    const state = startMovementTurn(hbkVsEnf());
    executeMove(state, "hbk", "walk", [], [], { rng: scriptedRng() }); // hbk acts first
    requireUnit(state, "enf").unconsciousSinceTurn = state.turn;
    // hbk is no longer eligible (already acted) and enf is filtered out.
    expect(nextActor(state)).toBeNull();
    expect(() => executeMove(state, "enf", "walk", [], [], { rng: scriptedRng() })).toThrow(
      /not the current actor/,
    );
  });

  it("declareAttacks rejects a unit that is not head of the pending queue", () => {
    const state = startAttackTurn(hbkVsEnf());
    expect(() =>
      declareAttacks(
        state,
        "enf",
        [{ weaponIndex: 1, targetId: "hbk" }],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      ),
    ).toThrow(/not the current actor/);
  });

  it("declareAttacks rejects a unit that passedAttacks this phase", () => {
    const state = startAttackTurn(hbkVsEnf());
    passAttack(state, "hbk");
    expect(() =>
      declareAttacks(
        state,
        "hbk",
        [{ weaponIndex: 1, targetId: "enf" }],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      ),
    ).toThrow(/not the current actor/);
  });

  it("declareAttacks rejects a shut-down unit in the weapon phase", () => {
    const state = startAttackTurn(hbkVsEnf());
    requireUnit(state, "hbk").shutdown = "heat";
    // hbk is filtered out of the weapon phase queue (shutdown units skip),
    // leaving enf as the head.
    expect(nextActor(state)).toBe("enf");
    expect(() =>
      declareAttacks(
        state,
        "hbk",
        [{ weaponIndex: 1, targetId: "enf" }],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      ),
    ).toThrow(/not the current actor/);
  });
});

describe("weapon-volley crit accumulation (TW p. 38 simultaneity)", () => {
  // Regression for the bug where `commitFire` overwrote the running
  // crit-slot/destroyed-weapons/ammo-bins accumulator with the LAST crit's
  // output. Each `resolveWeaponAttack` call resolves its own crit chain
  // from a fresh pre-volley snapshot, so its returned table only carries
  // that weapon's own hits. Volley-wide merge (OR new flags in) is what
  // TW p. 38 (simultaneous damage) and p. 124–125 (transfer / re-roll
  // against already-destroyed slots) require.

  function hbkVsEnfCrits(): BattleState {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 5 }, "nw"),
    ];
    return createTestBattle([], units, false);
  }

  it("accumulates gyro/engine crits from one weapon when a later weapon only destroys a weapon slot", () => {
    const state = startAttackTurn(hbkVsEnfCrits());
    // Pre-strip CT armor and RA armor so the medium lasers (5 dmg each)
    // both reach internal structure and roll determining crits.
    const enf = requireUnit(state, "enf");
    enf.damage.armor.centerTorso = 0;
    enf.damage.armor.rightArm = 0;

    declareAttacks(
      state,
      "hbk",
      [
        { weaponIndex: 2, targetId: "enf" }, // rightArm ML -> CT (roll 2 front)
        { weaponIndex: 1, targetId: "enf" }, // leftArm ML  -> RA (roll 3 front)
      ],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    // Dice order: for each weapon in declared order
    //   to-hit (2d6) | location (2d6) | crit determining (2d6) | crit slot (2d6)
    //   ML#1 -> CT slot 4 (gyro on ENF centerTorso: layout[3])
    //   ML#2 -> RA slot 4 (AC/10 first slot on ENF rightArm: layout[3])
    // Then the first-gyro PSR at end of weapon attack: roll 2D6 vs TN 8
    // (piloting 5 + gyro +3); a roll >= 8 succeeds and skips the fall path.
    const rng = scriptedRng(
      // ML#1: hit, CT (roll 2 = through-armor + IS-stripped -> 2 crit calls)
      3,
      1,
      1,
      1,
      //   call 1 (structure): det 8 -> 1 crit, gyro slot 4
      4,
      4,
      1,
      4,
      //   call 2 (through-armor): det 7 -> no crit
      3,
      4,
      // ML#2: hit, RA (roll 3, not through-armor), 1 crit, AC/10 slot 4
      2,
      2,
      1,
      2,
      4,
      4,
      1,
      4,
      // gyro-hit PSR: 10 >= 8 succeeds
      5,
      5,
    );
    resolveAllAttacks(state, rng, []);

    const after = requireUnit(state, "enf");
    // CT gyro slot 4 (layout index 3) must be flagged — pre-fix this was
    // wiped by the second weapon's overwrite.
    expect(isSlotDestroyed(after.critSlotsDestroyed, "centerTorso", 3)).toBe(true);
    // RA AC/10 first slot must be flagged.
    expect(isSlotDestroyed(after.critSlotsDestroyed, "rightArm", 3)).toBe(true);
    // AC/10 (ENF weaponIndex 1) is destroyed.
    expect(isWeaponCritted(mechDefFor(after), after.critSlotsDestroyed, 1)).toBe(true);
  });

  it("accumulates destroyed weapons across multiple crits in the same volley", () => {
    const state = startAttackTurn(hbkVsEnfCrits());
    const enf = requireUnit(state, "enf");
    // Strip RA and LA armor so both MLs reach IS.
    enf.damage.armor.rightArm = 0;
    enf.damage.armor.leftArm = 0;

    declareAttacks(
      state,
      "hbk",
      [
        { weaponIndex: 2, targetId: "enf" }, // rightArm ML -> RA
        { weaponIndex: 1, targetId: "enf" }, // leftArm ML  -> LA
      ],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    // ML#1 -> RA roll 3, slot 4 = AC/10 weapon (ENF weaponIndex 1)
    // ML#2 -> LA roll 10, slot 4 = Large Laser first slot (ENF weaponIndex 2)
    const rng = scriptedRng(
      2,
      2,
      1,
      2,
      4,
      4,
      1,
      4, // ML#1: hit, RA, 1 crit, AC/10 slot 4
      5,
      5,
      4,
      6,
      4,
      4,
      1,
      4, // ML#2: hit, LA, 1 crit, LL slot 4
    );
    resolveAllAttacks(state, rng, []);

    const after = requireUnit(state, "enf");
    const critted = crittedWeapons(mechDefFor(after), after.critSlotsDestroyed);
    expect(critted).toContain(1); // AC/10 from first ML (ENF weaponIndex 1)
    // Shoulder crit on LA: destroys the Large Laser (ENF weaponIndex 2).
    expect(critted).toContain(2);
  });
});

describe("AMS in the weapon attack phase (TW p.129)", () => {
  /** Every die shows `face`: every 2D6 is 2 x face. */
  const constRng = (face: number): Rng => ({ d6: () => face, snapshot: () => "0", load: () => {} });
  const AMS = "Anti-Missile System";
  const excDef = () => mechDef("EXC-B2")!;
  /** Atlas 7 hexes south of an EXC-B2 (AMS in the center torso, front arc). */
  const setup = (
    excFacing: Facing = "s",
    amsPolicy: AmsPolicy = "expected",
    attacker: string = "AS7-D",
  ): BattleState => {
    const units: UnitInit[] = [
      buildUnitInit("atk", attacker, 1, { col: 3, row: 8 }, "n"),
      buildUnitInit("exc", "EXC-B2", 2, { col: 3, row: 1 }, excFacing, 4, 5, 6, {
        ...DEFAULT_UNIT_POLICY,
        amsPolicy,
      }),
    ];
    return startAttackTurn(createTestBattle([], units, true));
  };
  const fire = (state: BattleState, weaponIndices: number[], events: GameEvent[] = []) => {
    declareAttacks(
      state,
      "atk",
      weaponIndices.map((weaponIndex) => ({ weaponIndex, targetId: "exc" })),
      [],
      [],
      constRng(4),
    );
    resolveAllAttacks(state, constRng(4), events);
    return events;
  };
  const resolved = (events: GameEvent[]) =>
    events.flatMap((e) => (e.kind === "attackResolved" ? [e.resolution] : []));
  const engaged = (events: GameEvent[]) =>
    events.flatMap((e) => (e.kind === "amsEngaged" ? [e] : []));

  it("engages a hitting LRM 20: 12 -> 9 missiles, 1 ammo, 1 heat", () => {
    const state = setup();
    // Every 2D6 is 8: LRM 20 at 7 hexes hits TN 4; Cluster 8 -> 12, 4 -> 9.
    const events = fire(state, [4]);
    const [lrm] = resolved(events);
    expect(lrm!.missileDefense).toEqual({
      weaponIndex: 2,
      weapon: AMS,
      hitsWithout: 12,
      hitsWith: 9,
    });
    expect(lrm!.groups.reduce((sum, g) => sum + g.damage, 0)).toBe(9);
    const exc = requireUnit(state, "exc");
    expect(pooledShotsLeft(excDef(), exc, AMS)).toBe(11);
    expect(exc.heatPending).toBe(1);
    expect(engaged(events)).toEqual([
      expect.objectContaining({
        unitId: "exc",
        weaponIndex: 2,
        attackerId: "atk",
        attackWeapon: "LRM 20",
        heat: 1,
        totalGenerated: 1,
        shotsLeft: 11,
      }),
    ]);
    // The engagement prints right after the attack it cut down.
    const at = events.findIndex((e) => e.kind === "attackResolved");
    expect(events[at + 1]?.kind).toBe("amsEngaged");
    expect(resolutionLines(lrm!).some((l) => l.includes("12 → 9"))).toBe(true);
  });

  it("off lets the volley through and spends nothing", () => {
    const state = setup("s", "off");
    const events = fire(state, [4]);
    expect(resolved(events)[0]!.missileDefense).toBeUndefined();
    expect(engaged(events)).toEqual([]);
    expect(pooledShotsLeft(excDef(), requireUnit(state, "exc"), AMS)).toBe(12);
    expect(requireUnit(state, "exc").heatPending).toBe(0);
  });

  it("engages one attack per turn, picked by the policy", () => {
    // SRM 6 (long range, TN 8) resolves before the LRM 20 (TN 4); both hit.
    const pick = (policy: AmsPolicy) =>
      resolved(fire(setup("s", policy), [5, 4])).map((r) => r.missileDefense !== undefined);
    expect(pick("firstHit")).toEqual([true, false]);
    expect(pick("expected")).toEqual([false, true]);
    expect(pick("priority")).toEqual([false, true]);
  });

  it("covers only its own arc: a front-torso AMS ignores fire into the rear", () => {
    const state = setup("n");
    const events = fire(state, [4]);
    expect(resolved(events)[0]!.hit).toBe(true);
    expect(engaged(events)).toEqual([]);
  });

  it("needs ammo and power at phase start", () => {
    const dry = setup();
    for (const bin of binsForWeaponName(excDef(), AMS)) {
      requireUnit(dry, "exc").ammoBins[bin.id] = 0;
    }
    expect(engaged(fire(dry, [4]))).toEqual([]);

    const down = setup();
    requireUnit(down, "exc").shutdown = "manual";
    expect(engaged(fire(down, [4]))).toEqual([]);
  });

  it("cuts a Streak volley as a roll of 11 - 4", () => {
    const state = setup("s", "expected", "MC-MKII-2");
    // CL Streak SRM 4 at 7 hexes: medium range, TN 6 <= 8.
    const [streak] = resolved(fire(state, [3]));
    expect(streak!.clusterRoll).toBeNull();
    expect(streak!.missileDefense).toEqual(
      expect.objectContaining({ hitsWithout: 4, hitsWith: 3 }),
    );
    expect(streak!.groups).toHaveLength(3);
  });

  it("covers the arc its torso twisted into this phase", () => {
    // Find a facing that puts the attacker in a side arc and the twist that
    // brings it to the front (the AMS sits in the center torso).
    const exc = { col: 3, row: 1 };
    const atk = { col: 3, row: 8 };
    let found: { facing: Facing; twist: Twist } | null = null;
    for (const facing of FACINGS) {
      const side = classifyFiringArc(exc, atk, facing);
      if (side !== "leftSide" && side !== "rightSide") continue;
      for (const twist of ["leftSide", "rightSide"] as const) {
        if (classifyFiringArc(exc, atk, effectiveFacingForTwist(facing, twist)) === "front") {
          found = { facing, twist };
        }
      }
      if (found !== null) break;
    }
    if (found === null) throw new Error("no side facing found");
    const run = (twist: Twist | null) => {
      const state = setup(found.facing);
      const events: GameEvent[] = [];
      declareAttacks(state, "atk", [{ weaponIndex: 4, targetId: "exc" }], [], [], constRng(4));
      if (twist === null) passAttack(state, "exc");
      else {
        // EXC-B2 Gauss Rifle (right arm) answers at the twisted front.
        declareAttacks(state, "exc", [{ weaponIndex: 3, targetId: "atk" }], [], [], constRng(4), {
          twist,
        });
      }
      resolveAllAttacks(state, constRng(4), events);
      return engaged(events).length;
    };
    expect(run(null)).toBe(0);
    expect(run(found.twist)).toBe(1);
  });
});
