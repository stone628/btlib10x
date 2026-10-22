import { describe, expect, it } from "vitest";
import type { HexCoord } from "../src/core/types";
import { mechDefFor } from "../src/data/index";
import {
  advancePhase,
  type BattleState,
  buildUnitInit,
  declareAttacks,
  type GameEvent,
  passAttack,
  requireUnit,
  resolveAllAttacks,
  rollInitiativePhase,
  type TeamId,
  type UnitInit,
  validateAttacks,
} from "../src/rules/game";
import { resolvePhysicalAttack, validatePhysicalAttack } from "../src/rules/physical";
import {
  commitMovement,
  declareMovementMode,
  newSession,
  queueDrop,
  queuePhysicalAttack,
  queueWeaponAttacks,
  type Session,
  setTorsoTwist,
} from "../web/terminal/session";
import { physicalResolutionLines } from "../web/terminal/session.attack";
import { createTestBattle, disableCritical, execute, scriptedRng, sweepPiloting } from "./helpers";

/**
 * Weapon-then-physical sub-pass ordering (TW pp.37-38,59-61,144,147).
 * Declarations stay merged for playability (one attack activation per unit
 * per turn); resolution splits into a weapon sub-pass, a weapon PSR sweep,
 * then the melee, then a physical sweep.
 */

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
    // Then the salvage fall of the destroyed Enforcer (TW p.128).
    resolveAllAttacks(state, scriptedRng(3, 3, 1, 1, 1, 3, 3), events);

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
    sweepPiloting(state, scriptedRng(), before, first);
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
    sweepPiloting(state, scriptedRng(), mid, second);
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

