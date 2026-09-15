import { describe, expect, it } from "vitest";
import type { Location } from "../src/core/types.js";
import {
  applyDamage,
  getMechDefFor,
  type ResolvedCritSlot,
  suggestFireTargets,
  type UnitDamageState,
} from "../src/index.js";
import {
  advancePhase,
  applyFall,
  applyPilotHits,
  attemptStandUp,
  createBattle,
  declareAttacks,
  declareMove,
  dropProne,
  executeMove,
  getUnit,
  isImmobile,
  nextActor,
  type PhaseSnapshots,
  proneFacingTurn,
  resolveAllAttacks,
  resolveHeatPhase,
  resolvePhasePiloting,
  rollInitiativePhase,
  voluntaryShutdown,
  wreckAt,
} from "../src/rules/game.js";

import { createTestBattle, scriptedRng } from "./helpers.js";

function hbkEnf(critsDisabled = true) {
  return createTestBattle(
    [],
    [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: 2, row: 2 },
        facing: "s",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        position: { col: 2, row: 3 },
        facing: "n",
      },
    ],
    critsDisabled,
  );
}

function toMovement(state: ReturnType<typeof hbkEnf>): void {
  // rollInitiativePhase lands the battle straight in the movement phase.
  rollInitiativePhase(state, scriptedRng(3, 3, 4, 4));
}

function toAttack(state: ReturnType<typeof hbkEnf>): void {
  toMovement(state);
  advancePhase(state);
}

function startAttackTurn(state: ReturnType<typeof hbkEnf>): void {
  toMovement(state);
  advancePhase(state);
}

function cloneDamage(d: UnitDamageState): UnitDamageState {
  return {
    armor: { ...d.armor },
    armorRear: { ...d.armorRear },
    internalStructure: { ...d.internalStructure },
  };
}

function snapshot(state: ReturnType<typeof hbkEnf>): PhaseSnapshots {
  const damage: Record<string, UnitDamageState> = {};
  const crit: Record<string, Record<Location, boolean[]>> = {};
  for (const u of Object.values(state.units)) {
    damage[u.id] = cloneDamage(u.damage);
    crit[u.id] = Object.fromEntries(
      (Object.keys(u.critSlotsDestroyed) as Location[]).map((loc) => [
        loc,
        [...u.critSlotsDestroyed[loc]],
      ]),
    ) as Record<Location, boolean[]>;
  }
  return { damage, crit };
}

/** Slot indices of destroyable structure `name` in `loc`. */
function structureSlots(
  state: ReturnType<typeof hbkEnf>,
  id: string,
  loc: "head" | "centerTorso" | "rightLeg" | "leftLeg",
  name: string,
): number[] {
  const unit = getUnit(state, id);
  const def = getMechDefFor(unit);
  const out: number[] = [];
  def.critSlots[loc].forEach((slot: ResolvedCritSlot | undefined, i: number) => {
    if (slot?.kind === "structure" && slot.name === name) out.push(i);
  });
  return out;
}

describe("piloting skill", () => {
  it("defaults to 5 and validates 0..7", () => {
    const s = hbkEnf();
    expect(getUnit(s, "hbk").piloting).toBe(5);
    const custom = createTestBattle(
      [],
      [
        {
          id: "a",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          piloting: 2,
          position: { col: 1, row: 1 },
          facing: "n",
        },
        {
          id: "b",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 1, row: 2 },
          facing: "s",
        },
      ],
      true,
    );
    expect(getUnit(custom, "a").piloting).toBe(2);
    expect(() =>
      createBattle(
        { name: "x", width: 3, height: 3, terrain: [], legends: [] },
        [
          {
            id: "a",
            model: "HBK-4G",
            team: 0,
            gunnery: 4,
            piloting: 9,
            position: { col: 1, row: 1 },
            facing: "n",
          },
          {
            id: "b",
            model: "ENF-4R",
            team: 1,
            gunnery: 4,
            position: { col: 1, row: 2 },
            facing: "s",
          },
        ],
        { critsDisabled: true },
      ),
    ).toThrow(/Piloting for a must be an integer 0..7/);
  });
});

