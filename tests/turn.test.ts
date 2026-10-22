import { describe, expect, it } from "vitest";
import { hexCell } from "../src/core/terrain";
import { mechDef } from "../src/data/index";
import {
  declareAttacks,
  loadBattleState,
  parseBattleState,
  requireUnit,
  saveBattleState,
} from "../src/index";
import { setSlotDestroyed } from "../src/rules/critical";
import {
  abandonPilot,
  actorQueue,
  advancePhase,
  applyPilotHits,
  attemptVoluntaryStartup,
  type BattleState,
  buildUnitInit,
  damageBuildingAt,
  ejectPilot,
  executeMove,
  type GameEvent,
  nextActor,
  passMovement,
  resolveAllAttacks,
  rollInitiativePhase,
  type UnitInit,
  voluntaryShutdown,
} from "../src/rules/game";
import {
  loadAmmoState,
  loadBuildings,
  loadCritTable,
  loadDamageState,
  loadUnitState,
  loadWreckage,
  saveAmmoState,
  saveBuildings,
  saveCritTable,
  saveDamageState,
  saveUnitState,
  saveWreckage,
} from "../src/rules/snapshot";
import { checkVictory, createTestBattle, scriptedRng } from "./helpers";

function hbkEnf(critsDisabled: boolean): BattleState {
  const units: UnitInit[] = [
    buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
    buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 5 }, "se"),
  ];
  return createTestBattle([], units, critsDisabled);
}

/** initiative -> weaponAttack with nobody moving. */
function startAttackTurn(state: BattleState): BattleState {
  rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
  advancePhase(state, [], scriptedRng());
  return state;
}

/** Rear-CT medium laser hit with crits enabled: exercises damage, crit,
 *  and heat mutation across the snapshot boundary. */
function rearCtHit(state: BattleState): void {
  declareAttacks(
    state,
    "hbk",
    [{ weaponIndex: 2, targetId: "enf" }],
    [],
    [],
    scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
  );
  // to-hit 12 hits; location 7 -> CT rear (4 pool, 1 IS stripped -> crit);
  // padded dice cover determining + effect rolls.
  resolveAllAttacks(state, scriptedRng(6, 6, 3, 4, 3, 3, 3, 3, 3, 3, 3, 3), []);
}

/** Dirties every mutable layer of live state. */
function dirtyBattle(state: BattleState): void {
  state.turn = 99;
  state.phase = "movement";
  state.initiativeWinnerTeam = 5;
  state.critsDisabled = !state.critsDisabled;
  state.cells[0] = hexCell("heavyWoods", 2);
  const hbk = requireUnit(state, "hbk");
  hbk.position = { col: 5, row: 5 };
  hbk.facing = "n";
  hbk.heat = 9;
  hbk.prone = true;
  hbk.shutdown = "heat";
  hbk.pilotHits = 3;
  hbk.damage.armor.head = 0;
  setSlotDestroyed(hbk.critSlotsDestroyed, "centerTorso", 0);
  hbk.jammedWeapons.push(0);
  hbk.hexesMovedThisTurn += 1;
  for (const id of Object.keys(hbk.ammoBins)) hbk.ammoBins[id] = 0;
  delete hbk.ammoBins[Object.keys(hbk.ammoBins)[0]!];
  state.actedThisPhase.push("hbk");
  state.actorQueue = ["stale"];
  state.buildings["9,9"] = { cf: 1 };
  delete state.buildings[Object.keys(state.buildings)[0] ?? "never"];
  state.wreckage["1,1"] = [{ model: "HBK-4G", unitId: "hbk" }];
}

