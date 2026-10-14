/**
 * Charge and Death From Above without displacement (TW pp.144, 148-150):
 * declared by movement into an enemy hex, the attacker stops in front of it
 * and the attack resolves in the physical sub-pass.
 */
import { describe, expect, it } from "vitest";
import type { Facing, HexCoord } from "../src/core/types";
import type { BattleState, GameEvent, TeamId, TerrainHexDef, UnitInit } from "../src/rules/game";
import {
  buildUnitInit,
  declareAttacks,
  executeMove,
  losEnds,
  meleeDeclarationProblem,
  requireUnit,
  resolveAllAttacks,
  resolvePhasePiloting,
} from "../src/rules/game";
import { reachableLandings } from "../src/rules/movement";
import { validatePhysicalAttack } from "../src/rules/physical";
import { loadBattleState, saveBattleState } from "../src/rules/snapshot";
import { createTestBattle, scriptedRng } from "./helpers";

const unit = (
  id: string,
  model: string,
  team: TeamId,
  position: HexCoord,
  facing: Facing,
): UnitInit => buildUnitInit(id, model, team, position, facing);

/** Movement phase with `units[0]` first to act. */
function movementState(units: UnitInit[], terrain: TerrainHexDef[] = []): BattleState {
  const state = createTestBattle(terrain, units, true, 10, 10);
  state.phase = "movement";
  state.initiativeWinnerTeam = 1;
  state.actorQueue = units.map((u) => u.id);
  state.actedThisPhase = [];
  return state;
}

function toAttack(state: BattleState): void {
  state.phase = "attack";
  state.actorQueue = null;
  state.actedThisPhase = [];
}

const pad = (...head: number[]) => scriptedRng(...head, ...Array<number>(80).fill(6));

/** hbk (5,2)/s walks into enf (5,5)/n: charge from (5,4) after 2 hexes. */
function chargeBattle(): BattleState {
  return movementState([
    unit("a", "HBK-4G", 1, { col: 5, row: 2 }, "s"),
    unit("t", "ENF-4R", 2, { col: 5, row: 5 }, "n"),
  ]);
}
const chargePath = [
  { kind: "enter" as const, to: { col: 5, row: 3 } },
  { kind: "enter" as const, to: { col: 5, row: 4 } },
  { kind: "enter" as const, to: { col: 5, row: 5 } },
];

/** enf (5,2)/s jumps onto hbk (5,4)/n: DFA from (5,3). */
function dfaBattle(terrain: TerrainHexDef[] = []): BattleState {
  return movementState(
    [
      unit("a", "ENF-4R", 1, { col: 5, row: 2 }, "s"),
      unit("t", "HBK-4G", 2, { col: 5, row: 4 }, "n"),
    ],
    terrain,
  );
}
const dfaPath = [
  { kind: "enter" as const, to: { col: 5, row: 3 } },
  { kind: "enter" as const, to: { col: 5, row: 4 } },
];