describe("20+ damage PSR", () => {
  it("success keeps the 'Mech up", () => {
    const state = hbkEnf();
    toAttack(state);
    // AC/20 to-hit 3+3, location 1+1 (CT), 20+ PSR 3+3 (needs 6: success).
    declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }]);
    resolveAllAttacks(state, scriptedRng(3, 3, 1, 1, 3, 3));
    const enf = getUnit(state, "enf");
    expect(enf.prone).toBe(false);
    expect(state.events).toContainEqual(
      expect.objectContaining({
        kind: "pilotingCheck",
        unitId: "enf",
        reason: "damage20",
        success: true,
      }),
    );
  });

  it("failure falls the 'Mech and rolls a seatbelt check", () => {
    const state = hbkEnf();
    toAttack(state);
    // to-hit 3+3, CT 1+1, PSR 1+2 (fail), fall dir 2 (right, +1 facing),
    // fall loc 1+1 (rightTorso), seatbelt 3+3 (needs 6: success).
    declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }]);
    resolveAllAttacks(state, scriptedRng(3, 3, 1, 1, 1, 2, 2, 1, 1, 3, 3));
    const enf = getUnit(state, "enf");
    expect(enf.prone).toBe(true);
    expect(enf.facing).toBe("ne"); // n rotated +1 hexside
    expect(enf.pilotHits).toBe(0);
    expect(state.events).toContainEqual(
      expect.objectContaining({ kind: "unitFell", unitId: "enf", cause: "failedPsr:damage20" }),
    );
  });
});

describe("leg destruction", () => {
  it("falls automatically; the immobile pilot takes the hit automatically", () => {
    const state = hbkEnf();
    const before = snapshot(state);
    const enf = getUnit(state, "enf");
    enf.damage.internalStructure.rightLeg = 0;
    // fall dir 1 (front, no turn), loc 3+4 (CT); legless 'Mech is immobile so
    // the seatbelt check is automatic damage + consciousness 2+2 (awake).
    resolvePhasePiloting(state, scriptedRng(1, 3, 4, 2, 2), before);
    expect(enf.prone).toBe(true);
    expect(enf.facing).toBe("n");
    expect(enf.pilotHits).toBe(1);
    expect(state.events).toContainEqual(
      expect.objectContaining({ kind: "unitFell", unitId: "enf", cause: "legDestroyed" }),
    );
    expect(state.events).toContainEqual(
      expect.objectContaining({ kind: "pilotDamaged", unitId: "enf", reason: "fall" }),
    );
    expect(state.events).not.toContainEqual(
      expect.objectContaining({ kind: "pilotingCheck", unitId: "enf", reason: "seatbelt" }),
    );
  });
});

describe("gyro crits", () => {
  it("first hit forces a +3 PSR", () => {
    const state = hbkEnf();
    const before = snapshot(state);
    const enf = getUnit(state, "enf");
    const gyro = structureSlots(state, "enf", "centerTorso", "gyro");
    expect(gyro.length).toBeGreaterThan(0);
    enf.critSlotsDestroyed.centerTorso[gyro[0]!] = true;
    // modifier 3, target 8: 4+4 succeeds, stays up.
    resolvePhasePiloting(state, scriptedRng(4, 4), before);
    expect(enf.prone).toBe(false);
    expect(state.events).toContainEqual(
      expect.objectContaining({
        kind: "pilotingCheck",
        unitId: "enf",
        reason: "gyro",
        modifier: 3,
        target: 8,
        success: true,
      }),
    );
  });

  it("destroyed gyro falls automatically with a +6 seatbelt check", () => {
    const state = hbkEnf();
    const before = snapshot(state);
    const enf = getUnit(state, "enf");
    for (const i of structureSlots(state, "enf", "centerTorso", "gyro")) {
      enf.critSlotsDestroyed.centerTorso[i] = true;
    }
    // fall dir 1, loc 3+4, seatbelt 5+6 (needs 11: success).
    resolvePhasePiloting(state, scriptedRng(1, 3, 4, 5, 6), before);
    expect(enf.prone).toBe(true);
    expect(state.events).toContainEqual(
      expect.objectContaining({ kind: "unitFell", unitId: "enf", cause: "gyroDestroyed" }),
    );
    expect(state.events).toContainEqual(
      expect.objectContaining({
        kind: "pilotingCheck",
        unitId: "enf",
        reason: "seatbelt",
        modifier: 6,
      }),
    );
  });
});

