/**
 * Engine state snapshots: save + rollback for `BattleState`.
 *
 * Public surface is three functions: `saveBattleState` serializes live state
 * to a JSON string; `loadBattleState` parses it back onto live state in
 * place (engine mutates passed state, returns void — see
 * `src/rules/game.ts`); `parseBattleState` parses a snapshot string into a
 * fresh detached `BattleState` with no placeholder needed. The string itself
 * is the reusable snapshot: load the same string repeatedly for repeated
 * rollbacks.
 *
 * Typical phase-change use:
 *
 *   advancePhase(state, sink, rng);
 *   const snap = saveBattleState(state);
 *   // ... play on ...
 *   loadBattleState(state, snap);
 *
 * Fresh-state use:
 *
 *   const snap = saveBattleState(state);
 *   const revived = parseBattleState(snap);
 *
 * The string is plain JSON of the state (undo-style rollback, never stored)
 * except that cells are listed only when not clear/level 0.
 *
 * Objects whose fields are all `readonly` (`HexCoord`, attack declarations,
 * `HeldClub`, `DeclaredPickup`, `ClubGroundToken`) are replaced
 * wholesale by the engine, never edited in place, so snapshots and live state
 * share them by reference; only mutable containers and records are copied.
 *
 * Manual field-by-field copy under the JSON, not `structuredClone`:
 * explicit list guards against future `BattleState` additions, keeps `src/`
 * browser-first with zero runtime dependencies. Finer-grained save/load
 * helpers (unit, damage, ammo, crits, buildings, wreckage) stay in
 * this module for internal reuse and tests; only the battle pair is public.
 * `BattleState` carries no event log: engine calls return transient
 * `GameEvent[]` instead, so snapshots stay small.
 */

import { hexCell } from "../core/terrain";
import type { HexCell, Location, TerrainType } from "../core/types";
import type { AmmoBins } from "./ammo";
import { assertBuildingsMatchCells, type BuildingState } from "./building";
import { type CritMask, cloneCritTable } from "./critical";
import type { UnitDamageState } from "./damage";
import type {
  BattleState,
  ClubGroundToken,
  MeleeCharge,
  Phase,
  UnitState,
  WreckageEntry,
} from "./game";

/** Detached deep copy of a `BattleState`. Treat as immutable. */
type BattleSnapshot = BattleState;
/** Detached deep copy of a `UnitState`. Treat as immutable. */
type UnitSnapshot = UnitState;
/** Detached deep copy of a `UnitDamageState`. Treat as immutable. */
type DamageSnapshot = UnitDamageState;
/** Detached deep copy of a unit's `AmmoBins`. Treat as immutable. */
type AmmoStateSnapshot = AmmoBins;
/** Detached deep copy of a destroyed-slot table. Treat as immutable. */
type CritTableSnapshot = CritMask;
/** Detached deep copy of the building map. Treat as immutable. */
type BuildingsSnapshot = Record<string, BuildingState>;
/** Detached deep copy of the wreckage overlay. Treat as immutable. */
type WreckageSnapshot = Record<string, WreckageEntry[]>;

function cloneDamageState(damage: UnitDamageState): UnitDamageState {
  return {
    armor: { ...damage.armor },
    armorRear: { ...damage.armorRear },
    internalStructure: { ...damage.internalStructure },
  };
}

/** `hex` and `from` are readonly `HexCoord`s: shared, not copied. `missed`
 *  is mutable, so the record itself is copied. */
function cloneMeleeCharge(charge: MeleeCharge): MeleeCharge {
  return { ...charge };
}

function cloneBuildingState(building: BuildingState): BuildingState {
  return { cf: building.cf };
}

