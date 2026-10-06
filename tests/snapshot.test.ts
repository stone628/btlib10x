import { describe, expect, it } from "vitest";
import type { HexCell } from "../src/core/types";
import {
  declareAttacks,
  loadBattleState,
  parseBattleState,
  requireUnit,
  saveBattleState,
} from "../src/index";
import type { BattleState, GameEvent, UnitInit } from "../src/rules/game";
import {
  advancePhase,
  buildUnitInit,
  damageBuildingAt,
  resolveAllAttacks,
  rollInitiativePhase,
} from "../src/rules/game";
import {
  loadAmmoState,
  loadBuildings,
  loadCritTable,
  loadDamageState,
  loadUnitState,
  loadWrecks,
  saveAmmoState,
  saveBuildings,
  saveCritTable,
  saveDamageState,
  saveUnitState,
  saveWrecks,
} from "../src/rules/snapshot";
import { createTestBattle, scriptedRng } from "./helpers";

function hbkEnf(critsDisabled: boolean): BattleState {
  const units: UnitInit[] = [
    buildUnitInit("hbk", "HBK-4G", 0, { col: 2, row: 4 }, "se"),
    buildUnitInit("enf", "ENF-4R", 1, { col: 3, row: 5 }, "se"),
  ];
  return createTestBattle([], units, critsDisabled);
}

/** initiative -> weaponAttack with nobody moving. */
function startAttackTurn(state: BattleState): BattleState {
  rollInitiativePhase(state, scriptedRng(1, 1, 4, 4), []);
  advancePhase(state, []);
  return state;
}

/** Rear-CT medium laser hit with crits enabled: exercises damage, crit,
 *  and heat mutation across the snapshot boundary. */
function rearCtHit(state: BattleState): void {
  declareAttacks(state, "hbk", [{ weaponIndex: 2, targetId: "enf" }], [], []);
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
  (state.cells as HexCell[])[0] = { terrain: "heavyWoods", level: 2 };
  const hbk = requireUnit(state, "hbk");
  hbk.position = { col: 5, row: 5 };
  hbk.facing = "n";
  hbk.heat = 9;
  hbk.prone = true;
  hbk.shutdown = "heat";
  hbk.pilotHits = 3;
  hbk.damage.armor.head = 0;
  hbk.critSlotsDestroyed.centerTorso[0] = true;
  hbk.baseCritSlotsDestroyed.centerTorso[0] = true;
  hbk.jammedWeapons.push(0);
  hbk.destroyedWeapons.push(1);
  hbk.movesThisTurn.push("forward");
  for (const bin of Object.values(hbk.ammoBins)) bin.shots = 0;
  delete hbk.ammoBins[Object.keys(hbk.ammoBins)[0]!];
  state.actedThisPhase.push("hbk");
  state.actorQueue = ["stale"];
  state.buildings["9,9"] = { cf: 1, type: "light" };
  delete state.buildings[Object.keys(state.buildings)[0] ?? "never"];
  state.wrecks["1,1"] = { unitId: "hbk", level: 2 };
}

describe("snapshot", () => {
  it("round-trips full battle string after phase change, reusable twice", () => {
    const state = startAttackTurn(hbkEnf(false));
    rearCtHit(state);
    advancePhase(state, []); // weaponAttack -> end: snapshot right after change
    expect(state.phase).toBe("end");
    const snap = saveBattleState(state);
    expect(typeof snap).toBe("string");
    const parsed = JSON.parse(snap) as BattleState;
    // no event log travels with the snapshot
    expect("events" in parsed).toBe(false);

    dirtyBattle(state);
    expect(state).not.toEqual(parsed);
    loadBattleState(state, snap);
    expect(state).toEqual(parsed);

    dirtyBattle(state);
    loadBattleState(state, snap);
    expect(state).toEqual(parsed);
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
    advancePhase(state, []);
    const snap = saveBattleState(state);
    const first = parseBattleState(snap);
    expect(first).toEqual(state);
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
    advancePhase(revived, []);
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
    enf.critSlotsDestroyed.centerTorso[0] = true;

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

  it("buildings/wrecks granularity restores collapse", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 0, { col: 2, row: 4 }, "se"),
      buildUnitInit("enf", "ENF-4R", 1, { col: 3, row: 5 }, "se"),
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

    state.wrecks["2,4"] = { unitId: "hbk", level: 2 };
    const wrecksSnap = saveWrecks(state.wrecks);
    delete state.wrecks["2,4"];
    loadWrecks(state.wrecks, wrecksSnap);
    expect(state.wrecks).toEqual(wrecksSnap);
  });
});
