import { describe, expect, it } from "vitest";
import type { Location } from "../src/core/types";
import { mechDef } from "../src/data/index";
import {
  mechDefFor,
  type ResolvedCritSlot,
  suggestFireTargets,
  type UnitDamageState,
} from "../src/index";
import { type CritMask, cloneCritTable, setSlotDestroyed } from "../src/rules/critical";
import { applyDamage, dealtOf } from "../src/rules/damage";
import {
  advancePhase,
  applyFall,
  applyPilotHits,
  attemptStandUp,
  buildUnitInit,
  declareAttacks,
  dropProne,
  executeMove,
  type GameEvent,
  isImmobile,
  nextActor,
  type PhaseSnapshots,
  requireUnit,
  resolveAllAttacks,
  resolveHeatPhase,
  resolvePhasePiloting,
  rollInitiativePhase,
  wreckAt,
} from "../src/rules/game";
import { rollFallDirection } from "../src/rules/piloting";

import { createTestBattle, scriptedRng } from "./helpers";

function hbkEnf(critsDisabled = true) {
  return createTestBattle(
    [],
    [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 3 }, "n"),
    ],
    critsDisabled,
  );
}

function toMovement(
  state: ReturnType<typeof hbkEnf>,
  rng: ReturnType<typeof scriptedRng> = scriptedRng(4, 4, 2, 2),
): void {
  // rollInitiativePhase lands the battle straight in the movement phase.
  // Default rng makes team 1 win: enf is the loser and acts first. Tests
  // that need hbk to act first pass an explicit rng.
  rollInitiativePhase(state, rng, []);
}

function toAttack(
  state: ReturnType<typeof hbkEnf>,
  rng: ReturnType<typeof scriptedRng> = scriptedRng(4, 4, 2, 2),
): void {
  toMovement(state, rng);
  advancePhase(state, []);
}

function startAttackTurn(state: ReturnType<typeof hbkEnf>): void {
  toMovement(state);
  advancePhase(state, []);
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
  const crit: Record<string, CritMask> = {};
  for (const u of Object.values(state.units)) {
    damage[u.id] = cloneDamage(u.damage);
    crit[u.id] = cloneCritTable(u.critSlotsDestroyed);
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
  const unit = requireUnit(state, id);
  const def = mechDefFor(unit);
  const out: number[] = [];
  def.critSlots[loc].forEach((slot: ResolvedCritSlot | undefined, i: number) => {
    if (slot?.kind === "structure" && slot.name === name) out.push(i);
  });
  return out;
}

describe("piloting skill", () => {
  it("defaults to 5 and validates 0..7", () => {
    const s = hbkEnf();
    expect(requireUnit(s, "hbk").piloting).toBe(5);
    const custom = createTestBattle(
      [],
      [
        buildUnitInit("a", "HBK-4G", 1, { col: 1, row: 1 }, "n", 4, 2),
        buildUnitInit("b", "ENF-4R", 2, { col: 1, row: 2 }, "s"),
      ],
      true,
    );
    expect(requireUnit(custom, "a").piloting).toBe(2);
  });
});

describe("20+ damage PSR", () => {
  it("success keeps the 'Mech up", () => {
    const state = hbkEnf();
    toAttack(state, scriptedRng(2, 2, 5, 5));
    // AC/20 to-hit 3+3, location 1+1 (CT), 20+ PSR 3+3 (needs 6: success).
    declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }], [], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(3, 3, 1, 1, 3, 3), events);
    const enf = requireUnit(state, "enf");
    expect(enf.prone).toBe(false);
    expect(events).toContainEqual(
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
    toAttack(state, scriptedRng(2, 2, 5, 5));
    // to-hit 3+3, CT 1+1, PSR 1+2 (fail), fall dir 2 (right, +1 facing),
    // fall loc 1+1 (rightTorso), seatbelt 3+3 (needs 6: success).
    declareAttacks(state, "hbk", [{ weaponIndex: 4, targetId: "enf" }], [], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(3, 3, 1, 1, 1, 2, 2, 1, 1, 3, 3), events);
    const enf = requireUnit(state, "enf");
    expect(enf.prone).toBe(true);
    expect(enf.facing).toBe("ne"); // n rotated +1 hexside
    expect(enf.pilotHits).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "unitFell",
        unitId: "enf",
        cause: { kind: "failedPsr", reason: "damage20" },
      }),
    );
  });
});

describe("20-point trigger counts marked points, not wiped armor (TW p.122 step 5)", () => {
  // ENF-4R leftTorso: 17 front / 3 rear / 12 IS. Pre-damage the front to 8,
  // snapshot, then destroy it from the rear in the "phase": marked = 3 + 12
  // = 15 < 20, but the wiped front 8 pushes the before/after diff to 23.
  function killEnfLeftTorso() {
    const state = hbkEnf();
    const enf = requireUnit(state, "enf");
    enf.damage = applyDamage(enf.damage, "leftTorso", 9).after;
    expect(enf.damage.armor.leftTorso).toBe(8);
    const before = snapshot(state);
    const app = applyDamage(enf.damage, "leftTorso", 15, "rear");
    enf.damage = app.after;
    expect(enf.damage.internalStructure.leftTorso).toBe(0);
    return { state, before, dealt: { enf: dealtOf(app) } };
  }

  it("rear-arc kill: wiped front armor does not trigger the PSR", () => {
    const { state, before, dealt } = killEnfLeftTorso();
    expect(dealt.enf).toBe(15);
    const events: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(), before, events, undefined, false, dealt);
    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: "pilotingCheck", unitId: "enf", reason: "damage20" }),
    );
    expect(requireUnit(state, "enf").prone).toBe(false);
  });

  it("the same kill triggers through the fallback diff (sanity: the test is not vacuous)", () => {
    const { state, before } = killEnfLeftTorso();
    // No ledger: before/after diff = 8 + 3 + 12 = 23 (the blown-off arm is
    // excluded like before) → trigger. Target 5 + 1 + 0 = 6: 3+3 succeeds.
    const events: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(3, 3), before, events);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "pilotingCheck",
        unitId: "enf",
        reason: "damage20",
        success: true,
      }),
    );
    expect(requireUnit(state, "enf").prone).toBe(false);
  });

  it("20 marked points still trigger through the ledger", () => {
    const state = hbkEnf();
    const before = snapshot(state);
    const enf = requireUnit(state, "enf");
    const app = applyDamage(enf.damage, "centerTorso", 20);
    enf.damage = app.after;
    const dealt = { enf: dealtOf(app) };
    expect(dealt.enf).toBe(20);
    const events: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(3, 3), before, events, undefined, false, dealt);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "pilotingCheck",
        unitId: "enf",
        reason: "damage20",
        success: true,
      }),
    );
  });
});