describe("actuator crits", () => {
  it("hip forces +2, leg actuator +1", () => {
    const state = hbkEnf();
    const before = snapshot(state);
    const enf = getUnit(state, "enf");
    const hip = structureSlots(state, "enf", "rightLeg", "hip");
    expect(hip.length).toBeGreaterThan(0);
    enf.critSlotsDestroyed.rightLeg[hip[0]!] = true;
    // modifier 2, target 7: 4+3 succeeds.
    resolvePhasePiloting(state, scriptedRng(4, 3), before);
    expect(enf.prone).toBe(false);
    expect(state.events).toContainEqual(
      expect.objectContaining({
        kind: "pilotingCheck",
        unitId: "enf",
        reason: "hip",
        modifier: 2,
        target: 7,
        success: true,
      }),
    );
  });
});

describe("shutdown PSR", () => {
  it("falls automatically and injures the pilot without a roll", () => {
    const state = hbkEnf();
    const before = snapshot(state);
    const enf = getUnit(state, "enf");
    enf.shutdown = "manual";
    enf.damage = applyDamage(enf.damage, "centerTorso", 20).after;
    // fall dir 1, loc 3+4; no PSR or seatbelt dice (automatic pilot damage).
    resolvePhasePiloting(state, scriptedRng(1, 3, 4, 2, 2), before);
    expect(enf.prone).toBe(true);
    expect(enf.pilotHits).toBe(1);
    expect(state.events).not.toContainEqual(
      expect.objectContaining({ kind: "pilotingCheck", unitId: "enf", reason: "damage20" }),
    );
  });
});

describe("immediate shutdown PSR (+3)", () => {
  it("heat shutdown rolls +3 PSR; pass stays standing", () => {
    const state = hbkEnf();
    const hbk = getUnit(state, "hbk");
    hbk.heat = 30;
    // startAttackTurn: 4 dice (initiative).
    // resolveHeatPhase: 4 dice (traced via debug):
    //   shutdownFallCheck PSR 2D6=12 passes (2 dice),
    //   restart check 2D6=8>6 comes online (2 dice).
    startAttackTurn(state);
    advancePhase(state, scriptedRng(6, 6, 6, 6));
    expect(hbk.shutdown).toBe("heat");
    expect(
      state.events.some(
        (e) => e.kind === "pilotingCheck" && e.unitId === "hbk" && e.reason === "shutdown",
      ),
    ).toBe(true);
    expect(hbk.prone).toBe(false);
  });

  it("heat shutdown rolls +3 PSR; fail drops the 'Mech", () => {
    const state = hbkEnf();
    const hbk = getUnit(state, "hbk");
    hbk.heat = 30;
    // resolveHeatPhase: 9 dice (traced via debug):
    //   PSR 2D6=2<8 fails (2), fallDir=1 (1), fallLoc 3+4=7 (2),
    //   consciousness 5+6=11>=3 pass (2), ammoExplosion 2+3=5<8 explodes (2).
    startAttackTurn(state);
    advancePhase(state, scriptedRng(1, 1, 1, 3, 4, 5, 6, 2, 3));
    expect(hbk.prone).toBe(true);
    expect(hbk.pilotHits).toBe(1);
  });

  it("voluntary shutdown triggers the same +3 PSR", () => {
    const state = hbkEnf();
    toMovement(state);
    const enf = getUnit(state, "enf");
    // No heat → no restart/ammoExplosion in shutdown path.
    // PSR 2D6=4<8 fails (2), fallDir=1 (1), fallLoc 3+4=7 (2),
    // seatbelt null → auto hit, consciousness 2D6=4>=3 (2). Total 7.
    voluntaryShutdown(state, "enf", scriptedRng(4, 1, 3, 4, 2, 2, 2));
    expect(enf.shutdown).toBe("manual");
    expect(enf.prone).toBe(true);
    expect(enf.pilotHits).toBe(1);
  });
});

