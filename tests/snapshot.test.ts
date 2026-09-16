import { describe, expect, it } from "vitest";
import type { HexCell } from "../src/core/types.js";
import {
  advancePhase,
  damageBuildingAt,
  declareAttacks,
  loadBattleState,
  requireUnit,
  resolveAllAttacks,
  rollInitiativePhase,
  saveBattleState,
} from "../src/index.js";
import type { BattleState, UnitInit } from "../src/rules/game.js";
import {
  loadAmmoState,
  loadBuildings,
  loadCritTable,
  loadDamageState,
  loadEvents,
  loadUnitState,
  loadWrecks,
  saveAmmoState,
  saveBuildings,
  saveCritTable,
  saveDamageState,
  saveEvents,
  saveUnitState,
  saveWrecks,
} from "../src/rules/snapshot.js";
import { createTestBattle, scriptedRng } from "./helpers.js";

function hbkEnf(critsDisabled: boolean): BattleState {
  const units: UnitInit[] = [
    {
      id: "hbk",
      model: "HBK-4G",
      team: 0,
      gunnery: 4,
      piloting: 5,
      position: { col: 2, row: 4 },
      facing: "se",
    },
    {
      id: "enf",
      model: "ENF-4R",
      team: 1,
      gunnery: 4,
      piloting: 5,
      position: { col: 3, row: 5 },
      facing: "se",
    },
  ];
  return createTestBattle([], units, critsDisabled);
}

/** initiative -> weaponAttack with nobody moving. */
function startAttackTurn(state: BattleState): BattleState {
  rollInitiativePhase(state, scriptedRng(1, 1, 4, 4));
  advancePhase(state);
  return state;
}

/** Rear-CT medium laser hit with crits enabled: exercises nested
 *  resolution clones (application before/after, crit rows, rolls). */
function rearCtHit(state: BattleState): void {
  declareAttacks(state, "hbk", [{ weaponIndex: 2, targetId: "enf" }]);
  // to-hit 12 hits; location 7 -> CT rear (4 pool, 1 IS stripped -> crit);
  // padded dice cover determining + effect rolls.
  resolveAllAttacks(state, scriptedRng(6, 6, 3, 4, 3, 3, 3, 3, 3, 3, 3, 3));
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
  hbk.phaseStartCritSlotsDestroyed.centerTorso[0] = true;
  hbk.jammedWeapons.push(0);
  hbk.destroyedWeapons.push(1);
  hbk.movesThisTurn.push("forward");
  for (const bin of Object.values(hbk.ammoBins)) bin.shots = 0;
  delete hbk.ammoBins[Object.keys(hbk.ammoBins)[0]!];
  state.actedThisPhase.push("hbk");
  state.actorQueue = ["stale"];
  // mutate nested resolution state before clearing log: proves deep detach
  const resolved = state.events.find((e) => e.kind === "attackResolved");
  if (resolved !== undefined && resolved.kind === "attackResolved") {
    for (const g of resolved.resolution.groups as unknown as { damage: number }[]) g.damage = 999;
    const app = resolved.resolution.application as unknown as {
      after: { armor: Record<string, number> };
    } | null;
    if (app !== null) app.after.armor.centerTorso = 999;
    for (const c of resolved.resolution.crits) {
      for (const r of c.rows as unknown as { rolls: number[] }[]) r.rolls.push(6);
    }
  }
  state.events.length = 0;
  state.buildings["9,9"] = { cf: 1, type: "light" };
  delete state.buildings[Object.keys(state.buildings)[0] ?? "never"];
  state.wrecks["1,1"] = { unitId: "hbk", level: 2 };
}

describe("snapshot", () => {
  it("round-trips full battle string after phase change, reusable twice", () => {
    const state = startAttackTurn(hbkEnf(false));
    rearCtHit(state);
    advancePhase(state); // weaponAttack -> end: snapshot right after change
    expect(state.phase).toBe("end");
    const snap = saveBattleState(state);
    expect(typeof snap).toBe("string");
    const parsed = JSON.parse(snap) as BattleState;
    // nested resolution clones exist
    expect(parsed.events.some((e) => e.kind === "attackResolved")).toBe(true);

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

  it("buildings/wrecks/events granularity restores collapse + log", () => {
    const units: UnitInit[] = [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 4 },
        facing: "se",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 3, row: 5 },
        facing: "se",
      },
    ];
    const state = createTestBattle([{ col: 3, row: 5, type: "lightBuilding" }], units, false);
    const buildingsSnap = saveBuildings(state.buildings);
    expect(state.buildings["3,5"]).toBeDefined();
    damageBuildingAt(state, { col: 3, row: 5 }, 999);
    expect(state.buildings["3,5"]).toBeUndefined();
    loadBuildings(state.buildings, buildingsSnap);
    expect(state.buildings).toEqual(buildingsSnap);

    state.wrecks["2,4"] = { unitId: "hbk", level: 2 };
    const wrecksSnap = saveWrecks(state.wrecks);
    delete state.wrecks["2,4"];
    loadWrecks(state.wrecks, wrecksSnap);
    expect(state.wrecks).toEqual(wrecksSnap);

    const eventsSnap = saveEvents(state.events);
    state.events.length = 0;
    expect(state.events).toHaveLength(0);
    loadEvents(state.events, eventsSnap);
    expect(state.events).toEqual(eventsSnap);
  });
});