describe("leg destruction", () => {
  it("falls automatically; seatbelt PSR +5 (TW p.122) — not auto-damage", () => {
    const state = hbkEnf();
    const before = snapshot(state);
    const enf = requireUnit(state, "enf");
    enf.damage.internalStructure.rightLeg = 0;
    // ENF-4R 50-ton fall damage = 5 (1 group). Fall dir 1, loc 3+4=7 CT.
    // Seatbelt PSR (piloting 5 + 5 = 10): 4+5=9 fails → pilot hit.
    // Consciousness: 6+6=12 pass.
    const events: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(1, 3, 4, 4, 5, 6, 6), before, events);
    expect(enf.prone).toBe(true);
    expect(enf.facing).toBe("n");
    expect(enf.pilotHits).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "unitFell", unitId: "enf", cause: { kind: "legDestroyed" } }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "pilotingCheck",
        unitId: "enf",
        reason: "seatbelt",
        basePiloting: 5,
        triggerModifier: 5,
        preexistingModifier: 0,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "pilotDamaged", unitId: "enf", reason: "fall" }),
    );
  });

  it("falls automatically; seatbelt PSR +5 success → no pilot hit", () => {
    const state = hbkEnf();
    const before = snapshot(state);
    const enf = requireUnit(state, "enf");
    enf.damage.internalStructure.rightLeg = 0;
    // ENF-4R 50-ton fall damage = 5 (1 group). Fall dir 1, loc 3+4=7 CT.
    // Seatbelt PSR (piloting 5 + 5 = 10): 5+6=11 success.
    const events: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(1, 3, 4, 5, 6), before, events);
    expect(enf.prone).toBe(true);
    expect(enf.pilotHits).toBe(0);
    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: "pilotDamaged", unitId: "enf", reason: "fall" }),
    );
  });

  it("both legs and both arms gone: seatbelt auto-damage (TW p.122 immobile)", () => {
    const state = hbkEnf();
    const before = snapshot(state);
    const enf = requireUnit(state, "enf");
    enf.damage.internalStructure.rightLeg = 0;
    enf.damage.internalStructure.leftLeg = 0;
    enf.damage.internalStructure.rightArm = 0;
    enf.damage.internalStructure.leftArm = 0;
    // TW p.122: immobile target → seatbelt auto-pilot-hit, no PSR roll.
    // Fall dir 1, loc1 3+4=7 CT, loc2 2+2=4 RA. Consciousness 2D6=6+6 pass.
    const events: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(1, 3, 4, 2, 2, 6, 6), before, events);
    expect(enf.prone).toBe(true);
    expect(enf.pilotHits).toBe(1);
    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: "pilotingCheck", unitId: "enf", reason: "seatbelt" }),
    );
  });
});

describe("gyro crits", () => {
  it("first hit forces a +3 PSR", () => {
    const state = hbkEnf();
    const before = snapshot(state);
    const enf = requireUnit(state, "enf");
    const gyro = structureSlots(state, "enf", "centerTorso", "gyro");
    expect(gyro.length).toBeGreaterThan(0);
    setSlotDestroyed(enf.critSlotsDestroyed, "centerTorso", gyro[0]!);
    // modifier 3, target 8: 4+4 succeeds, stays up.
    const events: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(4, 4), before, events);
    expect(enf.prone).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "pilotingCheck",
        unitId: "enf",
        reason: "gyro",
        basePiloting: 5,
        triggerModifier: 3,
        preexistingModifier: 0,
        success: true,
      }),
    );
  });

  it("destroyed gyro falls automatically with a +6 seatbelt check", () => {
    const state = hbkEnf();
    const before = snapshot(state);
    const enf = requireUnit(state, "enf");
    for (const i of structureSlots(state, "enf", "centerTorso", "gyro")) {
      setSlotDestroyed(enf.critSlotsDestroyed, "centerTorso", i);
    }
    // fall dir 1, loc 3+4, seatbelt 5+6 (needs 11: success).
    const events: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(1, 3, 4, 5, 6), before, events);
    expect(enf.prone).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "unitFell",
        unitId: "enf",
        cause: { kind: "gyroDestroyed" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "pilotingCheck",
        unitId: "enf",
        reason: "seatbelt",
        basePiloting: 5,
        triggerModifier: 6,
        preexistingModifier: 0,
      }),
    );
  });
});

describe("actuator crits", () => {
  it("hip forces +2, leg actuator +1", () => {
    const state = hbkEnf();
    const before = snapshot(state);
    const enf = requireUnit(state, "enf");
    const hip = structureSlots(state, "enf", "rightLeg", "hip");
    expect(hip.length).toBeGreaterThan(0);
    setSlotDestroyed(enf.critSlotsDestroyed, "rightLeg", hip[0]!);
    // modifier 2, target 7: 4+3 succeeds.
    const events: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(4, 3), before, events);
    expect(enf.prone).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "pilotingCheck",
        unitId: "enf",
        reason: "hip",
        basePiloting: 5,
        triggerModifier: 2,
        preexistingModifier: 0,
        success: true,
      }),
    );
  });
});

describe("shutdown PSR", () => {
  it("falls automatically and injures the pilot without a roll", () => {
    const state = hbkEnf();
    const before = snapshot(state);
    const enf = requireUnit(state, "enf");
    enf.shutdown = "manual";
    enf.damage = applyDamage(enf.damage, "centerTorso", 20).after;
    // fall dir 1, loc 3+4; no PSR or seatbelt dice (automatic pilot damage).
    const events: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(1, 3, 4, 2, 2), before, events);
    expect(enf.prone).toBe(true);
    expect(enf.pilotHits).toBe(1);
    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: "pilotingCheck", unitId: "enf", reason: "damage20" }),
    );
  });
});

