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
 *   advancePhase(state, rng);
 *   const snap = saveBattleState(state);
 *   // ... play on ...
 *   loadBattleState(state, snap);
 *
 * Fresh-state use:
 *
 *   const snap = saveBattleState(state);
 *   const revived = parseBattleState(snap);
 *
 * Manual field-by-field copy under the JSON, not `structuredClone`:
 * explicit list guards against future `BattleState` additions, keeps `src/`
 * browser-first with zero runtime dependencies. Finer-grained save/load
 * helpers (unit, damage, ammo, crits, buildings, wrecks) stay in
 * this module for internal reuse and tests; only the battle pair is public.
 * `BattleState` carries no event log: engine calls return transient
 * `GameEvent[]` instead, so snapshots stay small.
 */

import type { HexCell, HexCoord, Location, WreckState } from "../core/types.js";
import type { AmmoBins } from "./ammo.js";
import type { BuildingState } from "./building.js";
import type { UnitDamageState } from "./damage.js";
import type { AttackDecl, BattleState, Phase, UnitState } from "./game.js";

/** Detached deep copy of a `BattleState`. Treat as immutable. */
type BattleSnapshot = BattleState;
/** Detached deep copy of a `UnitState`. Treat as immutable. */
type UnitSnapshot = UnitState;
/** Detached deep copy of a `UnitDamageState`. Treat as immutable. */
type DamageSnapshot = UnitDamageState;
/** Detached deep copy of a unit's `AmmoBins`. Treat as immutable. */
type AmmoStateSnapshot = AmmoBins;
/** Detached deep copy of a per-slot destroyed-flag table. Treat as immutable. */
type CritTableSnapshot = Record<Location, boolean[]>;
/** Detached deep copy of the building map. Treat as immutable. */
type BuildingsSnapshot = Record<string, BuildingState>;
/** Detached deep copy of the wreck map. Treat as immutable. */
type WrecksSnapshot = Record<string, WreckState>;

function cloneHexCoord(hex: HexCoord): HexCoord {
  return { col: hex.col, row: hex.row };
}

function cloneCell(cell: HexCell): HexCell {
  return { terrain: cell.terrain, level: cell.level };
}

function cloneDamageState(damage: UnitDamageState): UnitDamageState {
  return {
    armor: { ...damage.armor },
    armorRear: { ...damage.armorRear },
    internalStructure: { ...damage.internalStructure },
  };
}

function cloneCritTable(src: Record<Location, boolean[]>): Record<Location, boolean[]> {
  const out = {} as Record<Location, boolean[]>;
  for (const loc of Object.keys(src) as Location[]) {
    out[loc] = [...(src[loc] ?? [])];
  }
  return out;
}

function cloneAmmoBins(bins: Readonly<AmmoBins>): AmmoBins {
  const out: AmmoBins = {};
  for (const bin of Object.values(bins)) {
    out[bin.id] = { ...bin };
  }
  return out;
}

function cloneAttackDecl(decl: AttackDecl): AttackDecl {
  return { ...decl };
}

function cloneBuildingState(building: BuildingState): BuildingState {
  return { cf: building.cf, type: building.type };
}

function cloneWreckState(wreck: WreckState): WreckState {
  return { unitId: wreck.unitId, level: wreck.level };
}

function cloneUnitState(unit: UnitState): UnitState {
  return {
    id: unit.id,
    model: unit.model,
    team: unit.team,
    gunnery: unit.gunnery,
    piloting: unit.piloting,
    pilotHits: unit.pilotHits,
    unconscious: unit.unconscious,
    unconsciousSinceTurn: unit.unconsciousSinceTurn,
    prone: unit.prone,
    position: cloneHexCoord(unit.position),
    facing: unit.facing,
    damage: cloneDamageState(unit.damage),
    phaseStartDamage: cloneDamageState(unit.phaseStartDamage),
    phaseStartCritSlotsDestroyed: cloneCritTable(unit.phaseStartCritSlotsDestroyed),
    ammoBins: cloneAmmoBins(unit.ammoBins),
    ammoPolicy: unit.ammoPolicy,
    jammedWeapons: [...unit.jammedWeapons],
    critSlotsDestroyed: cloneCritTable(unit.critSlotsDestroyed),
    destroyedWeapons: [...unit.destroyedWeapons],
    moveMode: unit.moveMode,
    movesThisTurn: [...unit.movesThisTurn],
    jumpedThisTurn: unit.jumpedThisTurn,
    mpSpent: unit.mpSpent,
    heat: unit.heat,
    shutdown: unit.shutdown,
    declaredAttacks: unit.declaredAttacks.map(cloneAttackDecl),
    firedTargetId: unit.firedTargetId,
    passedAttacks: unit.passedAttacks,
    destroyed: unit.destroyed,
    removed: unit.removed,
  };
}

/** Serializes whole battle state to a storable string. */
export function saveBattleState(state: BattleState): string {
  return JSON.stringify(cloneBattleState(state));
}