describe("charge declaration (TW p.148)", () => {
  it("stops in front of the target, pays for its hex, and skips attack input", () => {
    const state = chargeBattle();
    const events: GameEvent[] = [];
    executeMove(state, "a", "walk", chargePath, events);
    const a = requireUnit(state, "a");
    expect(a.position).toEqual({ col: 5, row: 4 });
    expect(a.facing).toBe("s");
    expect(a.mpSpent).toBe(3);
    expect(a.hexesMovedThisTurn).toBe(2); // the target hex is not counted
    expect(a.meleeCharge).toMatchObject({
      kind: "charge",
      targetId: "t",
      hex: { col: 5, row: 5 },
      from: { col: 5, row: 2 },
      missed: false,
    });
    expect(a.passedAttacks).toBe(true);
    expect(a.declaredPhysicalAttacks).toEqual([{ type: "charge", targetId: "t" }]);
    expect(requireUnit(state, "t").position).toEqual({ col: 5, row: 5 });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "moved",
        unitId: "a",
        pendingCharge: { attack: "charge", targetId: "t", targetHex: { col: 5, row: 5 } },
      }),
    );
  });

  it("running charges too, at the run heat", () => {
    const state = chargeBattle();
    executeMove(state, "a", "run", chargePath, []);
    expect(requireUnit(state, "a").meleeCharge?.kind).toBe("charge");
    expect(requireUnit(state, "a").moveMode).toBe("run");
  });

  it("must be made straight ahead and within the movement budget", () => {
    const back = movementState([
      unit("a", "HBK-4G", 1, { col: 5, row: 3 }, "n"),
      unit("t", "ENF-4R", 2, { col: 5, row: 4 }, "n"),
    ]);
    expect(() =>
      executeMove(back, "a", "walk", [{ kind: "enter", to: { col: 5, row: 4 } }], []),
    ).toThrow(/straight ahead/);
    const far = movementState([
      unit("a", "HBK-4G", 1, { col: 5, row: 1 }, "s"),
      unit("t", "ENF-4R", 2, { col: 5, row: 7 }, "n"),
    ]);
    expect(() =>
      executeMove(
        far,
        "a",
        "walk",
        [2, 3, 4, 5, 6, 7].map((row) => ({ kind: "enter" as const, to: { col: 5, row } })),
        [],
      ),
    ).toThrow(/budget/);
  });

  it("cannot target a prone 'Mech, a friend, or a unit already charged", () => {
    const prone = chargeBattle();
    requireUnit(prone, "t").prone = true;
    expect(() => executeMove(prone, "a", "walk", chargePath, [])).toThrow(/prone/);

    const friend = movementState([
      unit("a", "HBK-4G", 1, { col: 5, row: 2 }, "s"),
      unit("f", "ENF-4R", 1, { col: 5, row: 5 }, "n"),
      unit("t", "ENF-4R", 2, { col: 8, row: 8 }, "n"),
    ]);
    expect(() => executeMove(friend, "a", "walk", chargePath, [])).toThrow(/occupied by f/);

    const twice = movementState([
      unit("a", "HBK-4G", 1, { col: 5, row: 2 }, "s"),
      unit("b", "HBK-4G", 1, { col: 4, row: 4 }, "ne"),
      unit("t", "ENF-4R", 2, { col: 5, row: 5 }, "n"),
    ]);
    executeMove(twice, "a", "walk", chargePath, []);
    expect(() =>
      executeMove(twice, "b", "walk", [{ kind: "enter", to: { col: 5, row: 4 } }], []),
    ).toThrow();
  });

  it("a unit already charged cannot declare a charge of its own, nor be charged twice", () => {
    const state = movementState([
      unit("a", "HBK-4G", 1, { col: 5, row: 2 }, "s"),
      unit("t", "HBK-4G", 2, { col: 5, row: 5 }, "n"),
      unit("u", "HBK-4G", 2, { col: 5, row: 7 }, "n"),
    ]);
    executeMove(state, "a", "walk", chargePath, []);
    state.actorQueue = ["t", "u"];
    // t (the charged unit) tries to charge a (its own charger).
    expect(meleeDeclarationProblem(state, "t", { col: 5, row: 5 }, "a", "charge", 0)).toMatch(
      /target of a charge/,
    );
  });

  it("charge and DFA are not declarable in the attack phase", () => {
    const state = movementState([
      unit("a", "HBK-4G", 1, { col: 5, row: 4 }, "s"),
      unit("t", "ENF-4R", 2, { col: 5, row: 5 }, "n"),
    ]);
    toAttack(state);
    state.actorQueue = ["a", "t"];
    expect(() => declareAttacks(state, "a", [], [{ type: "charge", targetId: "t" }], [])).toThrow(
      /declared by movement/,
    );
  });

  it("reserves the target hex: nobody else may end movement there", () => {
    const state = movementState([
      unit("a", "HBK-4G", 1, { col: 5, row: 2 }, "s"),
      unit("b", "HBK-4G", 1, { col: 6, row: 5 }, "nw"),
      unit("t", "ENF-4R", 2, { col: 5, row: 5 }, "n"),
    ]);
    executeMove(state, "a", "walk", chargePath, []);
    // The target leaves; the hex stays reserved for the charger.
    requireUnit(state, "t").position = { col: 5, row: 6 };
    expect(() =>
      executeMove(state, "b", "walk", [{ kind: "enter", to: { col: 5, row: 5 } }], []),
    ).toThrow(/reserved for a/);
  });
});