describe("immediate shutdown PSR (+3)", () => {
  it("heat shutdown rolls +3 PSR; pass stays standing", () => {
    const state = hbkEnf();
    const hbk = requireUnit(state, "hbk");
    // Post-dissipation: 43 - 13 = 30 endHeat (auto shutdown + ammo avoid 8).
    hbk.heat = 43;
    // startAttackTurn: 4 dice (initiative).
    // resolveHeatPhase: 5 dice (traced via debug):
    //   auto shutdown (no roll); PSR 2D6=12 passes (2 dice);
    //   `largestAmmoBin` tiebreak on two equal AC/20 bins (1 die);
    //   ammo avoid 2D6=12 >= 8 passes (2 dice) — no explosion.
    startAttackTurn(state);
    const events: GameEvent[] = [];
    advancePhase(state, events, scriptedRng(6, 6, 6, 6, 6));
    expect(hbk.shutdown).toBe("heat");
    expect(
      events.some(
        (e) => e.kind === "pilotingCheck" && e.unitId === "hbk" && e.reason === "shutdown",
      ),
    ).toBe(true);
    expect(hbk.prone).toBe(false);
  });

  it("heat shutdown rolls +3 PSR; fail drops the 'Mech", () => {
    const state = hbkEnf();
    const hbk = requireUnit(state, "hbk");
    // Post-dissipation: 43 - 13 = 30 endHeat (auto shutdown + ammo avoid 8).
    hbk.heat = 43;
    // resolveHeatPhase: 16 dice (traced via debug):
    //   auto shutdown (no roll); PSR 1+1=2 < 8 fails -> fall:
    //     fallDir=1 (1), fallLoc 3+4=7 (2), consciousness 3+3=6 >= 3 pass (2);
    //   `largestAmmoBin` tiebreak on two equal AC/20 bins (1);
    //   ammo avoid 3+1=4 < 8 explodes; CT destroyed -> auto-eject PSR (6+6 passes);
    //   TW p.160 pilot damage: 2 hits, each forces a Consciousness Roll;
    //   6+6=12 >= 5 (target @ pilotHits=2) and 6+6=12 >= 7 (target @ pilotHits=3).
    startAttackTurn(state);
    advancePhase(state, [], scriptedRng(1, 1, 1, 3, 4, 3, 3, 3, 1, 6, 6, 6, 6, 6, 6, 6));
    expect(hbk.prone).toBe(true);
    expect(hbk.pilotHits).toBe(3);
    expect(hbk.unconscious).toBe(false);
  });
});

describe("run-damaged PSR", () => {
  it("PSR fires at end of move when running with a damaged hip", () => {
    // hbkEnf: ENF at (2,3) facing "n". North forward: (2,2) occupied by hbk.
    // Use custom setup: ENF at (2,4) facing "n", hbk at (8,8) out of the way.
    const state = createTestBattle(
      [],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 8, row: 8 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 4 }, "n"),
      ],
      true,
    );
    toMovement(state);
    const enf = requireUnit(state, "enf");
    const hipSlots = structureSlots(state, "enf", "rightLeg", "hip");
    expect(hipSlots.length).toBeGreaterThanOrEqual(1);
    setSlotDestroyed(enf.critSlotsDestroyed, "rightLeg", hipSlots[0]!);
    // North forward: (2,3), then (2,2). PSR 5+2=7, 2D6=8 passes.
    const events: GameEvent[] = [];
    executeMove(
      state,
      "enf",
      "run",
      [
        { kind: "enter", to: { col: 2, row: 3 } },
        { kind: "enter", to: { col: 2, row: 2 } },
      ],
      events,
      { rng: scriptedRng(4, 4) },
    );
    expect(
      events.some(
        (e) => e.kind === "pilotingCheck" && e.unitId === "enf" && e.reason === "runDamaged",
      ),
    ).toBe(true);
    expect(enf.prone).toBe(false);
  });

  it("PSR fail drops the unit", () => {
    const state = createTestBattle(
      [],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 8, row: 8 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 4 }, "n"),
      ],
      true,
    );
    toMovement(state);
    const enf = requireUnit(state, "enf");
    const hipSlots = structureSlots(state, "enf", "rightLeg", "hip");
    setSlotDestroyed(enf.critSlotsDestroyed, "rightLeg", hipSlots[0]!);
    // PSR 2D6=2<7 fails; fall dir 1, loc 3+4 CT; seatbelt 5+2=7, 2D6=2 fails.
    // Consciousness 2D6=6>=3 pass.
    executeMove(state, "enf", "run", [{ kind: "enter", to: { col: 2, row: 3 } }], [], {
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
        buildUnitInit("hbk", "HBK-4G", 1, { col: 8, row: 8 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 4 }, "n"),
      ],
      true,
    );
    toMovement(state);
    const enf = requireUnit(state, "enf");
    const footSlots = structureSlots(state, "enf", "rightLeg", "footActuator");
    expect(footSlots.length).toBeGreaterThanOrEqual(1);
    setSlotDestroyed(enf.critSlotsDestroyed, "rightLeg", footSlots[0]!);
    // PSR 5+1=6, 2D6=6 passes.
    const events: GameEvent[] = [];
    executeMove(state, "enf", "jump", [{ kind: "enter", to: { col: 2, row: 3 } }], events, {
      rng: scriptedRng(3, 3),
    });
    expect(
      events.some(
        (e) => e.kind === "pilotingCheck" && e.unitId === "enf" && e.reason === "jumpDamaged",
      ),
    ).toBe(true);
    expect(enf.prone).toBe(false);
  });

  it("PSR fail drops the unit", () => {
    const state = createTestBattle(
      [],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 8, row: 8 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 4 }, "n"),
      ],
      true,
    );
    toMovement(state);
    const enf = requireUnit(state, "enf");
    const footSlots = structureSlots(state, "enf", "rightLeg", "footActuator");
    setSlotDestroyed(enf.critSlotsDestroyed, "rightLeg", footSlots[0]!);
    // PSR 2D6=2<6 fails; fall dir 1, loc 3+4 CT; seatbelt 5+1=6, 2D6=2 fails.
    // Consciousness 2D6=6>=3 pass.
    executeMove(state, "enf", "jump", [{ kind: "enter", to: { col: 2, row: 3 } }], [], {
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
        buildUnitInit("hbk", "HBK-4G", 1, { col: 8, row: 8 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 4 }, "n"),
      ],
      true,
    );
    toMovement(state);
    const enf = requireUnit(state, "enf");
    enf.damage.armor.rightLeg = 0;
    enf.damage.internalStructure.rightLeg = 1;
    // Building entry PSR 5+2=7, 2D6=2<7 fails → crash.
    // Crash: ceil(90/10)=9 damage → 2 groups (5+4). Each needs loc roll.
    // Group1 loc 1+4=5 rightLeg, group2 loc 1+3=4 rightArm.
    // Auto-fall (leg destroyed); seatbelt PSR 5+5=10, 2D6=4+5=9 fails.
    // Fall dir 1, loc 3+4=7 CT. Consciousness 2D6=6+6=12 pass.
    executeMove(state, "enf", "walk", [{ kind: "enter", to: { col: 2, row: 3 } }], [], {
      rng: scriptedRng(1, 1, 1, 4, 1, 3, 1, 3, 4, 4, 5, 6, 6),
    });
    expect(enf.prone).toBe(true);
    expect(enf.pilotHits).toBe(1);
  });

  it("crash seatbelt fail injures the pilot", () => {
    const state = createTestBattle(
      [{ col: 2, row: 3, type: "heavyBuilding" }],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 8, row: 8 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 4 }, "n"),
      ],
      true,
    );
    toMovement(state);
    const enf = requireUnit(state, "enf");
    enf.damage.armor.rightLeg = 0;
    enf.damage.internalStructure.rightLeg = 1;
    // Building entry PSR 5+2=7, 2D6=2<7 fails → crash.
    // Crash 9 dmg → 2 groups (5+4). Loc: 5 rightLeg, 4 rightArm.
    // Auto-fall (leg destroyed); seatbelt PSR 5+5=10, 2D6=4+5=9 fails.
    // Fall dir 1, loc 3+4=7 CT. Consciousness 2D6=1+1=2<3 fail.
    executeMove(state, "enf", "walk", [{ kind: "enter", to: { col: 2, row: 3 } }], [], {
      rng: scriptedRng(1, 1, 1, 4, 1, 3, 1, 3, 4, 4, 5, 1, 1),
    });
    expect(enf.prone).toBe(true);
    expect(enf.pilotHits).toBe(1);
    expect(enf.unconscious).toBe(true);
  });

  it("crash that does not destroy the leg does not trigger auto-fall", () => {
    const state = createTestBattle(
      [{ col: 2, row: 3, type: "heavyBuilding" }],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 8, row: 8 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 4 }, "n"),
      ],
      true,
    );
    toMovement(state);
    const enf = requireUnit(state, "enf");
    // Building entry PSR 7 pass. Crash: 2 damage front column,
    // loc 7 CT. CT has 10 armor, no IS loss.
    executeMove(state, "enf", "walk", [{ kind: "enter", to: { col: 2, row: 3 } }], [], {
      rng: scriptedRng(1, 2, 2, 3, 3, 3, 3),
    });
    expect(enf.prone).toBe(false);
    expect(enf.unconscious).toBe(false);
  });
});