describe("run-damaged PSR", () => {
  it("PSR fires at end of move when running with a damaged hip", () => {
    // hbkEnf: ENF at (2,3) facing "n". North forward: (2,2) occupied by hbk.
    // Use custom setup: ENF at (2,4) facing "n", hbk at (8,8) out of the way.
    const state = createTestBattle(
      [],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 8, row: 8 },
          facing: "s",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 2, row: 4 },
          facing: "n",
        },
      ],
      true,
    );
    toMovement(state);
    const enf = getUnit(state, "enf");
    declareMove(state, "enf", "run");
    const hipSlots = structureSlots(state, "enf", "rightLeg", "hip");
    expect(hipSlots.length).toBeGreaterThanOrEqual(1);
    enf.critSlotsDestroyed.rightLeg[hipSlots[0]!] = true;
    // North forward: (2,3), then (2,2). PSR 5+2=7, 2D6=8 passes.
    executeMove(
      state,
      "enf",
      [
        { kind: "enter", to: { col: 2, row: 3 } },
        { kind: "enter", to: { col: 2, row: 2 } },
      ],
      { rng: scriptedRng(4, 4) },
    );
    expect(
      state.events.some(
        (e) => e.kind === "pilotingCheck" && e.unitId === "enf" && e.reason === "runDamaged",
      ),
    ).toBe(true);
    expect(enf.prone).toBe(false);
  });

  it("PSR fail drops the unit", () => {
    const state = createTestBattle(
      [],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 8, row: 8 },
          facing: "s",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 2, row: 4 },
          facing: "n",
        },
      ],
      true,
    );
    toMovement(state);
    const enf = getUnit(state, "enf");
    declareMove(state, "enf", "run");
    const hipSlots = structureSlots(state, "enf", "rightLeg", "hip");
    enf.critSlotsDestroyed.rightLeg[hipSlots[0]!] = true;
    // PSR 2D6=2<7 fails; fall dir 1, loc 3+4 CT; seatbelt 5+2=7, 2D6=2 fails.
    // Consciousness 2D6=6>=3 pass.
    executeMove(state, "enf", [{ kind: "enter", to: { col: 2, row: 3 } }], {
      rng: scriptedRng(1, 1, 1, 3, 4, 1, 1, 3, 3),
    });
    expect(enf.prone).toBe(true);
    expect(enf.pilotHits).toBe(1);
  });
});

describe("jump-damaged PSR", () => {
  it("PSR fires at landing when jumping with damaged actuators", () => {
    // ENF at (2,4) facing "n". Jump to (2,3) — adjacent hex.
    const state = createTestBattle(
      [],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 8, row: 8 },
          facing: "s",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 2, row: 4 },
          facing: "n",
        },
      ],
      true,
    );
    toMovement(state);
    const enf = getUnit(state, "enf");
    declareMove(state, "enf", "jump");
    const footSlots = structureSlots(state, "enf", "rightLeg", "footActuator");
    expect(footSlots.length).toBeGreaterThanOrEqual(1);
    enf.critSlotsDestroyed.rightLeg[footSlots[0]!] = true;
    // PSR 5+1=6, 2D6=6 passes.
    executeMove(state, "enf", [{ kind: "enter", to: { col: 2, row: 3 } }], {
      rng: scriptedRng(3, 3),
    });
    expect(
      state.events.some(
        (e) => e.kind === "pilotingCheck" && e.unitId === "enf" && e.reason === "jumpDamaged",
      ),
    ).toBe(true);
    expect(enf.prone).toBe(false);
  });

  it("PSR fail drops the unit", () => {
    const state = createTestBattle(
      [],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 8, row: 8 },
          facing: "s",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 2, row: 4 },
          facing: "n",
        },
      ],
      true,
    );
    toMovement(state);
    const enf = getUnit(state, "enf");
    declareMove(state, "enf", "jump");
    const footSlots = structureSlots(state, "enf", "rightLeg", "footActuator");
    enf.critSlotsDestroyed.rightLeg[footSlots[0]!] = true;
    // PSR 2D6=2<6 fails; fall dir 1, loc 3+4 CT; seatbelt 5+1=6, 2D6=2 fails.
    // Consciousness 2D6=6>=3 pass.
    executeMove(state, "enf", [{ kind: "enter", to: { col: 2, row: 3 } }], {
      rng: scriptedRng(1, 1, 1, 3, 4, 1, 1, 3, 3),
    });
    expect(enf.prone).toBe(true);
    expect(enf.pilotHits).toBe(1);
  });
});