describe("DFA declaration (TW p.149)", () => {
  it("stops in front of the target, facing it, with the full jump counted", () => {
    const state = dfaBattle();
    executeMove(state, "a", "jump", dfaPath, []);
    const a = requireUnit(state, "a");
    expect(a.position).toEqual({ col: 5, row: 3 });
    expect(a.facing).toBe("s");
    expect(a.jumpedThisTurn).toBe(true);
    expect(a.meleeCharge).toMatchObject({ kind: "dfa", targetId: "t", from: { col: 5, row: 2 } });
    expect(a.passedAttacks).toBe(true);
  });

  it("an adjacent target is attacked from the start hex", () => {
    const state = movementState([
      unit("a", "ENF-4R", 1, { col: 5, row: 2 }, "n"),
      unit("t", "HBK-4G", 2, { col: 5, row: 3 }, "n"),
    ]);
    executeMove(state, "a", "jump", [{ kind: "enter", to: { col: 5, row: 3 } }], []);
    const a = requireUnit(state, "a");
    expect(a.position).toEqual({ col: 5, row: 2 });
    expect(a.facing).toBe("s");
    expect(a.meleeCharge?.kind).toBe("dfa");
  });

  it("needs Jumping MP to clear the target hex (level + 2)", () => {
    const state = dfaBattle([{ col: 5, row: 4, type: "clear", level: 3 }]);
    expect(() => executeMove(state, "a", "jump", dfaPath, [])).toThrow(/needs 5 Jumping MP/);
  });

  it("is exempt from the one-level difference gate", () => {
    const state = dfaBattle([{ col: 5, row: 4, type: "clear", level: 2 }]);
    executeMove(state, "a", "jump", dfaPath, []);
    expect(requireUnit(state, "a").meleeCharge?.kind).toBe("dfa");
  });

  it("can target a prone 'Mech", () => {
    const state = dfaBattle();
    requireUnit(state, "t").prone = true;
    executeMove(state, "a", "jump", dfaPath, []);
    expect(requireUnit(state, "a").meleeCharge?.kind).toBe("dfa");
  });
});