describe("combined-attacks", () => {
  /** Head-to-head adjacency: hunchy (9,9) facing n, cicada (9,8) facing s. */
  function attackSetup(): { s: Session; actor: string; enemy: string } {
    const s = newSession(42);
    expect(execute(s, "map quickstart")[0]).toContain("15x16");
    expect(execute(s, "add hunchy HBK-4G 9 9 n")).toHaveLength(1);
    expect(execute(s, "add cicada CDA-3MA 9 8 s")).toHaveLength(1);
    execute(s, "start");
    disableCritical(s);
    while (s.state === "battle" && s.battle!.phase === "movement") {
      declareMovementMode(s, "walk");
      commitMovement(s);
    }
    expect(s.battle!.phase).toBe("attack");
    const actor = s.attack!.actorId;
    const enemy = actor === "hunchy" ? "cicada" : "hunchy";
    return { s, actor, enemy };
  }

  /** Engine-0-based right-arm and torso weapon indices for the actor's 'Mech. */
  function armAndTorso(s: Session, actor: string): { arm: number; torso: number } {
    const def = mechDefFor(requireUnit(s.battle!, actor));
    const arm = Number(
      Object.keys(def.weapons).find((k) => def.weapons[Number(k)]?.location === "rightArm"),
    );
    const torso = Number(
      Object.keys(def.weapons).find((k) => {
        const loc = def.weapons[Number(k)]?.location;
        return loc === "centerTorso" || loc === "leftTorso" || loc === "rightTorso";
      }),
    );
    expect(Number.isInteger(arm)).toBe(true);
    expect(Number.isInteger(torso)).toBe(true);
    return { arm, torso };
  }

  describe("stacked weapon + physical declarations", () => {
    it("rejects firing the punching arm's weapons (punch first)", () => {
      const { s, enemy } = attackSetup();
      const { arm } = armAndTorso(s, s.attack!.actorId);
      queuePhysicalAttack(s, "punch", enemy, "rightArm");
      expect(() => queueWeaponAttacks(s, enemy, [arm])).toThrow(/rightArm/);
      expect(s.attack!.physicalDecls.length).toBe(1);
      expect(s.attack!.weaponDecls).toEqual([]);
    });

    it("rejects punching with an arm whose weapons already fire (fire first)", () => {
      const { s, enemy } = attackSetup();
      const { arm } = armAndTorso(s, s.attack!.actorId);
      queueWeaponAttacks(s, enemy, [arm]);
      expect(() => queuePhysicalAttack(s, "punch", enemy, "rightArm")).toThrow(/rightArm/);
      expect(s.attack!.weaponDecls.length).toBe(1);
      expect(s.attack!.physicalDecls).toEqual([]);
    });

    it("accepts a torso weapon plus punch and resolves both on done", () => {
      const { s, enemy } = attackSetup();
      const { torso } = armAndTorso(s, s.attack!.actorId);
      queueWeaponAttacks(s, enemy, [torso]);
      queuePhysicalAttack(s, "punch", enemy, "rightArm");
      expect(s.attack!.weaponDecls.length).toBe(1);
      expect(s.attack!.physicalDecls.length).toBe(1);
      for (const line of execute(s, "done")) expect(line).not.toMatch(/^error:/);
    });

    it("locks the twist after punch or club, but not after kick", () => {
      const first = attackSetup();
      queuePhysicalAttack(first.s, "punch", first.enemy, "rightArm");
      expect(() => setTorsoTwist(first.s, "leftSide")).toThrow(/locked/);

      const second = attackSetup();
      queuePhysicalAttack(second.s, "kick", second.enemy, "rightLeg");
      expect(setTorsoTwist(second.s, "leftSide")).toBe("front");
      expect(second.s.attack!.torsoTwist).toBe("leftSide");
    });
  });

  describe("club commands reach the engine (DEAD-01)", () => {
    it("a queued drop is committed: the held club lands in the hex", () => {
      const { s, actor } = attackSetup();
      requireUnit(s.battle!, actor).club = { kind: "tree" };
      queueDrop(s);
      for (const line of execute(s, "done")) expect(line).not.toMatch(/^error:/);
      expect(requireUnit(s.battle!, actor).club).toBeNull();
    });

    it("after a drop, arm weapons fire and the arm punches", () => {
      const { s, actor, enemy } = attackSetup();
      requireUnit(s.battle!, actor).club = { kind: "girder" };
      const { arm } = armAndTorso(s, actor);
      expect(() => queueWeaponAttacks(s, enemy, [arm])).toThrow(/club/);
      queueDrop(s);
      queueWeaponAttacks(s, enemy, [arm]);
      queuePhysicalAttack(s, "punch", enemy, "leftArm");
      for (const line of execute(s, "done")) expect(line).not.toMatch(/^error:/);
      expect(requireUnit(s.battle!, actor).club).toBeNull();
    });
  });
});