describe("building crash auto-fall", () => {
  it("crash that destroys a leg drops the unit immediately", () => {
    // ENF at (2,4) facing "n". Place heavyBuilding at (2,3) — forward hex.
    const state = createTestBattle(
      [{ col: 2, row: 3, type: "heavyBuilding" }],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 8, row: 8 },
          facing: "s",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 2, row: 4 },
          facing: "n",
        },
      ],
      true,
    );
    toMovement(state);
    const enf = getUnit(state, "enf");
    enf.damage.armor.rightLeg = 0;
    enf.damage.internalStructure.rightLeg = 1;
    declareMove(state, "enf", "walk");
    // Building entry PSR 5+2=7, 2D6=2<7 fails → crash.
    // Crash: ceil(90/10)=9 damage → 2 groups (5+4). Each needs loc roll.
    // Group1 loc 1+4=5 rightLeg, group2 loc 1+3=4 rightArm.
    // Auto-fall (leg destroyed, seatbelt auto because immobile).
    // Fall dir 1, loc 3+4=7 CT. Consciousness 2D6=12>=3 pass.
    executeMove(state, "enf", [{ kind: "enter", to: { col: 2, row: 3 } }], {
      rng: scriptedRng(1, 1, 1, 4, 1, 3, 1, 3, 4, 6, 6),
    });
    expect(enf.prone).toBe(true);
    expect(enf.pilotHits).toBe(1);
  });

  it("crash seatbelt fail injures the pilot", () => {
    const state = createTestBattle(
      [{ col: 2, row: 3, type: "heavyBuilding" }],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 8, row: 8 },
          facing: "s",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 2, row: 4 },
          facing: "n",
        },
      ],
      true,
    );
    toMovement(state);
    const enf = getUnit(state, "enf");
    enf.damage.armor.rightLeg = 0;
    enf.damage.internalStructure.rightLeg = 1;
    declareMove(state, "enf", "walk");
    // Building entry PSR 5+2=7, 2D6=2<7 fails → crash.
    // Crash 9 dmg → 2 groups (5+4). Loc: 5 rightLeg, 4 rightArm.
    // Auto-fall (leg destroyed, seatbelt auto because immobile).
    // Fall dir 1, loc 3+4=7 CT. Consciousness 2D6=2<3 fail → pilot hit.
    executeMove(state, "enf", [{ kind: "enter", to: { col: 2, row: 3 } }], {
      rng: scriptedRng(1, 1, 1, 4, 1, 3, 1, 3, 4, 1, 1),
    });
    expect(enf.prone).toBe(true);
    expect(enf.pilotHits).toBe(1);
  });

  it("crash that does not destroy the leg does not trigger auto-fall", () => {
    const state = createTestBattle(
      [{ col: 2, row: 3, type: "heavyBuilding" }],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 8, row: 8 },
          facing: "s",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 2, row: 4 },
          facing: "n",
        },
      ],
      true,
    );
    toMovement(state);
    const enf = getUnit(state, "enf");
    declareMove(state, "enf", "walk");
    // Building entry PSR 7 pass. Crash: 2 damage front column,
    // loc 7 CT. CT has 10 armor, no IS loss.
    executeMove(state, "enf", [{ kind: "enter", to: { col: 2, row: 3 } }], {
      rng: scriptedRng(3, 4, 3, 4),
    });
    expect(enf.prone).toBe(false);
    expect(enf.unconscious).toBe(false);
  });
});

