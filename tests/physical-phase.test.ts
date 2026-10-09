/**
 * Weapon-then-physical sub-pass ordering (TW pp.37-38,59-61,144,147).
 * Declarations stay merged for playability (one attack activation per unit
 * per turn); resolution splits into a weapon sub-pass, a weapon PSR sweep,
 * then the melee, then a physical sweep.
 */
import { describe, expect, it } from "vitest";
import type { HexCoord } from "../src/core/types";
import type { BattleState, UnitInit } from "../src/rules/game";
import {
  advancePhase,
  buildUnitInit,
  declareAttacks,
  type GameEvent,
  requireUnit,
  resolveAllAttacks,
  resolvePhasePiloting,
  rollInitiativePhase,
} from "../src/rules/game";
import { physicalResolutionLines } from "../web/session.attack";
import { createTestBattle, scriptedRng } from "./helpers";

const HIGH_RNG = {
  d6: () => 6,
  snapshot: () => "",
  load: () => {},
};

function unit(
  id: string,
  team: number,
  pos: HexCoord,
  facing: "n" | "ne" | "se" | "s" | "sw" | "nw",
): UnitInit {
  return buildUnitInit(id, "HBK-4G", team, pos, facing);
}

/** hbk (team 0) at (2,2)/s facing enf (team 1) at (2,3)/n, attack phase. */
function faceToFace(): BattleState {
  return createTestBattle(
    [],
    [unit("hbk", 0, { col: 2, row: 2 }, "s"), unit("enf", 1, { col: 2, row: 3 }, "n")],
    true,
  );
}

function toAttack(state: BattleState): void {
  // Duplicate of the piloting-test drive: initiative -> movement -> attack.
  // Default rng: team 0 (8) beats team 1 (4), so enf (loser) declares first.
  rollInitiativePhase(state, scriptedRng(4, 4, 2, 2), []);
  advancePhase(state, []);
}

describe("weapon sweep lands before the melee", () => {
  it("a weapon-phase fall leaves the attacker prone so its punch auto-misses", () => {
    const state = faceToFace();
    toAttack(state);
    // enf (loser) declares first, then hbk's AC/20 (weapon index 4).
    declareAttacks(state, "enf", [], [{ type: "punch", targetId: "hbk", limb: "rightArm" }], []);
    declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }], [], []);
    const events: GameEvent[] = [];
    // to-hit 3+3, CT 1+1 (20 dmg), damage20 PSR 1+2 (fail), fall dir 2,
    // fall loc 1+1, seatbelt 3+3 (pass). The punch never rolls.
    resolveAllAttacks(state, scriptedRng(3, 3, 1, 1, 1, 2, 2, 1, 1, 3, 3), events);
    expect(requireUnit(state, "enf").prone).toBe(true);

    const kinds = events.map((e) => e.kind);
    const sweepIdx = events.findIndex(
      (e) => e.kind === "pilotingCheck" && e.unitId === "enf" && e.reason === "damage20",
    );
    const meleeIdx = kinds.indexOf("physicalAttackResolved");
    expect(sweepIdx).toBeGreaterThanOrEqual(0);
    expect(meleeIdx).toBeGreaterThan(sweepIdx);

    const melee = events[meleeIdx];
    expect(melee?.kind).toBe("physicalAttackResolved");
    if (melee?.kind !== "physicalAttackResolved") throw new Error("unreachable");
    expect(melee.resolution.hit).toBe(false);
    expect(melee.resolution.damageToTarget).toEqual([]);
    expect(melee.resolution.missReason).toMatch(/^invalid:/);
    // hbk untouched by the cancelled punch.
    expect(requireUnit(state, "hbk").damage.armor.centerTorso).toBe(26);
  });

  it("a unit destroyed by weapons still fires but never swings its melee", () => {
    const state = faceToFace();
    toAttack(state);
    // Pre-damage enf's CT so the AC/20 (20 dmg to CT on 1+1) kills outright.
    const enf = requireUnit(state, "enf");
    enf.damage.armor.centerTorso = 0;
    enf.damage.armorRear.centerTorso = 0;
    enf.damage.internalStructure.centerTorso = 5;
    declareAttacks(state, "enf", [], [{ type: "punch", targetId: "hbk", limb: "rightArm" }], []);
    declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }], [], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(3, 3, 1, 1), events);

    // Destroyed units still fire (TW p.38 simultaneity).
    const shots = events.filter((e) => e.kind === "attackResolved");
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((e) => e.kind !== "attackResolved" || e.resolution.hit)).toBe(true);
    expect(requireUnit(state, "enf").removed).toBe("destroyed");

    const melee = events.find((e) => e.kind === "physicalAttackResolved");
    expect(melee?.kind).toBe("physicalAttackResolved");
    if (melee?.kind !== "physicalAttackResolved") throw new Error("unreachable");
    expect(melee.resolution.missReason).toBe("attackerDown");
    expect(melee.resolution.hit).toBe(false);
    expect(requireUnit(state, "hbk").damage.armor.centerTorso).toBe(26);
  });
});