/** Phases in TW turn order; used to validate parsed snapshots. */
const PHASES: readonly Phase[] = ["initiative", "movement", "weaponAttack", "end"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Light shape-guard over parsed JSON; engine trusts own output, this
 *  rejects garbage / wrong-payload strings before touching live state.
 *  Snapshots pre-dating event-log removal carry an `events` key and are
 *  rejected outright (clean break, no migration). */
function isBattleSnapshotObject(value: unknown): value is BattleSnapshot {
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
    isRecord(value.wrecks)
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
  loadClonedBattleState(state, parsed);
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
  return cloneBattleState(parsed);
}

function cloneBattleState(state: BattleState): BattleSnapshot {
  const units: Record<string, UnitState> = {};
  for (const [id, unit] of Object.entries(state.units)) {
    units[id] = cloneUnitState(unit);
  }
  const buildings: Record<string, BuildingState> = {};
  for (const [key, building] of Object.entries(state.buildings)) {
    buildings[key] = cloneBuildingState(building);
  }
  const wrecks: Record<string, WreckState> = {};
  for (const [key, wreck] of Object.entries(state.wrecks)) {
    wrecks[key] = cloneWreckState(wreck);
  }
  return {
    turn: state.turn,
    phase: state.phase,
    initiativeWinnerTeam: state.initiativeWinnerTeam,
    units,
    cells: state.cells.map(cloneCell),
    width: state.width,
    height: state.height,
    critsDisabled: state.critsDisabled,
    actedThisPhase: [...state.actedThisPhase],
    actorQueue: state.actorQueue === null ? null : [...state.actorQueue],
    buildings,
    wrecks,
  };
}

/** Writes parsed snapshot onto live state in place; clones again so parsed
 *  payload never aliases live state. */
function loadClonedBattleState(state: BattleState, snapshot: BattleSnapshot): void {
  state.turn = snapshot.turn;
  state.phase = snapshot.phase;
  state.initiativeWinnerTeam = snapshot.initiativeWinnerTeam;
  state.critsDisabled = snapshot.critsDisabled;
  const grid = state as unknown as { width: number; height: number; cells: HexCell[] };
  grid.width = snapshot.width;
  grid.height = snapshot.height;
  grid.cells.length = 0;
  for (const cell of snapshot.cells) grid.cells.push(cloneCell(cell));
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
  for (const key of Object.keys(state.wrecks)) delete state.wrecks[key];
  for (const [key, wreck] of Object.entries(snapshot.wrecks)) {
    state.wrecks[key] = cloneWreckState(wreck);
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
  unit.unconscious = next.unconscious;
  unit.unconsciousSinceTurn = next.unconsciousSinceTurn;
  unit.prone = next.prone;
  unit.position = next.position;
  unit.facing = next.facing;
  unit.damage = next.damage;
  unit.phaseStartDamage = next.phaseStartDamage;
  unit.phaseStartCritSlotsDestroyed = next.phaseStartCritSlotsDestroyed;
  unit.ammoBins = next.ammoBins;
  unit.ammoPolicy = next.ammoPolicy;
  unit.jammedWeapons = next.jammedWeapons;
  unit.critSlotsDestroyed = next.critSlotsDestroyed;
  unit.destroyedWeapons = next.destroyedWeapons;
  unit.moveMode = next.moveMode;
  unit.movesThisTurn = next.movesThisTurn;
  unit.jumpedThisTurn = next.jumpedThisTurn;
  unit.mpSpent = next.mpSpent;
  unit.heat = next.heat;
  unit.shutdown = next.shutdown;
  unit.declaredAttacks = next.declaredAttacks;
  unit.firedTargetId = next.firedTargetId;
  unit.passedAttacks = next.passedAttacks;
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
  return cloneAmmoBins(bins);
}

/** Roll ammo map back to snapshot in place; drops bins added after save. */
export function loadAmmoState(target: AmmoBins, snapshot: AmmoStateSnapshot): void {
  for (const id of Object.keys(target)) delete target[id];
  for (const [id, bin] of Object.entries(cloneAmmoBins(snapshot))) {
    target[id] = bin;
  }
}

/** Detached deep copy of per-slot destroyed-flag table. Treat as immutable. */
export function saveCritTable(src: Record<Location, boolean[]>): CritTableSnapshot {
  return cloneCritTable(src);
}

/** Roll destroyed-flag table back to snapshot in place. */
export function loadCritTable(
  target: Record<Location, boolean[]>,
  snapshot: CritTableSnapshot,
): void {
  for (const loc of Object.keys(target) as Location[]) delete target[loc];
  for (const [loc, flags] of Object.entries(cloneCritTable(snapshot)) as Array<
    [Location, boolean[]]
  >) {
    target[loc] = flags;
  }
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

/** Detached deep copy of wreck map. Treat result as immutable. */
export function saveWrecks(wrecks: Record<string, WreckState>): WrecksSnapshot {
  const out: Record<string, WreckState> = {};
  for (const [key, wreck] of Object.entries(wrecks)) {
    out[key] = cloneWreckState(wreck);
  }
  return out;
}

/** Roll wreck map back to snapshot in place. */
export function loadWrecks(target: Record<string, WreckState>, snapshot: WrecksSnapshot): void {
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, wreck] of Object.entries(snapshot)) {
    target[key] = cloneWreckState(wreck);
  }
}