describe("standing up", () => {
  it("success stands the 'Mech (counts as walking)", () => {
    const state = hbkEnf();
    toMovement(state);
    const enf = getUnit(state, "enf");
    enf.prone = true;
    attemptStandUp(state, "enf", scriptedRng(3, 3));
    expect(enf.prone).toBe(false);
    expect(enf.moveMode).toBe("walk");
    expect(state.events).toContainEqual(
      expect.objectContaining({
        kind: "moved",
        unitId: "enf",
        mode: "walk",
        prevMode: "prone",
        mpSpent: 2,
      }),
    );
  });

  it("failure crashes back down for fresh fall damage", () => {
    const state = hbkEnf();
    toMovement(state);
    const enf = getUnit(state, "enf");
    enf.prone = true;
    // stand 1+1 (fail), fall dir 4 (rear, +3), loc 3+3, seatbelt 1+2 (fail),
    // consciousness 2+2 (needs 3: awake).
    attemptStandUp(state, "enf", scriptedRng(1, 1, 4, 3, 3, 1, 2, 2, 2));
    expect(enf.prone).toBe(true);
    expect(enf.facing).toBe("s"); // n rotated +3 hexsides
    expect(enf.pilotHits).toBe(1);
  });

  it("refuses without a working gyro or any intact leg", () => {
    const state = hbkEnf();
    toMovement(state);
    const enf = getUnit(state, "enf");
    enf.prone = true;
    for (const i of structureSlots(state, "enf", "centerTorso", "gyro")) {
      enf.critSlotsDestroyed.centerTorso[i] = true;
    }
    expect(() => attemptStandUp(state, "enf")).toThrow(/destroyed gyro/);
    for (const i of structureSlots(state, "enf", "centerTorso", "gyro")) {
      enf.critSlotsDestroyed.centerTorso[i] = false;
    }
    enf.damage.internalStructure.rightLeg = 0;
    enf.damage.internalStructure.leftLeg = 0;
    expect(() => attemptStandUp(state, "enf")).toThrow(/no intact legs/);
  });
});

describe("going prone voluntarily", () => {
  it("dropProne costs heat and needs no roll", () => {
    const state = hbkEnf();
    toMovement(state);
    dropProne(state, "enf");
    const enf = getUnit(state, "enf");
    expect(enf.prone).toBe(true);
    expect(enf.heat).toBe(1);
    expect(state.events).toContainEqual(
      expect.objectContaining({
        kind: "moved",
        unitId: "enf",
        mode: "prone",
        prevMode: "standStill",
        mpSpent: 1,
      }),
    );
  });

  it("a prone 'Mech turns one hexside at a time", () => {
    const state = hbkEnf();
    toMovement(state);
    const enf = getUnit(state, "enf");
    enf.prone = true;
    proneFacingTurn(state, "enf", 1);
    expect(enf.facing).toBe("ne");
    expect(() => proneFacingTurn(state, "enf", 2)).toThrow(/only turn 1 hexside/);
  });
});