describe("charge resolution (TW p.148)", () => {
  it("hits for tonnage / 10 per hex moved, recoils, and queues +2 PSRs; nobody moves", () => {
    const state = chargeBattle();
    executeMove(state, "a", "walk", chargePath, []);
    toAttack(state);
    const events: GameEvent[] = [];
    // to-hit 6,6; two target groups (2D6 each); one recoil group (2D6).
    resolveAllAttacks(state, pad(6, 6, 3, 4, 3, 4, 3, 4), events);
    const r = events.find((e) => e.kind === "physicalAttackResolved");
    if (r?.kind !== "physicalAttackResolved") throw new Error("no resolution");
    expect(r.resolution.type).toBe("charge");
    expect(r.resolution.toHit).toBe(6); // piloting 5 + walked +1, no terrain, equal skills
    expect(r.resolution.hit).toBe(true);
    expect(r.resolution.damageToTarget.map((g) => g.damage)).toEqual([5, 5]); // 50 t x 2 hexes, not counting the target's (TW p.148)
    expect(r.resolution.damageToAttacker.map((g) => g.damage)).toEqual([5]); // 50 t target
    expect(r.resolution.targetPsrMod).toBe(2);
    expect(r.resolution.attackerPsrMod).toBe(2);
    const psrs = events.filter((e) => e.kind === "pilotingCheck");
    expect(psrs.map((e) => (e.kind === "pilotingCheck" ? e.reason : ""))).toEqual(
      expect.arrayContaining(["chargeMade", "chargeTarget"]),
    );
    expect(requireUnit(state, "a").position).toEqual({ col: 5, row: 4 });
    expect(requireUnit(state, "t").position).toEqual({ col: 5, row: 5 });
    expect(requireUnit(state, "a").meleeCharge).toBeNull();
  });

  it("an adjacent charge deals no damage but still forces both +2 PSRs on a hit", () => {
    const state = movementState([
      unit("a", "HBK-4G", 1, { col: 5, row: 4 }, "s"),
      unit("t", "ENF-4R", 2, { col: 5, row: 5 }, "n"),
    ]);
    executeMove(state, "a", "walk", [{ kind: "enter", to: { col: 5, row: 5 } }], []);
    expect(requireUnit(state, "a").hexesMovedThisTurn).toBe(0);
    toAttack(state);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, pad(6, 6, 3, 4), events);
    const r = events.find((e) => e.kind === "physicalAttackResolved");
    if (r?.kind !== "physicalAttackResolved") throw new Error("no resolution");
    expect(r.resolution.hit).toBe(true);
    expect(r.resolution.damageToTarget).toEqual([]); // 50 t x 0 hexes (TW p.148)
    expect(r.resolution.damageToAttacker.map((g) => g.damage)).toEqual([5]); // 50 t target recoil
    expect(r.resolution.targetPsrMod).toBe(2);
    expect(r.resolution.attackerPsrMod).toBe(2);
  });

  it("a miss costs the charger nothing", () => {
    const state = chargeBattle();
    executeMove(state, "a", "walk", chargePath, []);
    toAttack(state);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, pad(1, 1), events);
    const r = events.find((e) => e.kind === "physicalAttackResolved");
    if (r?.kind !== "physicalAttackResolved") throw new Error("no resolution");
    expect(r.resolution.hit).toBe(false);
    expect(r.resolution.damageToAttacker).toEqual([]);
    expect(events.some((e) => e.kind === "pilotingCheck")).toBe(false);
    expect(requireUnit(state, "a").prone).toBe(false);
  });

  it("applies the Piloting-skill difference and ignores terrain", () => {
    const state = chargeBattle();
    requireUnit(state, "t").piloting = 3; // target better: +2
    executeMove(state, "a", "walk", chargePath, []);
    toAttack(state);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, pad(1, 1), events);
    const r = events.find((e) => e.kind === "physicalAttackResolved");
    if (r?.kind !== "physicalAttackResolved") throw new Error("no resolution");
    expect(r.resolution.toHit).toBe(8);
  });

  it("an advance into the vacated hex when the target left it", () => {
    const state = chargeBattle();
    executeMove(state, "a", "walk", chargePath, []);
    requireUnit(state, "t").position = { col: 5, row: 6 };
    toAttack(state);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, pad(), events);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "physicalAttackResolved",
        unitId: "a",
        resolution: expect.objectContaining({
          type: "charge",
          hit: false,
          missReason: "advanced",
          advancedTo: { col: 5, row: 5 },
        }),
      }),
    );
    expect(requireUnit(state, "a").position).toEqual({ col: 5, row: 5 });
  });

  it("is void when a wreck holds the target hex", () => {
    const state = chargeBattle();
    executeMove(state, "a", "walk", chargePath, []);
    requireUnit(state, "t").removed = "pilotKilled";
    state.wrecks["5,5"] = { unitId: "t", level: 2 };
    toAttack(state);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, pad(), events);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "physicalAttackResolved",
        unitId: "a",
        resolution: expect.objectContaining({ hit: false, missReason: "voided:wreck" }),
      }),
    );
    expect(requireUnit(state, "a").position).toEqual({ col: 5, row: 4 });
  });
});