function cloneUnitState(unit: UnitState): UnitState {
  return {
    id: unit.id,
    model: unit.model,
    team: unit.team,
    gunnery: unit.gunnery,
    piloting: unit.piloting,
    pilotHits: unit.pilotHits,
    pilotHitMax: unit.pilotHitMax,
    unconsciousSinceTurn: unit.unconsciousSinceTurn,
    prone: unit.prone,
    position: unit.position,
    facing: unit.facing,
    damage: cloneDamageState(unit.damage),
    ammoBins: { ...unit.ammoBins },
    ammoPolicy: unit.ammoPolicy,
    autoEject: unit.autoEject,
    jammedWeapons: [...unit.jammedWeapons],
    critSlotsDestroyed: cloneCritTable(unit.critSlotsDestroyed),
    blownOffLimbs: unit.blownOffLimbs.map((l) => ({ ...l })),
    club: unit.club,
    declaredPickup: unit.declaredPickup,
    moveMode: unit.moveMode,
    hexesMovedThisTurn: unit.hexesMovedThisTurn,
    jumpedThisTurn: unit.jumpedThisTurn,
    mpSpent: unit.mpSpent,
    heat: unit.heat,
    heatPending: unit.heatPending,
    shutdown: unit.shutdown,
    declaredWeaponAttacks: [...unit.declaredWeaponAttacks],
    declaredPhysicalAttacks: [...unit.declaredPhysicalAttacks],
    passedAttacks: unit.passedAttacks,
    meleeCharge: unit.meleeCharge === null ? null : cloneMeleeCharge(unit.meleeCharge),
    destroyed: unit.destroyed,
    removed: unit.removed,
  };
}

/** Packed battle: cells listed only when not clear/level 0. */
type PackedBattle = Omit<BattleState, "cells"> & {
  /** `[index, terrain, level]`, index = col-1 + (row-1)·width. */
  cells: Array<[number, TerrainType, number]>;
};

function packCells(cells: readonly HexCell[]): PackedBattle["cells"] {
  const out: PackedBattle["cells"] = [];
  cells.forEach((cell, i) => {
    if (cell.terrain !== "clear" || cell.level !== 0) out.push([i, cell.terrain, cell.level]);
  });
  return out;
}

function unpackCells(packed: PackedBattle["cells"], count: number): HexCell[] {
  const cells: HexCell[] = new Array<HexCell>(count).fill(hexCell("clear"));
  for (const [i, terrain, level] of packed) {
    if (cells[i] === undefined) throw new Error("Invalid battle snapshot string");
    cells[i] = hexCell(terrain, level);
  }
  return cells;
}

/** Serializes whole battle state to a storable string. */
export function saveBattleState(state: BattleState): string {
  const packed: PackedBattle = {
    ...cloneBattleRest(state),
    units: state.units,
    cells: packCells(state.cells),
  };
  return JSON.stringify(packed);
}

/** Phases in TW turn order; used to validate parsed snapshots. */
const PHASES: readonly Phase[] = ["initiative", "movement", "attack", "end"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Light shape-guard over parsed JSON; engine trusts own output, this
 *  rejects garbage / wrong-payload strings before touching live state.
 *  Snapshots pre-dating event-log removal carry an `events` key and are
 *  rejected outright (clean break, no migration). */
function isBattleSnapshotObject(value: unknown): value is PackedBattle {
  if (!isRecord(value)) return false;
  return (
    typeof value.turn === "number" &&
    typeof value.phase === "string" &&
    (PHASES as readonly string[]).includes(value.phase) &&
    typeof value.width === "number" &&
    typeof value.height === "number" &&
    typeof value.critsDisabled === "boolean" &&
    isRecord(value.units) &&
    Array.isArray(value.cells) &&
    Array.isArray(value.actedThisPhase) &&
    (value.actorQueue === null || Array.isArray(value.actorQueue)) &&
    !("events" in value) &&
    isRecord(value.buildings) &&
    isRecord(value.wreckage) &&
    isRecord(value.clubs) &&
    isRecord(value.rubbleOrigin)
  );
}

/** Rolls live state back to serialized snapshot. Same string loads
 *  repeatedly. Throws when `data` is not a battle snapshot string. */
export function loadBattleState(state: BattleState, data: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error("Invalid battle snapshot string");
  }
  if (!isBattleSnapshotObject(parsed)) throw new Error("Invalid battle snapshot string");
  loadClonedBattleState(state, unpackBattle(parsed));
}

/** Parses snapshot string into fresh detached `BattleState`. Same string
 *  parses repeatedly. Throws when `data` is not a battle snapshot string. */
export function parseBattleState(data: string): BattleState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error("Invalid battle snapshot string");
  }
  if (!isBattleSnapshotObject(parsed)) throw new Error("Invalid battle snapshot string");
  return unpackBattle(parsed);
}