describe("standing up", () => {
  it("success stands the 'Mech (counts as walking)", () => {
    const state = hbkEnf();
    toMovement(state);
    const enf = requireUnit(state, "enf");
    enf.prone = true;
    const events: GameEvent[] = [];
    attemptStandUp(state, "enf", events, scriptedRng(3, 3));
    expect(enf.prone).toBe(false);
    expect(enf.moveMode).toBe("walk");
    expect(events).toContainEqual(
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
    const enf = requireUnit(state, "enf");
    enf.prone = true;
    // stand 1+1 (fail), fall dir 4 (rear, +3), loc 3+3, seatbelt 1+2 (fail),
    // consciousness 2+2 (needs 3: awake).
    attemptStandUp(state, "enf", [], scriptedRng(1, 1, 4, 3, 3, 1, 2, 2, 2));
    expect(enf.prone).toBe(true);
    expect(enf.facing).toBe("s"); // n rotated +3 hexsides
    expect(enf.pilotHits).toBe(1);
  });

  it("refuses without a working gyro or any intact leg", () => {
    const state = hbkEnf();
    toMovement(state);
    const enf = requireUnit(state, "enf");
    enf.prone = true;
    for (const i of structureSlots(state, "enf", "centerTorso", "gyro")) {
      setSlotDestroyed(enf.critSlotsDestroyed, "centerTorso", i);
    }
    expect(() => attemptStandUp(state, "enf", [])).toThrow(/destroyed gyro/);
    for (const i of structureSlots(state, "enf", "centerTorso", "gyro")) {
      enf.critSlotsDestroyed.centerTorso &= ~(1 << i);
    }
    enf.damage.internalStructure.rightLeg = 0;
    enf.damage.internalStructure.leftLeg = 0;
    expect(() => attemptStandUp(state, "enf", [])).toThrow(/cannot stand up/);
  });
});

describe("going prone voluntarily", () => {
  it("dropProne costs no heat, needs no roll, deals no damage (TW p.49)", () => {
    const state = hbkEnf();
    toMovement(state);
    const before = requireUnit(state, "enf");
    const armorBefore = { ...before.damage.armor };
    const structBefore = { ...before.damage.internalStructure };
    const facingBefore = before.facing;
    const events: GameEvent[] = [];
    dropProne(state, "enf", events, scriptedRng(3, 4));
    const enf = requireUnit(state, "enf");
    expect(enf.prone).toBe(true);
    expect(enf.heat).toBe(0);
    expect(enf.facing).toBe(facingBefore);
    expect(enf.pilotHits).toBe(0);
    expect(enf.damage.armor).toEqual(armorBefore);
    expect(enf.damage.internalStructure).toEqual(structBefore);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "unitFell",
        unitId: "enf",
        cause: { kind: "voluntaryDrop" },
        column: "front",
        totalDamage: 0,
        groups: [],
        crits: [],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "moved",
        unitId: "enf",
        mode: "prone",
        prevMode: "standStill",
        mpSpent: 1,
      }),
    );
    expect(events.some((e) => e.kind === "heatMove")).toBe(false);
  });

  it("a voluntary drop underwater deals no damage either (TW p.49: no falling damage)", () => {
    const state = createTestBattle(
      [{ col: 2, row: 3, type: "water2" }],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 2, row: 3 }, "n"),
      ],
      true,
    );
    toMovement(state);
    const before = requireUnit(state, "enf");
    const armorBefore = { ...before.damage.armor };
    const events: GameEvent[] = [];
    dropProne(state, "enf", events, scriptedRng(3, 4));
    const enf = requireUnit(state, "enf");
    expect(enf.prone).toBe(true);
    expect(enf.heat).toBe(0);
    // TW p.49: dropping causes no falling damage on any terrain.
    expect(enf.damage.armor).toEqual(armorBefore);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "unitFell", unitId: "enf", totalDamage: 0 }),
    );
  });

  it("dropProne is refused in a turn the 'Mech jumped (TW p.49)", () => {
    const state = hbkEnf();
    toMovement(state);
    requireUnit(state, "enf").jumpedThisTurn = true;
    expect(() => dropProne(state, "enf", [], scriptedRng(3, 4))).toThrow(/jumped/);
    expect(requireUnit(state, "enf").prone).toBe(false);
  });

  it("undamaged prone 'Mech: 1 MP per hexside via walk turn steps", () => {
    const state = hbkEnf();
    toMovement(state);
    const enf = requireUnit(state, "enf");
    enf.prone = true;
    const events: GameEvent[] = [];
    executeMove(state, "enf", "walk", [{ kind: "turn", facings: 2 }], events);
    expect(enf.facing).toBe("se");
    expect(enf.mpSpent).toBe(2);
    expect(enf.heat).toBe(0);
    expect(enf.heatPending).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ kind: "moved", mpSpent: 2 }));
  });

  it("prone turn rejects bad facings", () => {
    const zero = hbkEnf();
    toMovement(zero);
    requireUnit(zero, "enf").prone = true;
    expect(() => executeMove(zero, "enf", "walk", [{ kind: "turn", facings: 0 }], [])).toThrow(
      /1\.\.5 hexsides/,
    );
    const over = hbkEnf();
    toMovement(over);
    requireUnit(over, "enf").prone = true;
    expect(() => executeMove(over, "enf", "walk", [{ kind: "turn", facings: 6 }], [])).toThrow(
      /1\.\.5 hexsides/,
    );
  });

  it("prone 'Mech with one leg destroyed: walk budget 1 so only a 1-hexside turn", () => {
    const state = hbkEnf();
    toMovement(state);
    const enf = requireUnit(state, "enf");
    enf.prone = true;
    enf.damage.internalStructure.rightLeg = 0;
    executeMove(state, "enf", "walk", [{ kind: "turn", facings: 1 }], []);
    expect(enf.facing).toBe("ne");
    const over = hbkEnf();
    toMovement(over);
    requireUnit(over, "enf").prone = true;
    requireUnit(over, "enf").damage.internalStructure.rightLeg = 0;
    expect(() => executeMove(over, "enf", "walk", [{ kind: "turn", facings: 2 }], [])).toThrow(
      /Move costs 2 MP but walk budget is 1/,
    );
  });

  it("prone 'Mech with both legs destroyed: cannot turn (zero budget)", () => {
    const state = hbkEnf();
    toMovement(state);
    const enf = requireUnit(state, "enf");
    enf.prone = true;
    enf.damage.internalStructure.rightLeg = 0;
    enf.damage.internalStructure.leftLeg = 0;
    expect(() => executeMove(state, "enf", "walk", [{ kind: "turn", facings: 1 }], [])).toThrow(
      /Move costs 1 MP but walk budget is 0/,
    );
  });
});