describe("prone combat", () => {
  it("rejects mixed-arm volleys and infers the propping arm", () => {
    const state = hbkEnf();
    toAttack(state);
    const hbk = getUnit(state, "hbk");
    hbk.prone = true;
    // HBK-4G: 1 ML leftArm, 2 ML rightArm, 3 SL head.
    expect(() =>
      declareAttacks(state, "hbk", [
        { weaponIndex: 1, targetId: "enf" },
        { weaponIndex: 2, targetId: "enf" },
      ]),
    ).toThrow(/both arms/);
  });

  it("accepts single-arm volleys and records prone + propArm on resolution", () => {
    const state = hbkEnf();
    toAttack(state);
    const hbk = getUnit(state, "hbk");
    hbk.prone = true;
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }]);
    expect(hbk.declaredAttacks).toHaveLength(1);
    resolveAllAttacks(state, scriptedRng(1, 1));
    const res = state.events.find((e) => e.kind === "attackResolved") as
      | { resolution: { prone: boolean; propArm: string | null } }
      | undefined;
    expect(res?.resolution.prone).toBe(true);
    expect(res?.resolution.propArm).toBe("rightArm");
  });

  it("shows prop-left and prop-right weapon sets while prone", () => {
    const state = hbkEnf();
    toAttack(state);
    getUnit(state, "hbk").prone = true;
    const target = suggestFireTargets(state, "hbk").targets[0]!;
    const left = target.weaponsIfPropLeft.map((w) => w.weaponIndex);
    const right = target.weaponsIfPropRight.map((w) => w.weaponIndex);
    // Left-arm ML (1) fires only when propping right; right-arm ML (2) only
    // when propping left.
    expect(left).toContain(2);
    expect(left).not.toContain(1);
    expect(right).toContain(1);
    expect(right).not.toContain(2);
  });

  it("gives a prone attacker +2 and a prone adjacent target -2", () => {
    const state = hbkEnf();
    toAttack(state);
    const hbk = getUnit(state, "hbk");
    const base = suggestFireTargets(state, "hbk").targets[0]!.weapons[0]!.tn;
    hbk.prone = true;
    const proneAttack = suggestFireTargets(state, "hbk").targets[0]!.weapons[0]!.tn;
    expect(proneAttack - base).toBe(2);
    hbk.prone = false;
    getUnit(state, "enf").prone = true;
    const proneTarget = suggestFireTargets(state, "hbk").targets[0]!.weapons[0]!.tn;
    expect(proneTarget - base).toBe(-2);
  });

  it("adds +2 on the first destroyed sensor and blinds on the second", () => {
    const state = hbkEnf();
    toAttack(state);
    const base = suggestFireTargets(state, "hbk").targets[0]!.weapons[0]!.tn;
    const hbk = getUnit(state, "hbk");
    const sensors = structureSlots(state, "hbk", "head", "sensors");
    expect(sensors).toHaveLength(2);
    hbk.critSlotsDestroyed.head[sensors[0]!] = true;
    const one = suggestFireTargets(state, "hbk").targets[0]!.weapons[0]!.tn;
    expect(one - base).toBe(2);
    hbk.critSlotsDestroyed.head[sensors[1]!] = true;
    const blind = suggestFireTargets(state, "hbk").targets[0]!;
    expect(blind.weapons).toHaveLength(0);
    expect(blind.blocked.length).toBeGreaterThan(0);
    for (const b of blind.blocked) expect(b.reason).toBe("noSensor");
    expect(() => declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }])).toThrow(
      /sensors/,
    );
  });
});

describe("pilot damage", () => {
  it("a head hit lands 1 point with a consciousness roll", () => {
    const state = hbkEnf();
    toAttack(state);
    // ML to-hit 3+3, location 6+6 (head), consciousness 2+2 (needs 3: awake).
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }]);
    resolveAllAttacks(state, scriptedRng(3, 3, 6, 6, 2, 2));
    expect(getUnit(state, "enf").pilotHits).toBe(1);
    expect(state.events).toContainEqual(
      expect.objectContaining({ kind: "pilotDamaged", unitId: "enf", reason: "headHit" }),
    );
  });

  it("the sixth hit kills the pilot, removes the unit, and leaves a level-2 wreck", () => {
    const state = hbkEnf();
    const enf = getUnit(state, "enf");
    // consciousness TN 3/5/7/10/11: all succeed.
    applyPilotHits(state, enf, 5, "headHit", scriptedRng(2, 2, 3, 3, 4, 4, 5, 5, 6, 6));
    expect(enf.pilotHits).toBe(5);
    expect(enf.destroyed).toBe("not");
    expect(state.wrecks["2,3"]).toBeUndefined();
    applyPilotHits(state, enf, 1, "fall", scriptedRng());
    expect(enf.pilotHits).toBe(6);
    expect(enf.destroyed).toBe("not");
    expect(enf.removed).toBe("pilotKilled");
    expect(state.wrecks["2,3"]).toEqual({ unitId: "enf", level: 2 });
    expect(wreckAt(state, { col: 2, row: 3 })?.unitId).toBe("enf");
    expect(state.events).toContainEqual(
      expect.objectContaining({ kind: "unitRemoved", unitId: "enf", reason: "pilotKilled" }),
    );
  });

  it("knockout skips the unit in the actor queue as immobile", () => {
    const state = hbkEnf();
    toMovement(state);
    const enf = getUnit(state, "enf");
    applyPilotHits(state, enf, 1, "fall", scriptedRng(1, 1));
    expect(enf.unconscious).toBe(true);
    expect(isImmobile(enf)).toBe(true);
    expect(nextActor(state)).toBe("hbk");
  });

  it("life support plus heat injures the pilot in the heat phase", () => {
    const state = hbkEnf();
    const hbk = getUnit(state, "hbk");
    const def = getMechDefFor(hbk);
    let marked = false;
    def.critSlots.head.forEach((slot: ResolvedCritSlot | undefined, i: number) => {
      if (slot?.kind === "structure" && slot.name === "lifeSupport") {
        hbk.critSlotsDestroyed.head[i] = true;
        marked = true;
      }
    });
    expect(marked).toBe(true);
    hbk.heat = 29;
    // shutdown avoid (needs 11+: 5+6), ammo avoid (needs 8+: 4+4),
    // dissipation leaves 16 (heat 29 - 13 sinks), life support 1 hit,
    // consciousness (needs 3: 2+2).
    resolveHeatPhase(state, scriptedRng(5, 6, 4, 4, 2, 2));
    expect(hbk.pilotHits).toBe(1);
    expect(state.events).toContainEqual(
      expect.objectContaining({ kind: "pilotDamaged", unitId: "hbk", reason: "lifeSupport" }),
    );
  });
});