describe("snapshot", () => {
  it("round-trips full battle string after phase change, reusable twice", () => {
    const state = startAttackTurn(hbkEnf(false));
    rearCtHit(state);
    advancePhase(state, [], scriptedRng()); // weaponAttack -> end: snapshot right after change
    expect(state.phase).toBe("end");
    const snap = saveBattleState(state);
    expect(typeof snap).toBe("string");
    // no event log travels with the snapshot
    expect("events" in JSON.parse(snap)).toBe(false);
    const parsed = parseBattleState(snap);

    dirtyBattle(state);
    expect(state).not.toEqual(parsed);
    loadBattleState(state, snap);
    expect(state).toEqual(parsed);

    dirtyBattle(state);
    loadBattleState(state, snap);
    expect(state).toEqual(parsed);
  });

  it("stores only cell exceptions and round-trips crits, ammo, limbs, collapsed cells", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 5 }, "se"),
    ];
    const state = createTestBattle(
      [{ col: 3, row: 5, type: "lightBuilding" }],
      units,
      false,
      30,
      30,
    );
    const hbk = requireUnit(state, "hbk");
    setSlotDestroyed(hbk.critSlotsDestroyed, "centerTorso", 2);
    setSlotDestroyed(hbk.critSlotsDestroyed, "leftArm", 0);
    hbk.blownOffLimbs.push({ limb: "rightArm", salvageable: true });
    const [firstBin, secondBin] = Object.keys(hbk.ammoBins);
    hbk.ammoBins[firstBin!]! -= 2;
    delete hbk.ammoBins[secondBin!];
    damageBuildingAt(state, { col: 3, row: 5 }, 999, []);

    const snap = saveBattleState(state);
    const raw = JSON.parse(snap);
    expect(raw.cells).toEqual([[2 + 4 * 30, "rubble", 0]]);
    expect(raw.units.hbk.critSlotsDestroyed.centerTorso).toBe(0b100);
    expect(raw.units.hbk.critSlotsDestroyed.leftArm).toBe(0b1);
    expect(raw.units.hbk.ammoBins[firstBin!]).toBe(hbk.ammoBins[firstBin!]);
    expect(raw.units.hbk.ammoBins).not.toHaveProperty(secondBin!);
    expect(snap.length).toBeLessThan(6000);
    expect(parseBattleState(snap)).toEqual(state);
    expect(saveBattleState(parseBattleState(snap))).toBe(snap);
  });

  it("rejects buildings that disagree with the cells", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 6, row: 6 }, "se"),
    ];
    const state = createTestBattle(
      [
        { col: 3, row: 5, type: "lightBuilding" },
        { col: 4, row: 5, type: "mediumBuilding" },
      ],
      units,
      false,
      10,
      10,
    );
    damageBuildingAt(state, { col: 4, row: 5 }, 999, []);
    const good = JSON.parse(saveBattleState(state));
    expect(good.rubbleOrigin).toEqual({ "4,5": "mediumBuilding" });
    const tamper = (edit: (raw: typeof good) => void): string => {
      const raw = structuredClone(good);
      edit(raw);
      return JSON.stringify(raw);
    };
    const cases: Array<[string, string]> = [
      [tamper((r) => delete r.buildings["3,5"]), "has no building state"],
      [tamper((r) => (r.buildings["1,1"] = { cf: 5 })), "not on a building hex"],
      [tamper((r) => (r.buildings["3,5"] = { cf: 0 })), "has CF 0"],
      [tamper((r) => (r.rubbleOrigin["4,5"] = "heavyWoods")), "not a building terrain"],
      [tamper((r) => (r.rubbleOrigin["1,1"] = "heavyBuilding")), "not on a rubble hex"],
    ];
    for (const [data, message] of cases) {
      expect(() => parseBattleState(data)).toThrow(message);
      const before = saveBattleState(state);
      expect(() => loadBattleState(state, data)).toThrow(message);
      expect(saveBattleState(state)).toBe(before);
    }
  });

  it("save detaches: live mutation never leaks into snapshot string", () => {
    const state = startAttackTurn(hbkEnf(false));
    rearCtHit(state);
    const snap = saveBattleState(state);
    const frozen = snap;
    dirtyBattle(state);
    expect(snap).toBe(frozen);
    expect(saveBattleState(state)).not.toBe(snap);
  });

  it("rejects corrupt snapshot strings without touching live state", () => {
    const state = startAttackTurn(hbkEnf(false));
    rearCtHit(state);
    const before = saveBattleState(state);
    for (const bad of ["nope", "", "[]", "null", '{"turn":1}', '{"turn":1,"phase":"end"}']) {
      expect(() => loadBattleState(state, bad)).toThrow(/Invalid battle snapshot string/);
    }
    expect(saveBattleState(state)).toBe(before);
  });

  it("parseBattleState builds fresh state from string, reusable twice", () => {
    const state = startAttackTurn(hbkEnf(false));
    rearCtHit(state);
    advancePhase(state, [], scriptedRng());
    const snap = saveBattleState(state);
    const first = parseBattleState(snap);
    // The damage window the attacks left behind is never saved.
    expect(first).toEqual({ ...state, currentDealt: undefined });
    expect(first).not.toBe(state);

    dirtyBattle(state);
    expect(state).not.toEqual(first);
    const second = parseBattleState(snap);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("parseBattleState detaches: parsed mutation never leaks into string", () => {
    const state = startAttackTurn(hbkEnf(false));
    rearCtHit(state);
    const snap = saveBattleState(state);
    const revived = parseBattleState(snap);
    requireUnit(revived, "hbk").heat = 11;
    revived.turn = 99;
    expect(saveBattleState(state)).toBe(snap);
    expect(parseBattleState(snap)).not.toEqual(revived);
  });

  it("parseBattleState rejects corrupt strings", () => {
    for (const bad of ["nope", "", "[]", "null", '{"turn":1}', '{"turn":1,"phase":"end"}']) {
      expect(() => parseBattleState(bad)).toThrow(/Invalid battle snapshot string/);
    }
  });

  it("parsed state drives engine APIs", () => {
    const state = startAttackTurn(hbkEnf(false));
    rearCtHit(state);
    const revived = parseBattleState(saveBattleState(state));
    expect(requireUnit(revived, "enf").id).toBe("enf");
    advancePhase(revived, [], scriptedRng());
    expect(revived.phase).toBe("end");
  });

  it("unit save/load preserves sibling + reference", () => {
    const state = startAttackTurn(hbkEnf(false));
    rearCtHit(state);
    const enf = requireUnit(state, "enf");
    const snap = saveUnitState(enf);
    const liveRef = state.units.enf;
    requireUnit(state, "hbk").heat = 7;
    enf.heat = 11;
    enf.position = { col: 6, row: 6 };
    enf.damage.armor.leftArm = 0;
    enf.passedAttacks = true;
    loadUnitState(enf, snap);
    expect(state.units.enf).toBe(liveRef);
    expect(enf).toEqual(snap);
    expect(requireUnit(state, "hbk").heat).toBe(7);
  });

  it("damage/ammo/crit granularity restores stripped bins + flags", () => {
    const state = startAttackTurn(hbkEnf(false));
    const enf = requireUnit(state, "enf");
    const dmgSnap = saveDamageState(enf.damage);
    const ammoSnap = saveAmmoState(enf.ammoBins);
    const critSnap = saveCritTable(enf.critSlotsDestroyed);

    enf.damage.armor.centerTorso = 0;
    enf.damage.internalStructure.leftLeg = 0;
    const firstBin = Object.keys(enf.ammoBins)[0]!;
    delete enf.ammoBins[firstBin];
    setSlotDestroyed(enf.critSlotsDestroyed, "centerTorso", 0);

    loadDamageState(enf.damage, dmgSnap);
    expect(enf.damage).toEqual(dmgSnap);
    loadAmmoState(enf.ammoBins, ammoSnap);
    expect(enf.ammoBins).toEqual(ammoSnap);
    loadCritTable(enf.critSlotsDestroyed, critSnap);
    expect(enf.critSlotsDestroyed).toEqual(critSnap);
  });

  it("rejects pre-removal snapshots carrying an events key", () => {
    const state = startAttackTurn(hbkEnf(false));
    rearCtHit(state);
    const snap = JSON.parse(saveBattleState(state)) as Record<string, unknown>;
    snap.events = [];
    expect(() => loadBattleState(state, JSON.stringify(snap))).toThrow(
      /Invalid battle snapshot string/,
    );
    expect(() => parseBattleState(JSON.stringify(snap))).toThrow(/Invalid battle snapshot string/);
  });

  it("buildings/wreckage granularity restores collapse", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 4 }, "se"),
      buildUnitInit("enf", "ENF-4R", 2, { col: 3, row: 5 }, "se"),
    ];
    const state = createTestBattle([{ col: 3, row: 5, type: "lightBuilding" }], units, false);
    const buildingsSnap = saveBuildings(state.buildings);
    expect(state.buildings["3,5"]).toBeDefined();
    const events: GameEvent[] = [];
    const result = damageBuildingAt(state, { col: 3, row: 5 }, 999, events);
    expect(result?.collapsed).toBe(true);
    expect(events).toHaveLength(1);
    expect(state.buildings["3,5"]).toBeUndefined();
    loadBuildings(state.buildings, buildingsSnap);
    expect(state.buildings).toEqual(buildingsSnap);

    state.wreckage["2,4"] = [{ model: "HBK-4G", unitId: "hbk" }];
    const wreckageSnap = saveWreckage(state.wreckage);
    state.wreckage["2,4"]!.push({ model: "ENF-4R", unitId: "enf" });
    expect(wreckageSnap["2,4"]).toEqual([{ model: "HBK-4G", unitId: "hbk" }]);
    delete state.wreckage["2,4"];
    loadWreckage(state.wreckage, wreckageSnap);
    expect(state.wreckage).toEqual(wreckageSnap);
  });
});