describe("prone combat", () => {
  it("rejects mixed-arm volleys and infers the propping arm", () => {
    const state = hbkEnf();
    toAttack(state, scriptedRng(2, 2, 5, 5));
    const hbk = requireUnit(state, "hbk");
    hbk.prone = true;
    // HBK-4G: 1 ML leftArm, 2 ML rightArm, 3 SL head.
    expect(() =>
      declareAttacks(
        state,
        "hbk",
        [
          { weaponIndex: 1, targetId: "enf" },
          { weaponIndex: 2, targetId: "enf" },
        ],
        [],
        [],
      ),
    ).toThrow(/both arms/);
  });

  it("accepts single-arm volleys and records prone + propArm on resolution", () => {
    const state = hbkEnf();
    toAttack(state, scriptedRng(2, 2, 5, 5));
    const hbk = requireUnit(state, "hbk");
    hbk.prone = true;
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], []);
    expect(hbk.declaredWeaponAttacks).toHaveLength(1);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(1, 1), events);
    const res = events.find((e) => e.kind === "attackResolved") as
      | { resolution: { prone: boolean; propArm: string | null } }
      | undefined;
    expect(res?.resolution.prone).toBe(true);
    expect(res?.resolution.propArm).toBe("rightArm");
  });

  it("shows prop-left and prop-right weapon sets while prone", () => {
    const state = hbkEnf();
    toAttack(state, scriptedRng(2, 2, 5, 5));
    requireUnit(state, "hbk").prone = true;
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
    toAttack(state, scriptedRng(2, 2, 5, 5));
    const hbk = requireUnit(state, "hbk");
    const base = suggestFireTargets(state, "hbk").targets[0]!.weapons[0]!.tn;
    hbk.prone = true;
    const proneAttack = suggestFireTargets(state, "hbk").targets[0]!.weapons[0]!.tn;
    expect(proneAttack - base).toBe(2);
    hbk.prone = false;
    requireUnit(state, "enf").prone = true;
    const proneTarget = suggestFireTargets(state, "hbk").targets[0]!.weapons[0]!.tn;
    expect(proneTarget - base).toBe(-2);
  });

  it("adds +2 on the first destroyed sensor and blinds on the second", () => {
    const state = hbkEnf();
    toAttack(state, scriptedRng(2, 2, 5, 5));
    const base = suggestFireTargets(state, "hbk").targets[0]!.weapons[0]!.tn;
    const hbk = requireUnit(state, "hbk");
    const sensors = structureSlots(state, "hbk", "head", "sensors");
    expect(sensors).toHaveLength(2);
    setSlotDestroyed(hbk.critSlotsDestroyed, "head", sensors[0]!);
    const one = suggestFireTargets(state, "hbk").targets[0]!.weapons[0]!.tn;
    expect(one - base).toBe(2);
    setSlotDestroyed(hbk.critSlotsDestroyed, "head", sensors[1]!);
    const blind = suggestFireTargets(state, "hbk").targets[0]!;
    expect(blind.weapons).toHaveLength(0);
    expect(blind.blocked.length).toBeGreaterThan(0);
    for (const b of blind.blocked) expect(b.reason).toBe("noSensor");
    expect(() =>
      declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], []),
    ).toThrow(/sensors/);
  });
});