describe("DFA resolution (TW p.150)", () => {
  it("a hit deals tonnage / 10 x 3, recoils on the legs, and queues +2 / +4 PSRs", () => {
    const state = dfaBattle();
    executeMove(state, "a", "jump", dfaPath, []);
    toAttack(state);
    const events: GameEvent[] = [];
    // to-hit 6,6; 3 target groups and 2 recoil groups roll 1D6 each.
    resolveAllAttacks(state, pad(6, 6, 3, 3, 3, 3, 3), events);
    const r = events.find((e) => e.kind === "physicalAttackResolved");
    if (r?.kind !== "physicalAttackResolved") throw new Error("no resolution");
    expect(r.resolution.type).toBe("dfa");
    expect(r.resolution.toHit).toBe(8); // piloting 5 + jumped +3
    expect(r.resolution.damageToTarget.map((g) => g.damage)).toEqual([5, 5, 5]); // 5 x 3
    expect(r.resolution.damageToAttacker.map((g) => g.damage)).toEqual([5, 5]); // 50 / 5
    expect(r.resolution.damageToAttacker.every((g) => g.location.endsWith("Leg"))).toBe(true);
    expect(r.resolution.targetPsrMod).toBe(2);
    expect(r.resolution.attackerPsrMod).toBe(4);
    expect(requireUnit(state, "a").position).toEqual({ col: 5, row: 3 });
    expect(requireUnit(state, "t").position).toEqual({ col: 5, row: 4 });
  });

  it("a miss drops the attacker as from a 2-level fall onto its rear", () => {
    const state = dfaBattle();
    executeMove(state, "a", "jump", dfaPath, []);
    toAttack(state);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, pad(1, 1), events);
    const fell = events.find((e) => e.kind === "unitFell" && e.unitId === "a");
    if (fell?.kind !== "unitFell") throw new Error("no fall");
    expect(fell.cause).toEqual({ kind: "dfaMiss" });
    expect(fell.levelsFallen).toBe(2);
    expect(fell.column).toBe("rear");
    expect(fell.totalDamage).toBe(15); // 5 x (2 + 1)
    expect(requireUnit(state, "a").prone).toBe(true);
  });

  it("the DFA'er cannot be the target of a physical attack", () => {
    const state = dfaBattle();
    state.units.u = requireUnit(dfaBattle(), "t");
    executeMove(state, "a", "jump", dfaPath, []);
    const view = createTestBattle(
      [],
      [
        unit("a", "ENF-4R", 1, { col: 5, row: 3 }, "s"),
        unit("t", "HBK-4G", 2, { col: 5, row: 4 }, "n"),
      ],
      true,
    );
    requireUnit(view, "a").meleeCharge = {
      kind: "dfa",
      targetId: "x",
      hex: { col: 9, row: 9 },
      from: { col: 5, row: 2 },
      missed: false,
    };
    const check = validatePhysicalAttack(view, "t", {
      type: "kick",
      targetId: "a",
      limb: "rightLeg",
    });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/DFA/);
  });

  it("a failed weapon-phase PSR does not drop the DFA'er: the DFA misses instead", () => {
    const state = dfaBattle();
    executeMove(state, "a", "jump", dfaPath, []);
    toAttack(state);
    const a = requireUnit(state, "a");
    const before = {
      damage: { [a.id]: structuredClone(a.damage) },
      crit: { [a.id]: structuredClone(a.critSlotsDestroyed) },
    };
    // Fresh hits from the enemy's weapons this phase: 25 armor points off.
    a.damage = {
      ...a.damage,
      armor: { ...a.damage.armor, leftTorso: 0, rightTorso: 0, centerTorso: 0 },
    };
    const events: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(1, 1), before, events, undefined, true);
    expect(a.prone).toBe(false);
    expect(a.meleeCharge?.missed).toBe(true);
    // In the physical phase the aborted DFA misses and drops it.
    const physical: GameEvent[] = [];
    resolveAllAttacks(state, pad(), physical);
    expect(physical).toContainEqual(
      expect.objectContaining({
        kind: "physicalAttackResolved",
        resolution: expect.objectContaining({ missReason: "dfaAborted" }),
      }),
    );
    expect(requireUnit(state, "a").prone).toBe(true);
  });
});

