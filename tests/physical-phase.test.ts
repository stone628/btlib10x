/**
 * Weapon-then-physical sub-pass ordering (TW pp.37-38,59-61,144,147).
 * Declarations stay merged for playability (one attack activation per unit
 * per turn); resolution splits into a weapon sub-pass, a weapon PSR sweep,
 * then the melee, then a physical sweep.
 */
import { describe, expect, it } from "vitest";
import type { HexCoord } from "../src/core/types";
import type { BattleState, TeamId, UnitInit } from "../src/rules/game";
import {
  advancePhase,
  buildUnitInit,
  declareAttacks,
  type GameEvent,
  passAttack,
  requireUnit,
  resolveAllAttacks,
  resolvePhasePiloting,
  rollInitiativePhase,
} from "../src/rules/game";
import { createTestBattle, scriptedRng } from "./helpers";

const HIGH_RNG = {
  d6: () => 6,
  snapshot: () => "",
  load: () => {},
};

function unit(
  id: string,
  team: TeamId,
  pos: HexCoord,
  facing: "n" | "ne" | "se" | "s" | "sw" | "nw",
): UnitInit {
  return buildUnitInit(id, "HBK-4G", team, pos, facing);
}

/** hbk (team 1) at (2,2)/s facing enf (team 2) at (2,3)/n, attack phase. */
function faceToFace(): BattleState {
  return createTestBattle(
    [],
    [unit("hbk", 1, { col: 2, row: 2 }, "s"), unit("enf", 2, { col: 2, row: 3 }, "n")],
    true,
  );
}

function toAttack(state: BattleState): void {
  // Duplicate of the piloting-test drive: initiative -> movement -> attack.
  // Default rng: team 1 (8) beats team 2 (4), so enf (loser) declares first.
  rollInitiativePhase(state, scriptedRng(4, 4, 2, 2), []);
  advancePhase(state, [], scriptedRng());
}

describe("weapon sweep lands before the melee", () => {
  it("a weapon-phase fall leaves the attacker prone so its punch auto-misses", () => {
    const state = faceToFace();
    toAttack(state);
    // enf (loser) declares first, then hbk's AC/20 (weapon index 4).
    declareAttacks(
      state,
      "enf",
      [],
      [{ type: "punch", targetId: "hbk", limb: "rightArm" }],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    declareAttacks(
      state,
      "hbk",
      [{ weaponIndex: 4, targetId: "enf" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
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
    declareAttacks(
      state,
      "enf",
      [],
      [{ type: "punch", targetId: "hbk", limb: "rightArm" }],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    declareAttacks(
      state,
      "hbk",
      [{ weaponIndex: 4, targetId: "enf" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
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
    declareAttacks(
      state,
      "enf",
      [],
      [{ type: "punch", targetId: "hbk", limb: "rightArm" }],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
    declareAttacks(
      state,
      "hbk",
      [{ weaponIndex: 1, targetId: "enf" }],
      [],
      [],
      scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
    );
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

describe("critsDisabled covers physical attacks", () => {
  /** enf punches hbk's armorless right torso: d6 = 4 gives to-hit 8 (hit),
   *  punch location 4 (right torso) and a crit determining roll of 8. */
  function punchIntoStructure(critsDisabled: boolean) {
    const state = createTestBattle(
      [],
      [unit("hbk", 1, { col: 2, row: 2 }, "s"), unit("enf", 2, { col: 2, row: 3 }, "n")],
      critsDisabled,
    );
    toAttack(state);
    const hbk = requireUnit(state, "hbk");
    hbk.damage = { ...hbk.damage, armor: { ...hbk.damage.armor, rightTorso: 0 } };
    const slotsBefore = hbk.critSlotsDestroyed;
    declareAttacks(
      state,
      "enf",
      [],
      [{ type: "punch", targetId: "hbk", limb: "rightArm" }],
      [],
      HIGH_RNG,
    );
    passAttack(state, "hbk");
    let rolls = 0;
    const rng = {
      d6: () => {
        rolls++;
        return 4;
      },
      snapshot: () => "",
      load: () => {},
    };
    const events: GameEvent[] = [];
    resolveAllAttacks(state, rng, events);
    const punch = events.find((e) => e.kind === "physicalAttackResolved");
    if (punch?.kind !== "physicalAttackResolved") throw new Error("no punch resolved");
    return { punch: punch.resolution, rolls, slotsBefore, slotsAfter: hbk.critSlotsDestroyed };
  }

  it("a punch into structure rolls criticals when they are on", () => {
    const on = punchIntoStructure(false);
    expect(on.punch.hit).toBe(true);
    expect(on.punch.crits.length).toBeGreaterThan(0);
    expect(on.slotsAfter).not.toEqual(on.slotsBefore);
  });

  it("rolls none and spends no dice on them when they are off", () => {
    const on = punchIntoStructure(false);
    const off = punchIntoStructure(true);
    expect(off.punch.hit).toBe(true);
    expect(off.punch.crits).toEqual([]);
    expect(off.slotsAfter).toEqual(off.slotsBefore);
    expect(off.rolls).toBeLessThan(on.rolls);
  });
});