describe("movement terrain PSRs", () => {
  it("a failed rubble roll falls the 'Mech in the entered hex", () => {
    const state = createTestBattle(
      [{ col: 2, row: 3, type: "rubble" }],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 2, row: 2 },
          facing: "s",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 3, row: 3 },
          facing: "n",
        },
      ],
      true,
    );
    toMovement(state);
    declareMove(state, "hbk", "walk");
    // PSR 1+2 (needs 5: fail), fall dir 2, loc 3+3, seatbelt 3+3 (success).
    executeMove(state, "hbk", [{ kind: "enter", to: { col: 2, row: 3 } }], {
      rng: scriptedRng(1, 2, 2, 3, 3, 3, 3),
    });
    const hbk = getUnit(state, "hbk");
    expect(hbk.position).toEqual({ col: 2, row: 3 });
    expect(hbk.prone).toBe(true);
  });

  it("a passed water1 roll (-1) keeps the 'Mech up", () => {
    const state = createTestBattle(
      [{ col: 2, row: 3, type: "water1" }],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 2, row: 2 },
          facing: "s",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 3, row: 3 },
          facing: "n",
        },
      ],
      true,
    );
    toMovement(state);
    declareMove(state, "hbk", "walk");
    // needs 4: 2+2 succeeds.
    executeMove(state, "hbk", [{ kind: "enter", to: { col: 2, row: 3 } }], {
      rng: scriptedRng(2, 2),
    });
    const hbk = getUnit(state, "hbk");
    expect(hbk.position).toEqual({ col: 2, row: 3 });
    expect(hbk.prone).toBe(false);
  });

  it("a failed building entry crashes without falling", () => {
    const state = createTestBattle(
      [{ col: 2, row: 3, type: "lightBuilding" }],
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 2, row: 2 },
          facing: "s",
        },
        {
          id: "enf",
          model: "ENF-4R",
          team: 1,
          gunnery: 4,
          position: { col: 3, row: 3 },
          facing: "n",
        },
      ],
      true,
    );
    toMovement(state);
    declareMove(state, "hbk", "walk");
    // PSR 1+2 (needs 5: fail), crash loc 3+3, ceil(15/10) = 2 damage.
    executeMove(state, "hbk", [{ kind: "enter", to: { col: 2, row: 3 } }], {
      rng: scriptedRng(1, 2, 3, 3),
    });
    const hbk = getUnit(state, "hbk");
    expect(hbk.prone).toBe(false);
    expect(state.events).toContainEqual(
      expect.objectContaining({ kind: "buildingCrash", unitId: "hbk", totalDamage: 2 }),
    );
  });
});

describe("applyFall", () => {
  it("is a no-op on an already-prone unit", () => {
    const state = hbkEnf();
    const enf = getUnit(state, "enf");
    enf.prone = true;
    applyFall(state, enf, scriptedRng(), { cause: "water", seatbeltModifier: 0, halved: false });
    expect(state.events.some((e) => e.kind === "unitFell")).toBe(false);
  });
});