describe("displaced targets (TW p.144)", () => {
  /** Pusher (5,5)/ne shoves T out of (6,4); A (6,5)/n punches T. */
  function pushSetup(pTeam: number, aTeam: number, tTeam: number): BattleState {
    const state = createTestBattle(
      [],
      [
        unit("p", pTeam, { col: 5, row: 5 }, "ne"),
        unit("a", aTeam, { col: 6, row: 5 }, "n"),
        unit("t", tTeam, { col: 6, row: 4 }, "s"),
      ],
      true,
    );
    state.phase = "attack";
    state.units.p!.declaredPhysicalAttacks.push({ type: "push", targetId: "t" });
    state.units.a!.declaredPhysicalAttacks.push({
      type: "punch",
      targetId: "t",
      limb: "rightArm",
    });
    return state;
  }

  it("auto-misses with no valid target when a friend holds the declared hex", () => {
    const state = pushSetup(0, 0, 1);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, HIGH_RNG, events);

    // Push landed and advanced into the declared hex.
    expect(requireUnit(state, "p").position).toEqual({ col: 6, row: 4 });
    expect(requireUnit(state, "t").position).not.toEqual({ col: 6, row: 4 });

    const punches = events.filter(
      (e): e is Extract<GameEvent, { kind: "physicalAttackResolved" }> =>
        e.kind === "physicalAttackResolved" && e.unitId === "a",
    );
    expect(punches).toHaveLength(1);
    const res = punches[0]!.resolution;
    expect(res.hit).toBe(false);
    expect(res.autoMiss).toBe(true);
    expect(res.missReason).toBe("displaced");
    expect(res.damageToTarget).toEqual([]);

    // The web CLI names the cause instead of a bare MISS.
    const lines = physicalResolutionLines(res);
    expect(lines.join("\n")).toContain("displaced");
    expect(lines.join("\n")).toContain("auto-miss");
  });

  it("redirects at +1 onto an enemy holding the declared hex", () => {
    const state = pushSetup(1, 0, 2);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, HIGH_RNG, events);

    const punches = events.filter(
      (e): e is Extract<GameEvent, { kind: "physicalAttackResolved" }> =>
        e.kind === "physicalAttackResolved" && e.unitId === "a",
    );
    expect(punches).toHaveLength(1);
    const evt = punches[0]!;
    expect(evt.targetId).toBe("p");
    expect(evt.resolution.redirectedFrom).toBe("t");
    expect(evt.resolution.displacementPenalty).toBe(1);
    expect(evt.resolution.toHit).toBe(6);
    expect(evt.resolution.hit).toBe(true);

    const lines = physicalResolutionLines(evt.resolution);
    expect(lines.join("\n")).toContain("+1");
  });
});

