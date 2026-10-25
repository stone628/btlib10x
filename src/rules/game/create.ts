import { hexCell } from "../../core/terrain";
import { type Facing, type HexCell, type HexCoord, hexKey, msgHex } from "../../core/types";
import { ensureMechRegistered, type MapDef, mechDefFor } from "../../data/index";
import type { ResolvedMechDef } from "../../data/mech.schema";
import { type BuildingState, createBuildingState, isBuildingTerrain } from "../building";
import { resolveInitialDamage } from "../initialDamage";
import { DEFAULT_PILOT_HIT_MAX, DEFAULT_PILOTING, isValidPilotHitMax } from "../piloting";
import { DEFAULT_GUNNERY } from "../tohit";
import {
  DEFAULT_CREATE_BATTLE_OPTION,
  DEFAULT_UNIT_POLICY,
  WRECKAGE_TONNAGE_MIN,
} from "./constants";
import type {
  BattleState,
  ClubGroundToken,
  CreateBattleOptions,
  TeamId,
  UnitInit,
  UnitPolicy,
  UnitSkillRange,
  UnitState,
  WreckageEntry,
} from "./types";

export function buildUnitInit(
  id: string,
  model: string,
  team: TeamId,
  position: HexCoord,
  facing: Facing = "n",
  gunnery: UnitSkillRange = DEFAULT_GUNNERY,
  piloting: UnitSkillRange = DEFAULT_PILOTING,
  pilotHitMax: number = DEFAULT_PILOT_HIT_MAX,
  policy: UnitPolicy = DEFAULT_UNIT_POLICY,
): UnitInit {
  return {
    id,
    model,
    team,
    position,
    facing,
    gunnery,
    piloting,
    pilotHitMax,
    policy: { ...policy },
  };
}

/**
 * Resolve a model id named by a unit or by map debris, registering a catalog
 * sheet nobody has fielded yet (DATA-04). Only the exact canonical id counts:
 * a wrong-case id would be stored and later miss `mechDefFor`.
 */
export function catalogModel(model: string): ResolvedMechDef | undefined {
  const def = ensureMechRegistered(model);
  // Not `def?.model === model`, which holds for a model of undefined.
  return def !== undefined && def.model === model ? def : undefined;
}