describe("exampleGame", () => {
  /**
   * Full battle reproducing the Total Warfare "Rolling To Hit" diagram (p.106):
   * a Wolverine closes on a Griffin and trades fire through light woods.
   *
   * Dice are fully scripted; every to-hit number below is derived by hand:
   *   T1 Wolverine ML: g4 + run2 + woods1 + long4 = 11
   *   T1 Griffin PPC:  g3 + walk1 + wolverine-moved-0 + woods1 + long4 = 9
   *   T2+ Wolverine ML (both stand): g4 + woods1 + long4 = 9
   */
  function setup(): BattleState {
    const units: UnitInit[] = [
      buildUnitInit("wvr", "WVR-6R", 1, { col: 3, row: 5 }, "se"),
      buildUnitInit("grf", "GRF-1N", 2, { col: 11, row: 8 }, "nw", 3),
    ];
    return createTestBattle([{ col: 7, row: 7, type: "lightWoods" }], units, true);
  }

  describe("example battle: Wolverine vs Griffin", () => {
    it("plays turn 1 exactly as the rulebook diagram describes", () => {
      const state = setup();

      // Initiative: GRF rolls 10 (5+5), WVR rolls 5 (2+3) -> team 2 wins.
      rollInitiativePhase(state, scriptedRng(2, 3, 5, 5), []);
      expect(state.initiativeWinnerTeam).toBe(2);

      // Movement phase: Wolverine runs southeast into (4,5), turns south
      // (1 MP), steps south into (4,6), and squares up southeast (1 MP) -
      // 4 of the 8-MP run budget.
      expect(nextActor(state)).toBe("wvr");
      executeMove(
        state,
        "wvr",
        "run",
        [
          { kind: "enter", to: { col: 4, row: 5 } }, // forward (se)
          { kind: "turn", facings: 1 }, // se -> s
          { kind: "enter", to: { col: 4, row: 6 } }, // forward (s)
          { kind: "turn", facings: -1 }, // s -> se (counterclockwise; target in front arc)
        ],
        [],
        { rng: scriptedRng() },
      );
      const wvr = requireUnit(state, "wvr");
      expect(wvr.position).toEqual({ col: 4, row: 6 });
      expect(wvr.mpSpent).toBe(4);
      // Griffin walks in place (keeps the walked attacker modifier).
      executeMove(state, "grf", "walk", [], [], { rng: scriptedRng() });

      // Weapon phase: Wolverine medium laser at range 7 (long bracket); the
      // light woods between at (7,7) add +1 -> TN 11.
      advancePhase(state, [], scriptedRng()); // movement -> weaponAttack
      declareAttacks(
        state,
        "wvr",
        [{ weaponIndex: 1, targetId: "grf" }],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      );
      // To-hit 11 >= TN 11; location roll 8 -> left torso; ML damage 5. LT 18 -> 13.
      resolveAllAttacks(state, scriptedRng(6, 5, 3, 5), []);
      expect(requireUnit(state, "grf").damage.armor.leftTorso).toBe(
        mechDef("GRF-1N")!.armor.leftTorso! - 5,
      );

      // Griffin answers with its PPC: TN 9, rolls 4 -> miss, no damage.
      declareAttacks(
        state,
        "grf",
        [{ weaponIndex: 2, targetId: "wvr" }],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      );
      const missEvents: GameEvent[] = [];
      resolveAllAttacks(state, scriptedRng(1, 3), missEvents); // miss
      expect(requireUnit(state, "wvr").damage.armor).toEqual(mechDef("WVR-6R")!.armor);
    });

    it("fights through turn 6 until the Griffin loses its center torso", () => {
      const state = setup();
      const grfCt = (): number => requireUnit(state, "grf").damage.armor.centerTorso ?? -1;

      // ---- Turn 1 ----
      rollInitiativePhase(state, scriptedRng(2, 3, 5, 5), []); // wvr loses, moves first
      executeMove(
        state,
        "wvr",
        "run",
        [
          { kind: "enter", to: { col: 4, row: 5 } },
          { kind: "turn", facings: 1 },
          { kind: "enter", to: { col: 4, row: 6 } },
          { kind: "turn", facings: -1 },
        ],
        [],
        { rng: scriptedRng() },
      );
      executeMove(state, "grf", "walk", [], [], { rng: scriptedRng() });
      advancePhase(state, [], scriptedRng());
      declareAttacks(
        state,
        "wvr",
        [{ weaponIndex: 1, targetId: "grf" }],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      );
      const ltEvents: GameEvent[] = [];
      resolveAllAttacks(state, scriptedRng(6, 5, 3, 5), ltEvents); // LT hit
      declareAttacks(
        state,
        "grf",
        [{ weaponIndex: 2, targetId: "wvr" }],
        [],
        [],
        scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
      );
      resolveAllAttacks(state, scriptedRng(1, 3), []); // miss

      // ---- Turns 2..9: both stand still, Wolverine plinks the CT for 5 each.
      // Griffin front CT is 20 -> 4 hits reach 0 armor, then 18 IS needs 4 more
      // hits (3 to drop to 3, final hit to destroy).
      const ctFront = mechDef("GRF-1N")!.armor.centerTorso;
      expect(grfCt()).toBe(ctFront);
      for (let t = 2; t <= 9; t++) {
        advancePhase(state, [], scriptedRng()); // weaponAttack -> end
        advancePhase(state, [], scriptedRng()); // end -> initiative
        expect(state.turn).toBe(t);

        rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []); // wvr loses, moves first
        advancePhase(state, [], scriptedRng()); // -> weaponAttack (both skip moving)
        if (t < 9) {
          declareAttacks(
            state,
            "wvr",
            [{ weaponIndex: 1, targetId: "grf" }],
            [],
            [],
            scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
          );
          // 12 hits TN 9; location 7 -> center torso.
          resolveAllAttacks(state, scriptedRng(6, 6, 3, 4), []);
          const hitsDone = t - 1;
          expect(grfCt()).toBe(Math.max(ctFront - 5 * hitsDone, 0));
          expect(requireUnit(state, "grf").destroyed).toBe("not");
        } else {
          // Final blow: front armor gone, CT IS 3, damage 5 -> structure destroyed.
          declareAttacks(
            state,
            "wvr",
            [{ weaponIndex: 1, targetId: "grf" }],
            [],
            [],
            scriptedRng(1, 1, 1, 1, 1, 1, 1, 1),
          );
          const finalEvents: GameEvent[] = [];
          // Then the salvage fall (TW p.128): direction 1, 55 t = 6 points in
          // two groups (5 + 1), both at 3+3 (right torso).
          resolveAllAttacks(state, scriptedRng(6, 6, 3, 4, 1, 3, 3, 3, 3), finalEvents);
          expect(grfCt()).toBe(0);
          expect(requireUnit(state, "grf").destroyed).toBe("centerTorsoDestroyed"); // killed immediately
          expect(requireUnit(state, "grf").removed).toBe("destroyed");
          expect(finalEvents.filter((e) => e.kind === "unitRemoved")).toHaveLength(1);
        }
      }

      advancePhase(state, [], scriptedRng()); // weaponAttack -> end: kill committed
      expect(requireUnit(state, "grf").destroyed).toBe("centerTorsoDestroyed");
      expect(requireUnit(state, "grf").removed).toBe("destroyed");
      expect(checkVictory(state)).toEqual({ winnerTeam: 1, draw: false });
    });
  });
});