describe("mutual push (TW p.147)", () => {
  it("both succeed: neither moves and both roll defender-only PSRs", () => {
    const state = faceToFace();
    state.phase = "attack";
    state.units.hbk!.declaredPhysicalAttacks.push({ type: "push", targetId: "enf" });
    state.units.enf!.declaredPhysicalAttacks.push({ type: "push", targetId: "hbk" });
    const events: GameEvent[] = [];
    resolveAllAttacks(state, HIGH_RNG, events);

    const pushes = events.filter(
      (e): e is Extract<GameEvent, { kind: "physicalAttackResolved" }> =>
        e.kind === "physicalAttackResolved",
    );
    expect(pushes).toHaveLength(2);
    for (const p of pushes) {
      expect(p.resolution.hit).toBe(true);
      expect(p.resolution.targetPsr).not.toBeNull();
      expect(p.resolution.attackerPsr).toBeNull();
      expect(p.resolution.targetDisplacedTo).toBeNull();
      expect(p.resolution.attackerDisplacedTo).toBeNull();
    }
    // Neither 'Mech moves on a mutual both-succeed.
    expect(requireUnit(state, "hbk").position).toEqual({ col: 2, row: 2 });
    expect(requireUnit(state, "enf").position).toEqual({ col: 2, row: 3 });
  });
});

describe("per-sub-phase 20-point accounting", () => {
  it("two sub-threshold lots never pool into one roll", () => {
    const state = faceToFace();
    toAttack(state);
    const enf = requireUnit(state, "enf");
    const before = {
      damage: {
        hbk: { ...requireUnit(state, "hbk").damage },
        enf: {
          armor: { ...enf.damage.armor },
          armorRear: { ...enf.damage.armorRear },
          internalStructure: { ...enf.damage.internalStructure },
        },
      },
      crit: {
        hbk: requireUnit(state, "hbk").critSlotsDestroyed,
        enf: enf.critSlotsDestroyed,
      },
    };
    // 12 weapon damage: no trigger.
    enf.damage.armor.centerTorso -= 12;
    const first: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(), before, first);
    expect(first.filter((e) => e.kind === "pilotingCheck")).toEqual([]);

    // 12 more physical damage (24 total): still no trigger against the
    // post-weapon baseline — TW measures each phase separately.
    const mid = {
      damage: {
        hbk: { ...requireUnit(state, "hbk").damage },
        enf: {
          armor: { ...enf.damage.armor },
          armorRear: { ...enf.damage.armorRear },
          internalStructure: { ...enf.damage.internalStructure },
        },
      },
      crit: {
        hbk: requireUnit(state, "hbk").critSlotsDestroyed,
        enf: enf.critSlotsDestroyed,
      },
    };
    enf.damage.armor.centerTorso -= 12;
    const second: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(), mid, second);
    expect(second.filter((e) => e.kind === "pilotingCheck")).toEqual([]);
    expect(enf.prone).toBe(false);
  });
});

describe("attackPhaseStage markers", () => {
  it("bracket the weapon pass, the physical pass, and the aftermath through heat", () => {
    const state = faceToFace();
    toAttack(state);
    declareAttacks(state, "enf", [], [{ type: "punch", targetId: "hbk", limb: "rightArm" }], []);
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, HIGH_RNG, events);
    advancePhase(state, events, HIGH_RNG);

    const stageIdx = (stage: string) =>
      events.findIndex((e) => e.kind === "attackPhaseStage" && e.stage === stage);
    const [begin, weaponDone, physicalDone, end] = [
      stageIdx("begin"),
      stageIdx("weaponDone"),
      stageIdx("physicalDone"),
      stageIdx("end"),
    ];
    expect(begin).toBe(0);
    expect(weaponDone).toBeGreaterThan(begin);
    expect(physicalDone).toBeGreaterThan(weaponDone);
    expect(end).toBeGreaterThan(physicalDone);
    for (const e of events) {
      if (e.kind === "attackPhaseStage") expect(e.turn).toBe(state.turn);
    }

    const kindIdx = (kind: GameEvent["kind"]) => events.findIndex((e) => e.kind === kind);
    const shot = kindIdx("attackResolved");
    expect(shot).toBeGreaterThan(begin);
    expect(shot).toBeLessThan(weaponDone);
    const melee = kindIdx("physicalAttackResolved");
    expect(melee).toBeGreaterThan(weaponDone);
    expect(melee).toBeLessThan(physicalDone);
    const heat = kindIdx("heatDissipated");
    expect(heat).toBeGreaterThan(physicalDone);
    expect(heat).toBeLessThan(end);
    expect(events[end + 1]).toMatchObject({ kind: "phase", prevPhase: "attack", phase: "end" });
  });
});