describe("physical-fixes", () => {
  /**
   * Physical-combat fixes (TW pp.38,144-151): missing actuators, simultaneous
   * physical-phase pilot damage, and declaration rules.
   */

  const HIGH_RNG = { d6: () => 6, snapshot: () => "", load: () => {} };

  type Facing = "n" | "ne" | "se" | "s" | "sw" | "nw";
  const mech = (
    id: string,
    team: TeamId,
    pos: HexCoord,
    facing: Facing,
    model = "HBK-4G",
  ): UnitInit => buildUnitInit(id, model, team, pos, facing);

  function toAttack(state: BattleState): void {
    rollInitiativePhase(state, scriptedRng(4, 4, 2, 2), []);
    advancePhase(state, [], scriptedRng());
  }

  describe("missing arm actuators (PHY-05)", () => {
    it("an MC-MKII-2 punch ignores the lower arm and hand it does not have", () => {
      const state = createTestBattle(
        [],
        [mech("a", 1, { col: 2, row: 2 }, "s", "MC-MKII-2"), mech("b", 2, { col: 2, row: 3 }, "n")],
        true,
      );
      const res = resolvePhysicalAttack(
        state,
        "a",
        { type: "punch", targetId: "b", limb: "rightArm" },
        HIGH_RNG,
      );
      expect(res.toHit).toBe(8);
      expect(res.damageToTarget.reduce((n, g) => n + g.damage, 0)).toBe(4);
    });
  });

  describe("declaration rules (PHY-10, PHY-11)", () => {
    it("allows two punches at two targets but not mixed types", () => {
      const state = createTestBattle(
        [],
        [
          mech("a", 2, { col: 2, row: 2 }, "s"),
          mech("b", 1, { col: 2, row: 3 }, "n"),
          mech("c", 1, { col: 3, row: 2 }, "n"),
        ],
        true,
      );
      expect(
        validatePhysicalAttack(state, "a", { type: "punch", targetId: "b", limb: "rightArm" }).ok,
      ).toBe(true);
      toAttack(state);
      state.actorQueue = ["a", "b", "c"];
      expect(() =>
        declareAttacks(
          state,
          "a",
          [],
          [
            { type: "punch", targetId: "b", limb: "leftArm" },
            { type: "kick", targetId: "c", limb: "rightLeg" },
          ],
          [],
          scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
        ),
      ).toThrow(/one type/);
      expect(() =>
        declareAttacks(
          state,
          "a",
          [],
          [
            { type: "punch", targetId: "b", limb: "rightArm" },
            { type: "punch", targetId: "c", limb: "leftArm" },
          ],
          [],
          scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
        ),
      ).not.toThrow();
    });
  });

  describe("one physical attack per turn", () => {
    it("rejects a second kick, with either leg", () => {
      const state = createTestBattle(
        [],
        [mech("a", 2, { col: 2, row: 2 }, "s"), mech("b", 1, { col: 2, row: 3 }, "n")],
        true,
      );
      const kick = (limb: "leftLeg" | "rightLeg") => ({
        type: "kick" as const,
        targetId: "b",
        limb,
      });
      expect(() => validateAttacks(state, "a", [], [kick("leftLeg")])).not.toThrow();
      expect(() => validateAttacks(state, "a", [], [kick("leftLeg"), kick("leftLeg")])).toThrow(
        /only one kick/,
      );
      expect(() => validateAttacks(state, "a", [], [kick("leftLeg"), kick("rightLeg")])).toThrow(
        /only one kick/,
      );
    });
  });

  describe("simultaneous physical phase (PHY-07)", () => {
    it("a head hit does not stop the victim's own declared punch", () => {
      const state = createTestBattle(
        [],
        [mech("a", 1, { col: 2, row: 2 }, "s"), mech("b", 2, { col: 2, row: 3 }, "n")],
        true,
      );
      toAttack(state);
      declareAttacks(
        state,
        "b",
        [],
        [{ type: "punch", targetId: "a", limb: "rightArm" }],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      );
      declareAttacks(
        state,
        "a",
        [],
        [{ type: "punch", targetId: "b", limb: "rightArm" }],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      );
      const events: GameEvent[] = [];
      resolveAllAttacks(state, HIGH_RNG, events);
      const resolved = events.filter((e) => e.kind === "physicalAttackResolved");
      expect(resolved).toHaveLength(2);
      for (const e of resolved) {
        if (e.kind === "physicalAttackResolved") expect(e.resolution.missReason).toBeUndefined();
      }
    });
  });
});

describe("physical-detail", () => {
  /**
   * Physical-attack damage detail + crit rendering (weapon parity).
   * A kick that lands must print the armor `before->after` chain via the
   * shared `blastDetail` formatter, and internal-structure damage must attach
   * crits rendered with the same `critLines` formatter as weapon hits.
   */

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
      expect(res.applications).toHaveLength(1);

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
      expect(res.applications).toHaveLength(1);
      expect(res.crits).toHaveLength(1);

      const text = physicalResolutionLines(res).join("\n");
      expect(text).toMatch(/RLA 4->0\*/);
      expect(text).toMatch(/RLI \d+->\d+/);
      expect(text).toContain("crit roll 2D6 = 7");
    });
  });
});