describe("DFA in the air for LOS (TW p.149)", () => {
  it("sits two levels above the higher of its hex and the target hex", () => {
    const state = dfaBattle([{ col: 5, row: 4, type: "clear", level: 2 }]);
    executeMove(state, "a", "jump", dfaPath, []);
    const a = requireUnit(state, "a");
    const t = requireUnit(state, "t");
    expect(losEnds(state, t, a).toLevel).toBe(4); // max(0, 2) + 2
    expect(losEnds(state, a, t).toLevel).toBeUndefined();
  });
});

describe("charge landings in reachability", () => {
  it("lists an enemy hex as a charge or DFA landing that stops short", () => {
    const state = chargeBattle();
    const a = requireUnit(state, "a");
    const landings = reachableLandings(a.position, a.facing, {
      mode: "walk",
      walking: 4,
      running: 6,
      jumping: 0,
      prone: false,
      grid: state,
      team: 1,
      occupantTeam: (hex) => (hex.col === 5 && hex.row === 5 ? 2 : undefined),
      meleeOk: (stop, targetHex, kind) =>
        meleeDeclarationProblem(state, "a", stop, "t", kind, 0) === null && targetHex.col === 5,
    });
    const melee = landings.filter((l) => l.melee !== undefined);
    expect(melee).toHaveLength(1);
    expect(melee[0]).toMatchObject({
      hex: { col: 5, row: 5 },
      facing: "s",
      melee: { kind: "charge", stopsAt: { col: 5, row: 4 } },
    });
    expect(melee[0]!.path).toHaveLength(3);
    // Plain listings exclude melee landings entirely.
    const plain = reachableLandings(a.position, a.facing, {
      mode: "walk",
      walking: 4,
      running: 6,
      jumping: 0,
      prone: false,
      grid: state,
      team: 1,
      occupantTeam: (hex) => (hex.col === 5 && hex.row === 5 ? 2 : undefined),
    });
    expect(plain.some((l) => l.melee !== undefined)).toBe(false);
  });

  it("lists a DFA landing for a jumper", () => {
    const state = dfaBattle();
    const a = requireUnit(state, "a");
    const landings = reachableLandings(a.position, a.facing, {
      mode: "jump",
      walking: 4,
      running: 6,
      jumping: 4,
      prone: false,
      grid: state,
      team: 1,
      occupantTeam: (hex) => (hex.col === 5 && hex.row === 4 ? 2 : undefined),
      meleeOk: (stop, _targetHex, kind) =>
        meleeDeclarationProblem(state, "a", stop, "t", kind, 4) === null,
    });
    const dfa = landings.filter((l) => l.melee?.kind === "dfa");
    expect(dfa).toHaveLength(1);
    expect(dfa[0]).toMatchObject({
      hex: { col: 5, row: 4 },
      melee: { stopsAt: { col: 5, row: 3 } },
    });
  });
});

describe("snapshots", () => {
  it("round-trip a declared charge", () => {
    const state = chargeBattle();
    executeMove(state, "a", "walk", chargePath, []);
    const saved = saveBattleState(state);
    requireUnit(state, "a").meleeCharge = null;
    loadBattleState(state, saved);
    expect(requireUnit(state, "a").meleeCharge).toMatchObject({ kind: "charge", targetId: "t" });
  });
});