/** The parsed JSON is fresh, so it is adopted as is apart from the cells.
 *  Snapshots saved before `autoEject` existed load with it engaged (the
 *  default policy). */
function unpackBattle(packed: PackedBattle): BattleSnapshot {
  for (const unit of Object.values(packed.units)) {
    if (typeof unit.autoEject !== "boolean") unit.autoEject = true;
  }
  const cells = unpackCells(packed.cells, packed.width * packed.height);
  assertBuildingsMatchCells(cells, packed.width, packed.buildings, packed.rubbleOrigin);
  return { ...packed, cells };
}

/** Deep copy of every battle field except `units` and `cells`. */
function cloneBattleRest(
  state: Omit<BattleState, "cells" | "units">,
): Omit<BattleSnapshot, "cells" | "units"> {
  const buildings: Record<string, BuildingState> = {};
  for (const [key, building] of Object.entries(state.buildings)) {
    buildings[key] = cloneBuildingState(building);
  }
  const wreckage = saveWreckage(state.wreckage);
  const clubs: Record<string, ClubGroundToken[]> = {};
  for (const [key, tokens] of Object.entries(state.clubs)) {
    clubs[key] = [...tokens];
  }
  return {
    turn: state.turn,
    phase: state.phase,
    initiativeWinnerTeam: state.initiativeWinnerTeam,
    width: state.width,
    height: state.height,
    critsDisabled: state.critsDisabled,
    actedThisPhase: [...state.actedThisPhase],
    actorQueue: state.actorQueue === null ? null : [...state.actorQueue],
    buildings,
    wreckage,
    clubs,
    rubbleOrigin: { ...state.rubbleOrigin },
  };
}

/** Writes parsed snapshot onto live state in place; clones again so parsed
 *  payload never aliases live state. */
function loadClonedBattleState(state: BattleState, snapshot: BattleSnapshot): void {
  state.turn = snapshot.turn;
  state.phase = snapshot.phase;
  state.initiativeWinnerTeam = snapshot.initiativeWinnerTeam;
  state.critsDisabled = snapshot.critsDisabled;
  const grid = state as unknown as { width: number; height: number };
  grid.width = snapshot.width;
  grid.height = snapshot.height;
  state.cells.length = snapshot.cells.length;
  snapshot.cells.forEach((cell, i) => {
    state.cells[i] = cell;
  });
  for (const id of Object.keys(state.units)) delete state.units[id];
  for (const [id, unit] of Object.entries(snapshot.units)) {
    state.units[id] = cloneUnitState(unit);
  }
  state.actedThisPhase.length = 0;
  state.actedThisPhase.push(...snapshot.actedThisPhase);
  state.actorQueue = snapshot.actorQueue === null ? null : [...snapshot.actorQueue];
  for (const key of Object.keys(state.buildings)) delete state.buildings[key];
  for (const [key, building] of Object.entries(snapshot.buildings)) {
    state.buildings[key] = cloneBuildingState(building);
  }
  loadWreckage(state.wreckage, snapshot.wreckage);
  for (const key of Object.keys(state.clubs)) delete state.clubs[key];
  for (const [key, tokens] of Object.entries(snapshot.clubs)) {
    state.clubs[key] = [...tokens];
  }
  for (const key of Object.keys(state.rubbleOrigin)) delete state.rubbleOrigin[key];
  for (const [key, origin] of Object.entries(snapshot.rubbleOrigin)) {
    state.rubbleOrigin[key] = origin;
  }
}

/** Detached deep copy of one unit. Treat result as immutable. */
export function saveUnitState(unit: UnitState): UnitSnapshot {
  return cloneUnitState(unit);
}