describe("turn-integrity", () => {
  /** Winner = team 2 (rolls 6 against team 1's 2). Order string: L = loser, W = winner. */
  function queueOrder(winners: number, losers: number): string {
    const units: UnitInit[] = [];
    for (let i = 0; i < losers; i++) {
      units.push(buildUnitInit(`l${i}`, "HBK-4G", 1, { col: i + 1, row: 1 }, "s"));
    }
    for (let i = 0; i < winners; i++) {
      units.push(buildUnitInit(`w${i}`, "HBK-4G", 2, { col: i + 1, row: 6 }, "n"));
    }
    const state = createTestBattle([], units, true);
    rollInitiativePhase(state, scriptedRng(1, 1, 3, 3), []);
    expect(state.initiativeWinnerTeam).toBe(2);
    return actorQueue(state)
      .pending.map((v) => (v.id.startsWith("w") ? "W" : "L"))
      .join("");
  }

  describe("unequal-force activation is recounted before every pair (TW p.39, INIT-01)", () => {
    it.each([
      [3, 2, "LWLWW"],
      [5, 3, "LWLWWLWW"],
      [8, 5, "LWLWLWWLWWLWW"],
      [4, 3, "LWLWLWW"],
      [5, 2, "LWWLWWW"],
      [2, 3, "LWLLW"],
      [2, 5, "LLWLLLW"],
      [2, 1, "LWW"],
      [4, 2, "LWWLWW"],
      [1, 1, "LW"],
    ])("%i winners v %i losers -> %s", (w, l, expected) => {
      expect(queueOrder(w as number, l as number)).toBe(expected);
    });
  });

  function hbkVsEnf(terrain: Parameters<typeof createTestBattle>[0] = []): BattleState {
    const state = createTestBattle(
      terrain,
      [
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "s"),
        buildUnitInit("enf", "ENF-4R", 2, { col: 6, row: 6 }, "n"),
      ],
      true,
    );
    rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
    return state;
  }

  describe("a move cut short still ends the activation (TW p.59, MOV-01)", () => {
    it("a fall entering water hands the turn to the next unit", () => {
      const state = hbkVsEnf([{ col: 2, row: 3, type: "water1", level: 0 }]);
      expect(nextActor(state)).toBe("hbk");
      executeMove(state, "hbk", "walk", [{ kind: "enter", to: { col: 2, row: 3 } }], [], {
        rng: scriptedRng(1, 1, 1, 3, 3, 3, 3, 3, 3),
      });
      expect(requireUnit(state, "hbk").prone).toBe(true);
      expect(state.actedThisPhase).toContain("hbk");
      expect(nextActor(state)).toBe("enf");
    });

    it("a failed building roll damages but does not stop the move (TW p.167)", () => {
      const state = hbkVsEnf([{ col: 2, row: 3, type: "lightBuilding", level: 0 }]);
      const events: GameEvent[] = [];
      executeMove(
        state,
        "hbk",
        "walk",
        [
          { kind: "enter", to: { col: 2, row: 3 } },
          { kind: "enter", to: { col: 2, row: 4 } },
        ],
        events,
        { rng: scriptedRng(1, 1, 3, 3, 3, 3) },
      );
      expect(events.some((e) => e.kind === "buildingCrash")).toBe(true);
      expect(requireUnit(state, "hbk").position).toEqual({ col: 2, row: 4 });
      expect(nextActor(state)).toBe("enf");
    });
  });

  describe("heat shutdown restarts only in the Heat Phase (TW p.160, HEAT-01)", () => {
    it("refuses the movement-phase startup for a heat shutdown", () => {
      const state = hbkVsEnf();
      const hbk = requireUnit(state, "hbk");
      hbk.shutdown = "heat";
      hbk.heat = 20;
      expect(() => attemptVoluntaryStartup(state, "hbk", [], scriptedRng())).toThrow(/Heat Phase/);
    });
  });

  describe("pilot hits never exceed the maximum (SALV-04)", () => {
    it("caps at pilotHitMax", () => {
      const state = hbkVsEnf();
      const hbk = requireUnit(state, "hbk");
      hbk.pilotHits = hbk.pilotHitMax - 1;
      applyPilotHits(state, hbk, 3, "fall", scriptedRng(6, 6, 6, 6, 6, 6), []);
      expect(hbk.pilotHits).toBe(hbk.pilotHitMax);
    });
  });

  describe("shutdown, startup, ejection and passes are movement declarations (API-09)", () => {
    it("refuses them out of turn", () => {
      const state = hbkVsEnf();
      expect(nextActor(state)).toBe("hbk");
      expect(() => ejectPilot(state, "enf", scriptedRng(6, 6), [])).toThrow(
        /not the current actor/,
      );
      expect(() => voluntaryShutdown(state, "enf", [])).toThrow(/not the current actor/);
      expect(requireUnit(state, "enf").removed).toBe("not");
      expect(requireUnit(state, "enf").shutdown).toBe("not");
      expect(state.actedThisPhase).toEqual([]);
    });

    it("refuses them for a down unit that is not at the head of the queue", () => {
      const state = hbkVsEnf();
      requireUnit(state, "hbk").shutdown = "manual";
      requireUnit(state, "enf").shutdown = "manual";
      expect(nextActor(state)).toBe("hbk");
      expect(() => attemptVoluntaryStartup(state, "enf", [], scriptedRng())).toThrow(
        /not the current actor/,
      );
      expect(() => passMovement(state, "enf")).toThrow(/not the current actor/);
      expect(() => abandonPilot(state, "enf", [])).toThrow(/not the current actor/);
      expect(state.actedThisPhase).toEqual([]);
    });

    it("allows one declaration per unit: no shutdown or ejection after a move", () => {
      const state = hbkVsEnf();
      executeMove(state, "hbk", "walk", [], [], { rng: scriptedRng() });
      expect(() => voluntaryShutdown(state, "hbk", [])).toThrow(/not the current actor/);
      expect(() => ejectPilot(state, "hbk", scriptedRng(6, 6), [])).toThrow(
        /not the current actor/,
      );
      expect(state.actedThisPhase).toEqual(["hbk"]);
      expect(requireUnit(state, "hbk").shutdown).toBe("not");
    });

    it("gives an unconscious pilot no manual ejection (TW p.42)", () => {
      const state = hbkVsEnf();
      requireUnit(state, "hbk").unconsciousSinceTurn = state.turn;
      expect(() => ejectPilot(state, "hbk", scriptedRng(6, 6), [])).toThrow(
        /not the current actor/,
      );
      expect(requireUnit(state, "hbk").removed).toBe("not");
    });

    it("accepts them from the current actor", () => {
      const state = hbkVsEnf();
      ejectPilot(state, "hbk", scriptedRng(6, 6), []);
      expect(requireUnit(state, "hbk").removed).toBe("pilotEjected");
      expect(nextActor(state)).toBe("enf");
      voluntaryShutdown(state, "enf", []);
      expect(requireUnit(state, "enf").shutdown).toBe("manual");
    });
  });
});