describe("pilot damage", () => {
  it("a head hit lands 1 point with a consciousness roll", () => {
    const state = hbkEnf();
    toAttack(state, scriptedRng(2, 2, 5, 5));
    // ML to-hit 3+3, location 6+6 (head), consciousness 2+2 (needs 3: awake).
    declareAttacks(state, "hbk", [{ weaponIndex: 1, targetId: "enf" }], [], []);
    const events: GameEvent[] = [];
    resolveAllAttacks(state, scriptedRng(3, 3, 6, 6, 2, 2), events);
    expect(requireUnit(state, "enf").pilotHits).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "pilotDamaged", unitId: "enf", reason: "headHit" }),
    );
  });

  it("a prone unit whose pilot is killed leaves a level-1 wreck (TO)", () => {
    const state = hbkEnf();
    const enf = requireUnit(state, "enf");
    enf.prone = true;
    // consciousness TN 3/5/7/10/11: all succeed for the first five hits.
    applyPilotHits(state, enf, 5, "headHit", scriptedRng(2, 2, 3, 3, 4, 4, 5, 5, 6, 6), []);
    applyPilotHits(state, enf, 1, "fall", scriptedRng(), []);
    expect(enf.prone).toBe(true);
    expect(enf.removed).toBe("pilotKilled");
    expect(state.wrecks["2,3"]).toEqual({ unitId: "enf", level: 1 });
  });

  it("the sixth hit kills the pilot, removes the unit, and leaves a level-2 wreck", () => {
    const state = hbkEnf();
    const enf = requireUnit(state, "enf");
    // consciousness TN 3/5/7/10/11: all succeed.
    applyPilotHits(state, enf, 5, "headHit", scriptedRng(2, 2, 3, 3, 4, 4, 5, 5, 6, 6), []);
    expect(enf.pilotHits).toBe(5);
    expect(enf.destroyed).toBe("not");
    expect(state.wrecks["2,3"]).toBeUndefined();
    const events: GameEvent[] = [];
    applyPilotHits(state, enf, 1, "fall", scriptedRng(), events);
    expect(enf.pilotHits).toBe(6);
    expect(enf.destroyed).toBe("not");
    expect(enf.removed).toBe("pilotKilled");
    expect(state.wrecks["2,3"]).toEqual({ unitId: "enf", level: 2 });
    expect(wreckAt(state, { col: 2, row: 3 })?.unitId).toBe("enf");
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "unitRemoved", unitId: "enf", reason: "pilotKilled" }),
    );
  });

  it("multi-hit damage emits one pilotDamaged and one consciousnessCheck", () => {
    const state = hbkEnf();
    const enf = requireUnit(state, "enf");
    const events: GameEvent[] = [];
    // TN 3 then 5: both pass.
    applyPilotHits(state, enf, 2, "ammoExplosion", scriptedRng(2, 2, 3, 3), events);
    expect(events).toEqual([
      expect.objectContaining({ kind: "pilotDamaged", hits: 2, totalHits: 2, hpRemaining: 4 }),
      expect.objectContaining({
        kind: "consciousnessCheck",
        cause: "ammoExplosion",
        rolls: [
          { roll: 4, target: 3, hits: 1 },
          { roll: 6, target: 5, hits: 2 },
        ],
        required: 2,
        failedAt: null,
        success: true,
        consciousBefore: true,
      }),
    ]);
  });

  it("a failed roll stops further rolls and reports n of m", () => {
    const state = hbkEnf();
    const enf = requireUnit(state, "enf");
    const events: GameEvent[] = [];
    // TN 3: 1+1 fails; the second point needs no roll.
    applyPilotHits(state, enf, 2, "ammoExplosion", scriptedRng(1, 1), events);
    expect(enf.pilotHits).toBe(2);
    expect(enf.unconscious).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({ kind: "pilotDamaged", hits: 2 }),
      expect.objectContaining({
        kind: "consciousnessCheck",
        rolls: [{ roll: 2, target: 3, hits: 1 }],
        required: 2,
        failedAt: 1,
        success: false,
      }),
    ]);
  });

  it("an already unconscious pilot takes damage without a check", () => {
    const state = hbkEnf();
    const enf = requireUnit(state, "enf");
    applyPilotHits(state, enf, 1, "fall", scriptedRng(1, 1), []);
    const events: GameEvent[] = [];
    applyPilotHits(state, enf, 2, "ammoExplosion", scriptedRng(), events);
    expect(events).toEqual([
      expect.objectContaining({ kind: "pilotDamaged", hits: 2, totalHits: 3 }),
    ]);
  });

  it("a killing point is applied without a roll and caps the hit count", () => {
    const state = hbkEnf();
    const enf = requireUnit(state, "enf");
    applyPilotHits(state, enf, 5, "headHit", scriptedRng(2, 2, 3, 3, 4, 4, 5, 5, 6, 6), []);
    const events: GameEvent[] = [];
    applyPilotHits(state, enf, 2, "ammoExplosion", scriptedRng(), events);
    expect(events[0]).toMatchObject({ kind: "pilotDamaged", hits: 1, totalHits: 6 });
    expect(events.some((e) => e.kind === "consciousnessCheck")).toBe(false);
    expect(enf.removed).toBe("pilotKilled");
  });

  it("the recovery roll carries cause 'recovery'", () => {
    const state = hbkEnf();
    const enf = requireUnit(state, "enf");
    applyPilotHits(state, enf, 1, "fall", scriptedRng(1, 1), []);
    state.turn += 1;
    const events: GameEvent[] = [];
    // TN 3 for 1 hit: 2+2 wakes the pilot.
    resolveHeatPhase(state, scriptedRng(2, 2), events);
    expect(enf.unconscious).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "consciousnessCheck",
        unitId: "enf",
        cause: "recovery",
        rolls: [{ roll: 4, target: 3, hits: 1 }],
        required: 1,
        failedAt: null,
        consciousBefore: false,
      }),
    );
  });

  it("knockout skips the unit in the actor queue as immobile", () => {
    const state = hbkEnf();
    toMovement(state, scriptedRng(2, 2, 5, 5));
    const enf = requireUnit(state, "enf");
    applyPilotHits(state, enf, 1, "fall", scriptedRng(1, 1), []);
    expect(enf.unconscious).toBe(true);
    expect(isImmobile(enf)).toBe(true);
    expect(nextActor(state)).toBe("hbk");
  });

  it("life support plus heat injures the pilot in the heat phase", () => {
    const state = hbkEnf();
    const hbk = requireUnit(state, "hbk");
    const def = mechDefFor(hbk);
    let marked = false;
    def.critSlots.head.forEach((slot: ResolvedCritSlot | undefined, i: number) => {
      if (slot?.kind === "structure" && slot.name === "lifeSupport") {
        setSlotDestroyed(hbk.critSlotsDestroyed, "head", i);
        marked = true;
      }
    });
    expect(marked).toBe(true);
    hbk.heat = 29;
    // shutdown avoid (needs 10+: 5+6), `largestAmmoBin` tiebreak (1),
    // ammo avoid (needs 8+: 4+4), dissipation leaves 16 (heat 29 - 13 sinks),
    // life support 1 hit, consciousness (needs 3: 2+2).
    const events: GameEvent[] = [];
    resolveHeatPhase(state, scriptedRng(5, 6, 6, 4, 4, 2, 2), events);
    expect(hbk.pilotHits).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "pilotDamaged", unitId: "hbk", reason: "lifeSupport" }),
    );
  });
});