export function createBattle(
  map: MapDef,
  units: readonly UnitInit[],
  options: CreateBattleOptions = DEFAULT_CREATE_BATTLE_OPTION,
): BattleState {
  if (units.length < 2) throw new Error("A battle needs at least two units");
  const { width, height } = map;
  for (const [label, n] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`Board ${label} must be an integer >= 1`);
    }
  }
  const seen = new Set<string>();
  const startHexes = new Map<string, string>();
  for (const init of units) {
    if (seen.has(init.id)) throw new Error(`Duplicate unit id: ${init.id}`);
    seen.add(init.id);
    if (!catalogModel(init.model)) throw new Error(`Unknown 'Mech model: ${init.model}`);
    if (!isValidPilotHitMax(init.pilotHitMax)) {
      throw new Error(`pilotHitMax(${init.pilotHitMax}) for ${init.id} must be an integer >= 1`);
    }
    // The types cannot express these: whole-number, on-board, one unit per hex.
    const { col, row } = init.position;
    if (!Number.isInteger(col) || !Number.isInteger(row)) {
      throw new Error(`Unit ${init.id} starts at a non-integer hex ${col},${row}`);
    }
    if (col < 1 || col > width || row < 1 || row > height) {
      throw new Error(
        `Unit ${init.id} starts off the ${width}x${height} board at ${msgHex(init.position)}`,
      );
    }
    const key = hexKey(init.position);
    const other = startHexes.get(key);
    if (other !== undefined) {
      throw new Error(
        `Units ${other} and ${init.id} start in the same hex ${msgHex(init.position)}`,
      );
    }
    startHexes.set(key, init.id);
  }
  // Note: team ids are typed 1|2 (not checked at runtime), but a single
  // team is allowed here (rendering drills, movement fixtures). Real games
  // require both teams 1 and 2 via setupStartBattle.

  const unitStates: Record<string, UnitState> = {};
  for (const init of units) {
    const def: ResolvedMechDef = mechDefFor(init);
    const pilotHitMax = init.pilotHitMax ?? DEFAULT_PILOT_HIT_MAX;
    const start = resolveInitialDamage(def, init.id, init.damage, pilotHitMax);
    const { damage, ammoBins } = start;
    unitStates[init.id] = {
      id: init.id,
      model: init.model,
      team: init.team,
      gunnery: init.gunnery,
      piloting: init.piloting,
      pilotHits: start.pilotHits,
      pilotHitMax,
      unconsciousSinceTurn: null,
      prone: start.prone,
      position: init.position,
      facing: init.facing,
      damage,
      ammoBins,
      ammoPolicy: init.policy.ammoPolicy,
      autoEject: init.policy.autoEject,
      heatFlamer: init.policy.heatFlamer,
      amsPolicy: init.policy.amsPolicy,
      jammedWeapons: [],
      critSlotsDestroyed: start.critSlotsDestroyed,
      blownOffLimbs: [],
      damageTakenFrom: {},
      club: null,
      declaredPickup: null,
      moveMode: null,
      hexesMovedThisTurn: 0,
      jumpedThisTurn: false,
      mpSpent: 0,
      heat: 0,
      heatPending: 0,
      heatExternalPending: 0,
      shutdown: "not",
      declaredWeaponAttacks: [],
      declaredPhysicalAttacks: [],
      passedAttacks: false,
      meleeCharge: null,
      destroyed: "not",
      removed: "not",
    };
  }

  const cells: HexCell[] = new Array<HexCell>(width * height).fill(hexCell("clear"));
  const terrainSeen = new Set<string>();
  const buildings: Record<string, BuildingState> = {};
  for (const t of map.terrain) {
    const key = hexKey(t);
    if (terrainSeen.has(key)) throw new Error(`Duplicate terrain definition for hex ${msgHex(t)}`);
    terrainSeen.add(key);
    cells[t.col - 1 + (t.row - 1) * width] = hexCell(t.type, t.level ?? 0);
    if (isBuildingTerrain(t.type)) buildings[key] = createBuildingState(t.type);
  }
  const clubs: Record<string, ClubGroundToken[]> = {};
  for (const c of map.clubs ?? []) {
    if (!catalogModel(c.model))
      throw new Error(`Unknown 'Mech model for club at ${msgHex(c)}: ${c.model}`);
    const key = hexKey(c);
    clubs[key] = [
      ...(clubs[key] ?? []),
      { kind: "limb", limb: c.limb, model: c.model, ownerId: null },
    ];
  }
  const wreckage: Record<string, WreckageEntry[]> = {};
  for (const w of map.wreckage ?? []) {
    const def = catalogModel(w.model);
    if (!def) throw new Error(`Unknown 'Mech model for wreckage at ${msgHex(w)}: ${w.model}`);
    if (def.tonnage < WRECKAGE_TONNAGE_MIN) {
      throw new Error(
        `Wreckage at ${msgHex(w)}: ${w.model} is ${def.tonnage} t, under ${WRECKAGE_TONNAGE_MIN} t`,
      );
    }
    const key = hexKey(w);
    wreckage[key] = [...(wreckage[key] ?? []), { model: w.model, unitId: null }];
  }

  return {
    // turn: 1,
    turn: 0,
    // phase: "initiative",
    phase: "end",
    initiativeWinnerTeam: null,
    units: unitStates,
    cells,
    width,
    height,
    critsDisabled: options.critsDisabled,
    actedThisPhase: [],
    actorQueue: null,
    buildings,
    wreckage,
    clubs,
    rubbleOrigin: {},
  };
}