/** Roll one live unit back to snapshot, preserving unit reference. */
export function loadUnitState(unit: UnitState, snapshot: UnitSnapshot): void {
  const next = cloneUnitState(snapshot);
  unit.gunnery = next.gunnery;
  unit.piloting = next.piloting;
  unit.pilotHits = next.pilotHits;
  unit.pilotHitMax = next.pilotHitMax;
  unit.unconsciousSinceTurn = next.unconsciousSinceTurn;
  unit.prone = next.prone;
  unit.position = next.position;
  unit.facing = next.facing;
  unit.damage = next.damage;
  unit.ammoBins = next.ammoBins;
  unit.ammoPolicy = next.ammoPolicy;
  unit.autoEject = next.autoEject;
  unit.jammedWeapons = next.jammedWeapons;
  unit.critSlotsDestroyed = next.critSlotsDestroyed;
  unit.blownOffLimbs = next.blownOffLimbs.map((l) => ({ ...l }));
  unit.club = next.club;
  unit.declaredPickup = next.declaredPickup;
  unit.moveMode = next.moveMode;
  unit.hexesMovedThisTurn = next.hexesMovedThisTurn;
  unit.jumpedThisTurn = next.jumpedThisTurn;
  unit.mpSpent = next.mpSpent;
  unit.heat = next.heat;
  unit.heatPending = next.heatPending;
  unit.shutdown = next.shutdown;
  unit.declaredWeaponAttacks = next.declaredWeaponAttacks;
  unit.declaredPhysicalAttacks = [...next.declaredPhysicalAttacks];
  unit.passedAttacks = next.passedAttacks;
  unit.meleeCharge = next.meleeCharge === null ? null : cloneMeleeCharge(next.meleeCharge);
  unit.destroyed = next.destroyed;
  unit.removed = next.removed;
}

/** Detached deep copy of layered damage state. Treat result as immutable. */
export function saveDamageState(damage: UnitDamageState): DamageSnapshot {
  return cloneDamageState(damage);
}

/** Roll layered damage back to snapshot. Clones again; snapshot stays reusable. */
export function loadDamageState(target: UnitDamageState, snapshot: DamageSnapshot): void {
  const mutable = target as unknown as {
    armor: UnitDamageState["armor"];
    armorRear: UnitDamageState["armorRear"];
    internalStructure: UnitDamageState["internalStructure"];
  };
  const next = cloneDamageState(snapshot);
  mutable.armor = next.armor;
  mutable.armorRear = next.armorRear;
  mutable.internalStructure = next.internalStructure;
}

/** Detached deep copy of per-bin ammo map. Treat result as immutable. */
export function saveAmmoState(bins: Readonly<AmmoBins>): AmmoStateSnapshot {
  return { ...bins };
}

/** Roll ammo map back to snapshot in place; drops bins added after save. */
export function loadAmmoState(target: AmmoBins, snapshot: AmmoStateSnapshot): void {
  for (const id of Object.keys(target)) delete target[id];
  for (const [id, shots] of Object.entries(snapshot)) {
    target[id] = shots;
  }
}

/** Detached deep copy of the destroyed-slot table. Treat as immutable. */
export function saveCritTable(src: CritMask): CritTableSnapshot {
  return cloneCritTable(src);
}

/** Roll destroyed-slot table back to snapshot in place. */
export function loadCritTable(target: CritMask, snapshot: CritTableSnapshot): void {
  for (const loc of Object.keys(target) as Location[]) delete target[loc];
  Object.assign(target, cloneCritTable(snapshot));
}

/** Detached deep copy of building map. Treat result as immutable. */
export function saveBuildings(buildings: Record<string, BuildingState>): BuildingsSnapshot {
  const out: Record<string, BuildingState> = {};
  for (const [key, building] of Object.entries(buildings)) {
    out[key] = cloneBuildingState(building);
  }
  return out;
}

/** Roll building map back to snapshot in place; restores collapsed entries. */
export function loadBuildings(
  target: Record<string, BuildingState>,
  snapshot: BuildingsSnapshot,
): void {
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, building] of Object.entries(snapshot)) {
    target[key] = cloneBuildingState(building);
  }
}

/** Detached copy of the wreckage overlay. Treat as immutable. */
export function saveWreckage(wreckage: Record<string, WreckageEntry[]>): WreckageSnapshot {
  const out: Record<string, WreckageEntry[]> = {};
  for (const [key, entries] of Object.entries(wreckage)) {
    out[key] = [...entries];
  }
  return out;
}

/** Roll the wreckage overlay back to snapshot in place. */
export function loadWreckage(
  target: Record<string, WreckageEntry[]>,
  snapshot: WreckageSnapshot,
): void {
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, entries] of Object.entries(snapshot)) {
    target[key] = [...entries];
  }
}