describe("movement terrain PSRs", () => {
  it("a failed rubble roll falls the 'Mech in the entered hex", () => {
    const state = createTestBattle(
      [{ col: 2, row: 3, type: "rubble" }],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 3 }, "n"),
      ],
      true,
    );
    toMovement(state, scriptedRng(2, 2, 5, 5));
    // PSR 1+2 (needs 5: fail), fall dir 2, loc 3+3, seatbelt 3+3 (success).
    executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 2, row: 3 } }], [], {
      rng: scriptedRng(1, 2, 2, 3, 3, 3, 3),
    });
    const hbk = requireUnit(state, "hbk");
    expect(hbk.position).toEqual({ col: 2, row: 3 });
    expect(hbk.prone).toBe(true);
  });

  it("a passed water1 roll (-1) keeps the 'Mech up", () => {
    const state = createTestBattle(
      [{ col: 2, row: 3, type: "water1" }],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 3 }, "n"),
      ],
      true,
    );
    toMovement(state, scriptedRng(2, 2, 5, 5));
    // needs 4: 2+2 succeeds.
    executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 2, row: 3 } }], [], {
      rng: scriptedRng(2, 2),
    });
    const hbk = requireUnit(state, "hbk");
    expect(hbk.position).toEqual({ col: 2, row: 3 });
    expect(hbk.prone).toBe(false);
  });

  it("exiting a building hex requires no PSR (TW p.170)", () => {
    const state = createTestBattle(
      [
        { col: 2, row: 3, type: "lightBuilding" },
        { col: 2, row: 4, type: "clear" },
      ],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 3 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 8, row: 8 }, "n"),
      ],
      true,
    );
    toMovement(state, scriptedRng(2, 2, 5, 5));
    // Roll 2+2 would auto-fail any building PSR (target 5). If the engine
    // mistakenly rolls on exit, a `pilotingCheck` reason:"building" event
    // would be emitted; this test pins that off.
    const events: GameEvent[] = [];
    executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 2, row: 4 } }], events, {
      rng: scriptedRng(2, 2),
    });
    const hbk = requireUnit(state, "hbk");
    expect(hbk.position).toEqual({ col: 2, row: 4 });
    expect(hbk.prone).toBe(false);
    expect(events.some((e) => e.kind === "pilotingCheck" && e.reason === "building")).toBe(false);
    expect(events.some((e) => e.kind === "buildingCrash")).toBe(false);
    expect(events.some((e) => e.kind === "unitFell")).toBe(false);
  });

  it("a failed building entry crashes without falling", () => {
    const state = createTestBattle(
      [{ col: 2, row: 3, type: "lightBuilding" }],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 3 }, "n"),
      ],
      true,
    );
    toMovement(state, scriptedRng(2, 2, 5, 5));
    // PSR 1+2 (needs 5: fail), crash loc 3+3, ceil(15/10) = 2 damage.
    const crashEvents: GameEvent[] = [];
    executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 2, row: 3 } }], crashEvents, {
      rng: scriptedRng(1, 2, 3, 3),
    });
    const hbk = requireUnit(state, "hbk");
    expect(hbk.prone).toBe(false);
    expect(crashEvents).toContainEqual(
      expect.objectContaining({ kind: "buildingCrash", unitId: "hbk", totalDamage: 2 }),
    );
  });

  it("a downhill fall drops into the lower hex with levels-fallen damage", () => {
    const state = createTestBattle(
      [
        { col: 2, row: 2, type: "clear", level: 2 },
        { col: 2, row: 3, type: "rubble", level: 0 },
      ],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 3 }, "n"),
      ],
      true,
    );
    toMovement(state, scriptedRng(2, 2, 5, 5));
    // PSR 1+2 (needs 5: fail), fall dir 1 (front), three loc rolls 3+3 (CT)
    // for ceil(50/10) x (2+1) = 15 damage, seatbelt needs 6 (0 mods + 1 for
    // the second level fallen): 1+2 fails, consciousness needs 3: 2+2 awake.
    const events: GameEvent[] = [];
    executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 2, row: 3 } }], events, {
      rng: scriptedRng(1, 2, 1, 3, 3, 3, 3, 3, 3, 1, 2, 2, 2),
    });
    const hbk = requireUnit(state, "hbk");
    expect(hbk.position).toEqual({ col: 2, row: 3 });
    expect(hbk.prone).toBe(true);
    expect(hbk.pilotHits).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "unitFell",
        unitId: "hbk",
        levelsFallen: 2,
        totalDamage: 15,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "pilotingCheck",
        reason: "seatbelt",
        basePiloting: 5,
        triggerModifier: 1,
        preexistingModifier: 0,
      }),
    );
  });

  it("an uphill fall drops back into the lower hex at 0 levels", () => {
    const state = createTestBattle(
      [{ col: 2, row: 3, type: "rubble", level: 2 }],
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 3 }, "n"),
      ],
      true,
    );
    toMovement(state, scriptedRng(2, 2, 5, 5));
    // PSR 1+2 (needs 5: fail), fall dir 1 (front), loc 3+3 (CT) for
    // ceil(50/10) x (0+1) = 5 damage, seatbelt needs 5: 3+3 succeeds.
    const events: GameEvent[] = [];
    executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 2, row: 3 } }], events, {
      rng: scriptedRng(1, 2, 1, 3, 3, 3, 3),
    });
    const hbk = requireUnit(state, "hbk");
    expect(hbk.position).toEqual({ col: 2, row: 2 });
    expect(hbk.prone).toBe(true);
    expect(hbk.pilotHits).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "unitFell",
        unitId: "hbk",
        levelsFallen: 0,
        totalDamage: 5,
      }),
    );
  });

  it("a jump-landing fall into water1 falls depth levels, halved (TW p.53)", () => {
    const state = createTestBattle(
      [
        { col: 2, row: 2, type: "clear", level: 2 },
        { col: 2, row: 3, type: "water1", level: 0 },
      ],
      [
        buildUnitInit("enf", "ENF-4R", 1, { col: 2, row: 2 }, "s"),
        buildUnitInit("hbk", "HBK-4G", 2, { col: 1, row: 1 }, "s"),
      ],
      true,
    );
    toMovement(state, scriptedRng(2, 2, 5, 5));
    // Water1 PSR needs 4 (5-1): 1+2 fails; dir 1 (front), loc 3+3 (CT) for
    // jump landing tumbles to the bottom (TW p.53): depth 1 level fallen,
    // ceil(50/10) x (1+1) = 10 halved to 5; seatbelt needs 4: 3+3 succeeds.
    const events: GameEvent[] = [];
    executeMove(state, "enf", "jump", [{ kind: "enter", to: { col: 2, row: 3 } }], events, {
      rng: scriptedRng(1, 2, 1, 3, 3, 3, 3),
    });
    const enf = requireUnit(state, "enf");
    expect(enf.position).toEqual({ col: 2, row: 3 });
    expect(enf.prone).toBe(true);
    expect(enf.pilotHits).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "unitFell",
        unitId: "enf",
        levelsFallen: 1,
        totalDamage: 5,
      }),
    );
  });
});

describe("applyFall", () => {
  it("is a no-op on an already-prone unit", () => {
    const state = hbkEnf();
    const enf = requireUnit(state, "enf");
    enf.prone = true;
    const noEvents: GameEvent[] = [];
    applyFall(
      state,
      enf,
      scriptedRng(),
      {
        cause: { kind: "terrain", terrain: "water" },
        seatbeltModifier: 0,
        halved: false,
      },
      noEvents,
    );
    expect(noEvents.some((e) => e.kind === "unitFell")).toBe(false);
  });

  it("halved falls round down (TW errata)", () => {
    const state = hbkEnf();
    const enf = requireUnit(state, "enf");
    // ENF-4R 50t -> 5 damage, halved down to 2. Dir 1 (front), loc 3+3
    // (CT), seatbelt needs 5: 3+3 succeeds.
    const events: GameEvent[] = [];
    applyFall(
      state,
      enf,
      scriptedRng(1, 3, 3, 3, 3),
      {
        cause: { kind: "terrain", terrain: "water" },
        seatbeltModifier: 0,
        halved: true,
      },
      events,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "unitFell",
        unitId: "enf",
        levelsFallen: 0,
        totalDamage: 2,
      }),
    );
  });

  it("scales damage by levels fallen", () => {
    const state = hbkEnf();
    const enf = requireUnit(state, "enf");
    // ENF-4R 50t x (2+1) = 15 damage in three 5-point groups. Dir 1
    // (front), locs 3+3 (CT), seatbelt needs 5 + 1 (second level): 3+4.
    const events: GameEvent[] = [];
    applyFall(
      state,
      enf,
      scriptedRng(1, 3, 3, 3, 3, 3, 3, 3, 4),
      {
        cause: { kind: "failedPsr", reason: "rubble" },
        seatbeltModifier: 1,
        halved: false,
        levelsFallen: 2,
      },
      events,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "unitFell",
        unitId: "enf",
        levelsFallen: 2,
        totalDamage: 15,
      }),
    );
  });
});

describe("rollFallDirection", () => {
  it("maps 5 to two hexsides left and 6 to one (TW p.68)", () => {
    expect(rollFallDirection(scriptedRng(1))).toEqual({ roll: 1, shift: 0, column: "front" });
    expect(rollFallDirection(scriptedRng(4))).toEqual({ roll: 4, shift: 3, column: "rear" });
    expect(rollFallDirection(scriptedRng(5))).toEqual({ roll: 5, shift: -2, column: "leftSide" });
    expect(rollFallDirection(scriptedRng(6))).toEqual({ roll: 6, shift: -1, column: "leftSide" });
  });
});

function slotIndex(modelId: string, loc: Location, name: string): number {
  const layout = mechDef(modelId)!.critSlots[loc];
  const i = layout.findIndex((s) => s.kind === "structure" && s.name === name);
  if (i < 0) throw new Error(`no ${name} in ${modelId} ${loc}`);
  return i;
}

describe("audit fixes: piloting modifiers", () => {
  it("DMG-01: a sheared arm does not count toward the 20-point PSR", () => {
    const state = hbkEnf();
    const enf = requireUnit(state, "enf");
    const before = {
      damage: { enf: cloneDamage(enf.damage) },
      crit: { enf: cloneCritTable(enf.critSlotsDestroyed) },
    };
    // Torso armor already gone before the phase; the phase strips the torso
    // structure and the arm riding off with it.
    enf.damage.armor.leftTorso = 0;
    before.damage.enf = cloneDamage(enf.damage);
    const lt = enf.damage.internalStructure.leftTorso;
    const arm = enf.damage.armor.leftArm + enf.damage.internalStructure.leftArm;
    expect(lt).toBeLessThan(20);
    expect(lt + arm).toBeGreaterThanOrEqual(20);
    enf.damage.internalStructure.leftTorso = 0;
    enf.damage.armor.leftArm = 0;
    enf.damage.internalStructure.leftArm = 0;
    const events: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(6, 6), before, events);
    expect(events.filter((e) => e.kind === "pilotingCheck")).toEqual([]);
  });

  it("PSR-01: the seatbelt roll after a destroyed leg carries the 20-damage modifier", () => {
    const state = hbkEnf();
    const enf = requireUnit(state, "enf");
    const before = {
      damage: { enf: cloneDamage(enf.damage) },
      crit: { enf: cloneCritTable(enf.critSlotsDestroyed) },
    };
    const leg = enf.damage.armor.rightLeg + enf.damage.internalStructure.rightLeg;
    expect(leg).toBeGreaterThanOrEqual(20);
    enf.damage.armor.rightLeg = 0;
    enf.damage.internalStructure.rightLeg = 0;
    const events: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(6, 6, 6, 6, 6, 6, 6), before, events);
    const seat = events
      .filter((e) => e.kind === "pilotingCheck")
      .find((e) => e.reason === "seatbelt");
    expect(seat).toBeDefined();
    // Destroyed leg +5, 20+ damage this phase +1.
    expect(seat!.triggerModifier).toBe(6);
  });

  it("PSR-02: a hip destroyed this phase wipes that leg's earlier actuator modifiers", () => {
    const state = hbkEnf();
    const enf = requireUnit(state, "enf");
    const ula = slotIndex("ENF-4R", "rightLeg", "upperLegActuator");
    const hip = slotIndex("ENF-4R", "rightLeg", "hip");
    setSlotDestroyed(enf.critSlotsDestroyed, "rightLeg", ula);
    const before = {
      damage: { enf: cloneDamage(enf.damage) },
      crit: { enf: cloneCritTable(enf.critSlotsDestroyed) },
    };
    setSlotDestroyed(enf.critSlotsDestroyed, "rightLeg", hip);
    const events: GameEvent[] = [];
    resolvePhasePiloting(state, scriptedRng(6, 6, 6, 6), before, events);
    const hipRoll = events
      .filter((e) => e.kind === "pilotingCheck")
      .find((e) => e.reason === "hip");
    expect(hipRoll).toBeDefined();
    expect(hipRoll!.triggerModifier).toBe(2);
    expect(hipRoll!.preexistingModifier).toBe(0);
  });
});
