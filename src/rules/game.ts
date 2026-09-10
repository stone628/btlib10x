import { roll2D6 } from "../core/dice.js";
import { bearing, hexDistance, isAdjacent, sameHex } from "../core/hex.js";
import {
  cellAt,
  costToClimb,
  costToEnter,
  type HexGrid,
  hasPartialCover,
} from "../core/terrain.js";
import {
  type Facing,
  type HexCell,
  type HexCoord,
  isFacing,
  LOCATIONS,
  type Location,
  type MoveMode,
  type Rng,
  rotateFacing,
  type TerrainHexDef,
} from "../core/types.js";
import { getMechDef, getMechDefFor, type MapDef, type MechModelHolder } from "../data/index.js";
import type { ResolvedMechDef } from "../data/mech.schema.js";
import { getWeaponDefFor } from "../data/weapon.schema.js";
import {
  type AmmoBinId,
  type AmmoPolicy,
  ammoWeaponTotals,
  binsForWeapon,
  consumeAmmo,
  consumeAmmoForName,
  loadAmmoBins,
  pooledShotsLeft,
  stripBinsInLocation,
} from "./ammo.js";
import { type Arc, classifyArc } from "./arcs.js";
import { type AttackResolution, resolveWeaponAttack } from "./attack.js";
import {
  applyBuildingDamage,
  type BuildingState,
  buildingTypeOf,
  collapseToRubble,
  createBuildingState,
  isCollapsed,
} from "./building.js";
import {
  applyAmmoExplosion,
  type CriticalResolution,
  checkCASE,
  effectiveMovement,
} from "./critical.js";
import {
  applyDamage,
  canFireFromLocation,
  isUnitDestroyed,
  isUnitImmobile,
  type UnitDamageState,
} from "./damage.js";
import {
  ammoExplosionAvoidWithThreshold,
  countDestroyedEngineSlots,
  effectiveMoveBudget,
  engineHitHeat,
  HEAT_CAP,
  heatDissipation,
  largestAmmoBin,
  movementHeat,
  shutdownAvoid,
  shutdownAvoidWithThreshold,
  toHitHeatModifier,
} from "./heat.js";
import { hitLocation } from "./hitlocation.js";
import { rollInitiative } from "./initiative.js";
import {
  interveningTerrains,
  losBlockedByBuilding,
  losBlockedByElevation,
  losClear,
  losWoodsPointsBetween,
} from "./los.js";
import * as mv from "./movement.js";
import { computeToHit } from "./tohit.js";

export interface UnitInit extends MechModelHolder {
  readonly id: string;
  readonly model: string;
  readonly team: number;
  readonly gunnery: number;
  readonly position: HexCoord;
  readonly facing: Facing;
}

export interface AttackDecl {
  readonly weaponIndex: number;
  readonly targetId: string;
  /** Request a rapid-fire (double-tap) volley; only valid on rapid-fire weapons. Defaults off. */
  readonly rapidFire?: boolean;
  /** Firing arc of the target relative to the attacker's facing, classified at
   *  declaration time. Drives the hit-location table and armor pool. */
  readonly arc?: Arc;
}

export type MoveStep =
  | { readonly kind: "enter"; readonly to: HexCoord }
  | { readonly kind: "turn"; readonly facings: number };

/** Off-line status of a unit. `"not"` = online; any other value = shut down.
 *  `"manual"` persists until a voluntary startup roll succeeds, `"heat"`
 *  auto-restarts in the end phase once heat drops, and `"starting"` is a
 *  successful startup still pending the next initiative roll. */
export type ShutdownState = "manual" | "heat" | "starting" | "not";

export type Phase = "initiative" | "movement" | "weaponAttack" | "end";

/** Deterministic rng for ammo draws when the caller omits one: ties resolve
 *  to the first bin and the order is stable run to run. */
export const DEFAULT_RNG: Rng = { d6: () => 1 };

export interface UnitState extends MechModelHolder {
  readonly id: string;
  readonly model: string;
  readonly team: number;
  gunnery: number;
  position: HexCoord;
  facing: Facing;
  damage: UnitDamageState;
  phaseStartDamage: UnitDamageState;
  shotsLeft: Record<number, number>;
  /** Per-crit-slot ammo remaining (see `src/rules/ammo.ts`). */
  ammoBins: Record<AmmoBinId, number>;
  /** Which of a unit's ammo bins the next shot is drawn from. */
  ammoPolicy: AmmoPolicy;
  jammedWeapons: number[];
  /** Per-slot destroyed flag for each location's crit slot table. */
  critSlotsDestroyed: Record<Location, boolean[]>;
  /** Weapon indices destroyed by a critical hit (in addition to destroyed
   *  locations, which the canFireFromLocation check already covers). */
  destroyedWeapons: number[];
  moveMode: MoveMode | null;
  movesThisTurn: ("forward" | "backward")[];
  jumpedThisTurn: boolean;
  mpSpent: number;
  /** Current heat scale value, capped at {@link HEAT_CAP}. Movement and
   *  weapon heat accumulate during the turn; dissipation runs in the end
   *  phase. */
  heat: number;
  /** Shutdown state: "manual" (voluntary), "heat" (automatic, restartable in
   *  the end phase), "starting" (startup roll succeeded; still off-line until
   *  the next initiative roll) or "not" (online). Anything but "not" counts
   *  as shut down: cannot move, fire, or act as the next actor. */
  shutdown: ShutdownState;
  declaredAttacks: AttackDecl[];
  firedTargetId: string | null;
  /** True if the unit explicitly passed on declaring attacks this phase. */
  passedAttacks: boolean;
  destroyed: boolean;
  removed: boolean;
}

export type GameEvent =
  | { readonly kind: "turn"; readonly turn: number }
  | { readonly kind: "phase"; readonly phase: Phase }
  | {
      readonly kind: "initiative";
      readonly rolls: Readonly<Record<number, number>>;
      readonly winnerTeam: number;
    }
  | { readonly kind: "moveDeclared"; readonly unitId: string; readonly mode: MoveMode }
  | {
      readonly kind: "moved";
      readonly unitId: string;
      readonly mode: MoveMode;
      readonly position: HexCoord;
      readonly facing: Facing;
      readonly mpSpent: number;
      readonly mpBudget: number;
    }
  | {
      readonly kind: "attacksDeclared";
      readonly unitId: string;
      readonly targetId: string;
      readonly count: number;
      readonly distance: number;
      readonly rangeBracket: string;
      readonly rangeMod: number;
    }
  | {
      readonly kind: "attackResolved";
      readonly unitId: string;
      readonly targetId: string;
      readonly resolution: AttackResolution;
    }
  | { readonly kind: "unitDestroyed"; readonly unitId: string }
  | { readonly kind: "unitRemoved"; readonly unitId: string }
  | {
      readonly kind: "buildingCollapsed";
      readonly col: number;
      readonly row: number;
    }
  | {
      readonly kind: "buildingDamaged";
      readonly col: number;
      readonly row: number;
      readonly damage: number;
      /** Structural factor remaining after the hit (0 when collapsed). */
      readonly cf: number;
    }
  | {
      readonly kind: "collapseDamage";
      readonly unitId: string;
      readonly col: number;
      readonly row: number;
      readonly location: Location;
      readonly damage: number;
    }
  | { readonly kind: "heatMove"; readonly unitId: string; readonly heat: number }
  | {
      readonly kind: "heatWeapon";
      readonly unitId: string;
      readonly weapon: string;
      readonly heat: number;
      readonly prevHeat: number;
      readonly currHeat: number;
    }
  | {
      readonly kind: "heatEngineCrit";
      readonly unitId: string;
      readonly heat: number;
      readonly prevHeat: number;
      readonly currHeat: number;
    }
  | {
      readonly kind: "heatDissipated";
      readonly unitId: string;
      readonly dissip: number;
      readonly prevHeat: number;
      readonly currHeat: number;
      readonly capacity: number;
    }
  | {
      readonly kind: "shutdownCheck";
      readonly unitId: string;
      readonly avoided: boolean;
      readonly manual: boolean;
      readonly roll: number;
      readonly heat: number;
      readonly avoid: number;
      readonly threshold: number;
    }
  | {
      readonly kind: "restartCheck";
      readonly unitId: string;
      readonly success: boolean;
      readonly manual: boolean;
      readonly roll: number;
      readonly heat: number;
      readonly avoid: number;
      readonly threshold: number;
    }
  | {
      readonly kind: "ammoExplosionCheck";
      readonly unitId: string;
      readonly weapon: string;
      readonly location: Location;
      readonly slotIndex: number;
      readonly roll: number;
      readonly heat: number;
      readonly avoid: number;
      readonly threshold: number;
      readonly shotsRemaining: number;
      readonly damage: number;
      readonly avoided: boolean;
    };

interface UnitAttackResolution {
  readonly targetId: string;
  readonly resolution: AttackResolution;
  readonly weaponHeat: number;
  readonly buildingDamage: number;
}

export interface UnitAttackResult {
  readonly unitId: string;
  readonly resolutions: readonly UnitAttackResolution[];
  readonly finalAmmoBins: Record<AmmoBinId, number>;
  readonly finalShotsLeft: Record<number, number>;
  readonly jammedWeapons: readonly number[];
}

export interface BattleState extends HexGrid {
  turn: number;
  phase: Phase;
  initiativeWinnerTeam: number | null;
  units: Record<string, UnitState>;
  /** When true, critical hit resolution is suppressed at attack time. */
  critsDisabled: boolean;
  actedThisPhase: string[];
  /** Activation order for the current phase, computed lazily on first query
   *  and cached until the next phase transition. */
  actorQueue: string[] | null;
  events: GameEvent[];
  /** Building state keyed by hex `"col,row"`; only building hexes present. */
  buildings: Record<string, BuildingState>;
}

export type { TerrainHexDef };

export interface CreateBattleOptions {
  /**
   * Disable critical hit resolution. Tests that script dice for narrow
   * damage scenarios (where any crit would alter the expected outcome) can
   * set this to `true` so the engine follows the scripted RNG only for the
   * attack and location rolls.
   */
  readonly critsDisabled: boolean;
}

function requireUnit(state: BattleState, unitId: string): UnitState {
  const unit = state.units[unitId];
  if (!unit) throw new Error(`Unknown unit id: ${unitId}`);
  return unit;
}

export function isNominal(unit: UnitState) {
  return unit.shutdown === "not";
}

export function isShutdown(unit: UnitState) {
  return unit.shutdown !== "not";
}

export function isImmobile(unit: UnitState) {
  return isShutdown(unit) || isUnitImmobile(unit.damage);
}

/** Error messages show 1-based coordinates; positions are stored 1-based. */
function fmtHex(hex: { col: number; row: number }): string {
  return `${hex.col},${hex.row}`;
}

function requirePhase(state: BattleState, phase: Phase): void {
  if (state.phase !== phase) {
    throw new Error(`Expected phase ${phase}, but battle is in ${state.phase}`);
  }
}

function occupantAt(state: BattleState, hex: HexCoord, excludeId?: string): UnitState | undefined {
  for (const unit of Object.values(state.units)) {
    if (unit.removed || unit.id === excludeId) continue;
    if (sameHex(unit.position, hex)) return unit;
  }
  return undefined;
}

/** Mark a unit as killed and removed, emitting the paired events. */
function markUnitDestroyed(state: BattleState, unit: UnitState): void {
  unit.destroyed = true;
  unit.removed = true;
  state.events.push(
    { kind: "unitDestroyed", unitId: unit.id },
    { kind: "unitRemoved", unitId: unit.id },
  );
}

export function createBattle(
  map: MapDef,
  units: readonly UnitInit[],
  options: CreateBattleOptions,
): BattleState {
  if (units.length < 2) throw new Error("A battle needs at least two units");
  const seen = new Set<string>();
  for (const init of units) {
    if (seen.has(init.id)) throw new Error(`Duplicate unit id: ${init.id}`);
    seen.add(init.id);
    if (!getMechDef(init.model)) throw new Error(`Unknown 'Mech model: ${init.model}`);
    if (!isFacing(init.facing))
      throw new Error(`Invalid facing for ${init.id}: ${String(init.facing)}`);
    if (!Number.isInteger(init.gunnery) || init.gunnery < 0 || init.gunnery > 7) {
      throw new Error(`Gunnery for ${init.id} must be an integer 0..7`);
    }
  }

  const unitStates: Record<string, UnitState> = {};
  for (const init of units) {
    const def: ResolvedMechDef = getMechDefFor(init);
    const ammoLoad = loadAmmoBins(def);
    const damage: UnitDamageState = {
      armor: { ...def.armor },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure },
    };
    unitStates[init.id] = {
      id: init.id,
      model: init.model,
      team: init.team,
      gunnery: init.gunnery,
      position: { ...init.position },
      facing: init.facing,
      damage,
      phaseStartDamage: {
        armor: { ...damage.armor },
        armorRear: { ...damage.armorRear },
        internalStructure: { ...damage.internalStructure },
      },
      shotsLeft: ammoLoad.totals,
      ammoBins: ammoLoad.bins,
      ammoPolicy: "exposed",
      jammedWeapons: [],
      critSlotsDestroyed: initCritDestroyed(def),
      destroyedWeapons: [],
      moveMode: null,
      movesThisTurn: [],
      jumpedThisTurn: false,
      mpSpent: 0,
      heat: 0,
      shutdown: "not",
      declaredAttacks: [],
      firedTargetId: null,
      passedAttacks: false,
      destroyed: false,
      removed: false,
    };
  }

  const { width, height } = map;
  for (const [label, n] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`Board ${label} must be an integer >= 1`);
    }
  }
  const cells: HexCell[] = new Array<HexCell>(width * height).fill({
    terrain: "clear",
    level: 0,
  });
  const terrainSeen = new Set<string>();
  const buildings: Record<string, BuildingState> = {};
  for (const { col, row, type, level } of map.terrain) {
    const key = `${col},${row}`;
    if (terrainSeen.has(key))
      throw new Error(`Duplicate terrain definition for hex ${fmtHex({ col, row })}`);
    terrainSeen.add(key);
    cells[col - 1 + (row - 1) * width] = { terrain: type, level: level ?? 0 };
    const bt = buildingTypeOf(type);
    if (bt !== undefined) buildings[key] = createBuildingState(bt);
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
    // events: [{ kind: "turn", turn: 1 }],
    events: [],
    buildings,
  };
}

/** Outcome of applying weapon damage to a building hex. */
export interface BuildingDamageResult {
  readonly col: number;
  readonly row: number;
  readonly damage: number;
  /** Structural factor before the hit. */
  readonly preCf: number;
  /** Structural factor remaining after the hit (0 = collapsed). */
  readonly cf: number;
  readonly collapsed: boolean;
  /** Collapse event pushed to the log, or `null` when the building stands. */
  readonly event: {
    readonly kind: "buildingCollapsed";
    readonly col: number;
    readonly row: number;
  } | null;
  /** Unit ids occupying the hex at the moment of collapse. */
  readonly occupants: readonly string[];
}

/**
 * Apply weapon damage to the building occupying a hex, collapsing it to rubble
 * when its structural factor reaches zero. Emits a `buildingDamaged` event on
 * every hit and a `buildingCollapsed` event on collapse. Returns the outcome,
 * or `null` when the hex has no building. Occupant collapse damage is applied
 * by the caller (see `resolveAllAttacks`).
 */
export function damageBuildingAt(
  state: BattleState,
  hex: HexCoord,
  damage: number,
): BuildingDamageResult | null {
  const key = `${hex.col},${hex.row}`;
  const building = state.buildings[key];
  if (building === undefined) return null;
  const preCf = building.cf;
  const occupants = Object.values(state.units)
    .filter((u) => !u.removed && sameHex(u.position, hex))
    .map((u) => u.id);
  state.buildings[key] = applyBuildingDamage(building, damage);
  const cf = state.buildings[key]!.cf;
  if (isCollapsed(state.buildings[key]!)) {
    const cell = state.cells[hex.col - 1 + (hex.row - 1) * state.width]!;
    collapseToRubble(cell);
    delete state.buildings[key];
    const event = { kind: "buildingCollapsed", col: hex.col, row: hex.row } as const;
    state.events.push(event);
    return { col: hex.col, row: hex.row, damage, preCf, cf: 0, collapsed: true, event, occupants };
  }
  state.events.push({ kind: "buildingDamaged", col: hex.col, row: hex.row, damage, cf });
  return {
    col: hex.col,
    row: hex.row,
    damage,
    preCf,
    cf,
    collapsed: false,
    event: null,
    occupants: [],
  };
}

export function rollInitiativePhase(state: BattleState, rng: Rng): void {
  requirePhase(state, "initiative");
  const teams = [...new Set(Object.values(state.units).map((u) => u.team))];
  const result = rollInitiative(teams, rng);
  state.initiativeWinnerTeam = result.winnerTeam;
  state.phase = "movement";
  state.actorQueue = null;
  state.events.push(
    { kind: "initiative", rolls: result.rolls, winnerTeam: result.winnerTeam },
    { kind: "phase", phase: "movement" },
  );
}

export function declareMove(state: BattleState, unitId: string, mode: MoveMode): void {
  requirePhase(state, "movement");
  const unit = requireUnit(state, unitId);
  if (unit.removed) throw new Error(`${unitId} is removed from play`);
  if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot move`);
  if (mode !== "standStill" && isUnitImmobile(unit.damage)) {
    throw new Error(`${unitId} has a destroyed leg and can only stand still`);
  }
  unit.moveMode = mode;
  unit.movesThisTurn = [];
  unit.mpSpent = 0;
  state.events.push({ kind: "moveDeclared", unitId, mode });
}

export function executeMove(
  state: BattleState,
  unitId: string,
  steps: readonly MoveStep[],
  options: { readonly finalFacing?: Facing } = {},
): void {
  requirePhase(state, "movement");
  const unit = requireUnit(state, unitId);
  if (unit.moveMode === null) throw new Error(`Declare a movement mode for ${unitId} first`);
  if (unit.removed) throw new Error(`${unitId} is removed from play`);
  if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot move`);

  const def = getMechDefFor(unit);
  const movement = effectiveMovement(def, unit.critSlotsDestroyed);
  const budget = effectiveMoveBudget(unit.moveMode, movement, unit.heat);
  const jumping = unit.moveMode === "jump";

  let cursor: HexCoord = { ...unit.position };
  let facing: Facing = unit.facing;
  let spent = 0;
  const directions: ("forward" | "backward")[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const isFinalStep = i === steps.length - 1;

    if (step.kind === "turn") {
      if (jumping) throw new Error("Jumping 'Mechs choose facing freely on landing; no turn steps");
      if (unit.moveMode === "standStill") throw new Error("Standing still forbids facing changes");
      if (!Number.isInteger(step.facings) || step.facings === 0 || Math.abs(step.facings) > 5) {
        throw new Error("Facing change must be 1..5 hexsides in either direction");
      }
      spent += mv.facingChangeCost(Math.abs(step.facings));
      facing = rotateFacing(facing, step.facings);
      continue;
    }

    const to = step.to;
    if (jumping) {
      const jumpInPlace = sameHex(cursor, to);
      if (!isAdjacent(cursor, to) && !(jumpInPlace && spent === 0 && directions.length === 0)) {
        throw new Error("Jump steps must enter an adjacent hex (or jump in place once)");
      }
      spent += 1;
      directions.push("forward");
    } else {
      if (unit.moveMode === "standStill") throw new Error("Standing still forbids entering hexes");
      const forward = mv.isForwardStep(cursor, to, facing);
      const backward = !forward && mv.isBackwardStep(cursor, to, facing);
      if (!forward && !backward) {
        throw new Error("Ground moves must go straight ahead or straight back relative to facing");
      }
      if (backward && unit.moveMode === "run") {
        throw new Error("Running 'Mechs cannot move backward");
      }
      const fromLevel = cellAt(state, cursor).level;
      const toLevel = cellAt(state, to).level;
      const delta = toLevel - fromLevel;
      const illegalChange = forward ? Math.abs(delta) > 2 : delta !== 0;
      if (illegalChange) {
        const slope = delta > 0 ? `${delta} levels higher` : `${-delta} levels lower`;
        throw new Error(
          forward
            ? `Ground moves can change at most 2 levels per hex (${fmtHex(to)} is ${slope})`
            : `Walking backward cannot change level (${fmtHex(to)} is ${slope})`,
        );
      }
      spent += costToEnter(cellAt(state, to).terrain) + costToClimb(fromLevel, toLevel);
      directions.push(forward ? "forward" : "backward");
    }

    const occupant = occupantAt(state, to, unitId);
    if (occupant !== undefined) {
      if (isFinalStep) {
        throw new Error(`Cannot end movement in ${fmtHex(to)}: occupied by ${occupant.id}`);
      }
      if (!jumping && occupant.team !== unit.team) {
        throw new Error(`Cannot move through enemy ${occupant.id} at ${fmtHex(to)}`);
      }
    }

    cursor = { ...to };
  }

  if (spent > budget) {
    throw new Error(`Move costs ${spent} MP but ${unit.moveMode} budget is ${budget}`);
  }
  if (
    steps.length > 0 &&
    !jumping &&
    unit.moveMode !== "standStill" &&
    isUnitImmobile(unit.damage)
  ) {
    throw new Error(`${unitId} has a destroyed leg and cannot move`);
  }

  unit.position = cursor;
  unit.facing = options.finalFacing ?? facing;
  unit.jumpedThisTurn = jumping && steps.length > 0;
  unit.movesThisTurn = directions;
  unit.mpSpent = spent;
  state.actedThisPhase.push(unitId);
  state.events.push({
    kind: "moved",
    unitId,
    mode: unit.moveMode,
    position: { ...cursor },
    facing: unit.facing,
    mpSpent: spent,
    mpBudget: budget,
  });
  const moveHeat = movementHeat(unit.moveMode, spent);
  if (moveHeat > 0) {
    unit.heat = Math.min(HEAT_CAP, unit.heat + moveHeat);
    state.events.push({ kind: "heatMove", unitId, heat: moveHeat });
  }
}

export function declareAttacks(
  state: BattleState,
  unitId: string,
  decls: readonly AttackDecl[],
  rng: Rng = DEFAULT_RNG,
): void {
  requirePhase(state, "weaponAttack");
  const unit = requireUnit(state, unitId);
  if (unit.destroyed || unit.removed) throw new Error(`${unitId} is destroyed`);
  if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot fire`);
  if (unit.declaredAttacks.length > 0)
    throw new Error(`${unitId} already declared attacks this turn`);

  const def = getMechDefFor(unit);
  let targetId: string | null = null;
  let attackDistance = 0;
  let attackRangeBracket: string = "short";
  let attackRangeMod = 0;

  const seenWeapons = new Set<number>();
  const arcs: Record<number, Arc> = {};
  decls.forEach((decl, index) => {
    const mount = def.weapons[decl.weaponIndex];
    if (!mount) throw new Error(`weaponIndex ${decl.weaponIndex} out of range for ${unitId}`);
    const weapon = getWeaponDefFor(mount);

    if (seenWeapons.has(decl.weaponIndex)) {
      throw new Error(`${mount.weapon} on ${unitId} may only be declared once per turn`);
    }
    seenWeapons.add(decl.weaponIndex);

    if (unit.jammedWeapons.includes(decl.weaponIndex)) {
      throw new Error(`${mount.weapon} on ${unitId} is jammed`);
    }
    if (unit.destroyedWeapons.includes(decl.weaponIndex)) {
      throw new Error(`${mount.weapon} on ${unitId} is destroyed by a critical hit`);
    }
    if (!canFireFromLocation(unit.phaseStartDamage, mount.location)) {
      throw new Error(
        `${mount.weapon} location (${mount.location}) is destroyed or its support torso is gone`,
      );
    }

    const rapidFire = decl.rapidFire ?? false;
    if (rapidFire && weapon.rapidFireShots === undefined) {
      throw new Error(`${mount.weapon} is not rapid-fire`);
    }
    const shots = rapidFire ? (weapon.rapidFireShots ?? 1) : 1;

    if (targetId === null) targetId = decl.targetId;
    else if (targetId !== decl.targetId) {
      throw new Error("A unit may only declare attacks against one target per turn");
    }

    const target = requireUnit(state, decl.targetId);
    if (target.removed) throw new Error(`Target ${target.id} is removed from play`);
    if (target.team === unit.team) throw new Error("Target must belong to another team");

    const dist = hexDistance(unit.position, target.position);
    const b = bearing(unit.position, target.position);
    if (b === null) throw new Error("Attacker and target share a hex");
    arcs[decl.weaponIndex] = classifyArc(unit.facing, b);

    const woodsPoints = losWoodsPointsBetween(state, unit.position, target.position);
    if (!losClear(state, unit.position, target.position)) {
      if (losBlockedByBuilding(state, unit.position, target.position)) {
        throw new Error("Line of sight is blocked by intervening building");
      }
      if (losBlockedByElevation(state, unit.position, target.position)) {
        throw new Error("Line of sight is blocked by intervening elevation");
      }
      throw new Error("Line of sight is blocked by intervening woods");
    }

    if (dist > weapon.long) {
      throw new Error(`${mount.weapon}: target at range ${dist} exceeds long range ${weapon.long}`);
    }

    const breakdown = computeToHit({
      gunnery: unit.gunnery,
      attackerMovement: unit.moveMode ?? "standStill",
      targetHexesMoved: target.movesThisTurn.length,
      targetJumped: target.jumpedThisTurn,
      targetImmobile: isImmobile(target),
      targetTerrain: cellAt(state, target.position).terrain,
      targetPartialCover:
        hasPartialCover(cellAt(state, target.position).terrain) &&
        cellAt(state, unit.position).level <= cellAt(state, target.position).level,
      interveningWoods: woodsPoints,
      distance: dist,
      weapon,
      attackerLevel: cellAt(state, unit.position).level,
      targetLevel: cellAt(state, target.position).level,
      heatMod: toHitHeatModifier(unit.heat),
    });
    if (index === 0) {
      attackDistance = dist;
      attackRangeBracket = breakdown.rangeBracket;
      attackRangeMod = breakdown.rangeMod;
    }
    if (breakdown.automatic === "miss") {
      throw new Error(
        `${mount.weapon}: modified TN ${breakdown.total} auto-misses; abort the declaration instead`,
      );
    }

    const needed = weapon.missiles !== undefined ? 1 : shots;
    if (binsForWeapon(def, decl.weaponIndex).length > 0) {
      const left = unit.shotsLeft[decl.weaponIndex] ?? 0;
      if (left < needed) {
        throw new Error(`${mount.weapon}: needs ${needed} shot(s) but only ${left} remain`);
      }
      // Streak launchers fire only on successful to-hit roll: ammo leaves
      // bin at resolution time (see resolveUnitAttacks), not here.
      if (weapon.streak === true) return;
      const entry = consumeAmmo(def, unit.ammoBins, decl.weaponIndex, needed, unit.ammoPolicy, rng);
      unit.ammoBins = entry;
      unit.shotsLeft = ammoWeaponTotals(def, entry);
    }
  });

  if (targetId === null) throw new Error("declareAttacks requires at least one declaration");

  unit.declaredAttacks = decls.map((decl) => {
    const arc = arcs[decl.weaponIndex];
    return arc !== undefined ? { ...decl, arc } : { ...decl };
  });
  unit.firedTargetId = targetId;
  state.actedThisPhase.push(unitId);
  state.events.push({
    kind: "attacksDeclared",
    unitId,
    targetId,
    count: decls.length,
    distance: attackDistance,
    rangeBracket: attackRangeBracket,
    rangeMod: attackRangeMod,
  });
}

function resolveUnitAttacks(
  state: BattleState,
  unit: UnitState,
  rng: Rng,
  phaseStartDamage: Record<string, UnitDamageState>,
): UnitAttackResult {
  const def = getMechDefFor(unit);
  const preHeat = unit.heat;
  let currentAmmoBins = { ...unit.ammoBins };
  let currentShotsLeft = { ...unit.shotsLeft };
  const jammedWeapons: number[] = [];
  const resolutions: UnitAttackResolution[] = [];

  for (const decl of unit.declaredAttacks) {
    const mount = def.weapons[decl.weaponIndex]!;
    const weapon = getWeaponDefFor(mount);
    const target = requireUnit(state, decl.targetId);
    const rapidFire = decl.rapidFire ?? false;
    const shots = rapidFire ? (weapon.rapidFireShots ?? 1) : 1;
    let ammoExhausted = false;

    // Streak launchers share one pool per weapon name and fire only on a
    // hit: an earlier launcher may have drained the pool mid-resolution.
    // With nothing left the launcher cannot fire — auto-miss without
    // touching dice (no ammo spent, no heat).
    if (weapon.streak === true && pooledShotsLeft(def, currentAmmoBins, weapon.name) < 1) {
      ammoExhausted = true;
    }

    const targetPhaseStartDamage = phaseStartDamage[target.id] ?? target.damage;

    const resolution = resolveWeaponAttack({
      rng,
      gunnery: unit.gunnery,
      attackerMoved: unit.moveMode ?? "standStill",
      attackerHeat: preHeat,
      targetHexesMoved: target.movesThisTurn.length,
      targetJumped: target.jumpedThisTurn,
      targetImmobile: isImmobile(target),
      targetTerrain: cellAt(state, target.position).terrain,
      interveningTerrains: interveningTerrains(state, unit.position, target.position),
      distance: hexDistance(unit.position, target.position),
      ...(decl.arc !== undefined ? { arc: decl.arc } : {}),
      weapon: weapon.name,
      ammoExhausted,
      shots,
      targetDamage: targetPhaseStartDamage,
      attackerLevel: cellAt(state, unit.position).level,
      targetLevel: cellAt(state, target.position).level,
      ...(state.critsDisabled
        ? {}
        : {
            targetDef: getMechDefFor(target),
            targetCritSlotsDestroyed: target.critSlotsDestroyed,
            targetDestroyedWeapons: target.destroyedWeapons,
            targetShotsLeft: target.shotsLeft,
            targetAmmoBins: target.ammoBins,
          }),
    });

    // Streak launchers expend one shot only when to-hit succeeds: miss
    // means launcher never fired (no ammo, no heat, no damage).
    const streakFired = weapon.streak === true && resolution.hit;
    if (weapon.streak === true && !resolution.hit) {
      resolutions.push({
        targetId: target.id,
        resolution,
        weaponHeat: 0,
        buildingDamage: 0,
      });
      continue;
    }
    // Draw from the shared weapon-name pool so mounts with no directly
    // linked bins still spend shared ammo. The pre-resolution guard above
    // guarantees at least one shot remains, so this always draws exactly 1.
    if (streakFired) {
      const entry = consumeAmmoForName(def, currentAmmoBins, weapon.name, 1, unit.ammoPolicy, rng);
      currentAmmoBins = entry;
      currentShotsLeft = ammoWeaponTotals(def, entry);
    }

    const weaponHeat = (weapon.heat ?? 0) * shots;

    let buildingDamage = 0;
    if (resolution.hit && resolution.groups.length > 0) {
      buildingDamage = resolution.groups.reduce((acc, g) => acc + g.damage, 0);
    }

    resolutions.push({
      targetId: target.id,
      resolution,
      weaponHeat,
      buildingDamage,
    });

    if (resolution.jammed && !jammedWeapons.includes(decl.weaponIndex)) {
      jammedWeapons.push(decl.weaponIndex);
    }
  }

  return {
    unitId: unit.id,
    resolutions,
    finalAmmoBins: currentAmmoBins,
    finalShotsLeft: currentShotsLeft,
    jammedWeapons,
  };
}

/**
 * Phase-end sweep: resolve every unit's declared attacks simultaneously.
 * All declarations are collected first (during the weapon attack phase),
 * then damage is applied in two phases: collect all resolutions, then
 * apply damage/crits/heat simultaneously. TW resolves weapon attacks
 * simultaneously — a 'Mech killed during the weapon attack phase still
 * fires its declared shots.
 */
export function resolveAllAttacks(state: BattleState, rng: Rng): void {
  requirePhase(state, "weaponAttack");

  // Phase 1: collect resolutions for ALL units with declared attacks
  // (ignore `removed` flag — TW simultaneity means even destroyed units fire)
  const phaseStartDamage: Record<string, UnitDamageState> = {};
  for (const unit of Object.values(state.units)) {
    phaseStartDamage[unit.id] = {
      armor: { ...unit.damage.armor },
      armorRear: { ...unit.damage.armorRear },
      internalStructure: { ...unit.damage.internalStructure },
    };
  }

  const results: UnitAttackResult[] = [];
  for (const unit of Object.values(state.units)) {
    if (unit.declaredAttacks.length === 0) continue;
    results.push(resolveUnitAttacks(state, unit, rng, phaseStartDamage));
  }

  // Phase 2: apply all damage, crits, building damage, and heat simultaneously
  // Track damage per target
  const targetDamageMap: Record<string, UnitDamageState> = {};
  const targetCritsMap: Record<string, CriticalResolution[]> = {};
  const targetAmmoBinsMap: Record<string, Record<AmmoBinId, number>> = {};
  const targetShotsLeftMap: Record<string, Record<number, number>> = {};
  const targetDestroyedWeaponsMap: Record<string, number[]> = {};
  const buildingOutcomes: BuildingDamageResult[] = [];

  for (const result of results) {
    for (const { targetId, resolution, buildingDamage } of result.resolutions) {
      const target = requireUnit(state, targetId);

      // Initialize target accumulators from current state (not phaseStartDamage —
      // we want sequential crit application within the same target)
      if (!targetDamageMap[targetId]) {
        targetDamageMap[targetId] = {
          armor: { ...target.damage.armor },
          armorRear: { ...target.damage.armorRear },
          internalStructure: { ...target.damage.internalStructure },
        };
        targetCritsMap[targetId] = [];
        targetAmmoBinsMap[targetId] = { ...target.ammoBins };
        targetShotsLeftMap[targetId] = { ...target.shotsLeft };
        targetDestroyedWeaponsMap[targetId] = [...target.destroyedWeapons];
      }

      // Apply damage application
      if (resolution.application !== null) {
        targetDamageMap[targetId] = resolution.application.after;
      }

      // Collect crits for later sequential application
      targetCritsMap[targetId]!.push(...resolution.crits);

      // Apply building damage
      if (buildingDamage > 0) {
        const outcome = damageBuildingAt(state, target.position, buildingDamage);
        if (outcome !== null) buildingOutcomes.push(outcome);
      }

      // Emit attackResolved event
      state.events.push({
        kind: "attackResolved",
        unitId: result.unitId,
        targetId,
        resolution,
      });
    }

    // Apply attacker's ammo state changes
    const attacker = requireUnit(state, result.unitId);
    attacker.ammoBins = result.finalAmmoBins;
    attacker.shotsLeft = result.finalShotsLeft;
    for (const wi of result.jammedWeapons) {
      if (!attacker.jammedWeapons.includes(wi)) {
        attacker.jammedWeapons.push(wi);
      }
    }

    // Apply attacker's weapon heat
    const totalWeaponHeat = result.resolutions.reduce((sum, r) => sum + r.weaponHeat, 0);
    if (totalWeaponHeat > 0) {
      const prevHeat = attacker.heat;
      attacker.heat = Math.min(HEAT_CAP, attacker.heat + totalWeaponHeat);
      state.events.push({
        kind: "heatWeapon",
        unitId: attacker.id,
        weapon: result.resolutions[0]?.resolution.weapon ?? "",
        heat: totalWeaponHeat,
        prevHeat,
        currHeat: attacker.heat,
      });
    }
  }

  // Apply crits sequentially per target (each crit sees post-state of previous)
  for (const [targetId, crits] of Object.entries(targetCritsMap)) {
    if (crits.length === 0) continue;
    const target = requireUnit(state, targetId);
    const currentDamage = targetDamageMap[targetId]!;
    let currentCritSlots = { ...target.critSlotsDestroyed };
    let currentDestroyedWeapons = [...(targetDestroyedWeaponsMap[targetId] ?? [])];
    let currentAmmoBins = { ...(targetAmmoBinsMap[targetId] ?? target.ammoBins) };
    let currentShotsLeft = { ...(targetShotsLeftMap[targetId] ?? target.shotsLeft) };

    for (const crit of crits) {
      currentCritSlots = crit.critSlotsDestroyed;
      currentDestroyedWeapons = crit.destroyedWeapons;
      currentAmmoBins = crit.ammoBins;
      currentShotsLeft = crit.shotsLeft;

      // Merge newly destroyed / blown off arms from crit
      for (const arm of crit.blownOffArms) {
        currentDamage.armor[arm] = 0;
        currentDamage.internalStructure[arm] = 0;
      }
    }

    targetDamageMap[targetId] = currentDamage;
    targetCritsMap[targetId] = []; // consumed
    // Update target's persistent crit state
    target.critSlotsDestroyed = currentCritSlots;
    target.destroyedWeapons = currentDestroyedWeapons;
    target.ammoBins = currentAmmoBins;
    target.shotsLeft = currentShotsLeft;
  }

  // Write back final damage to all targets
  for (const [targetId, damage] of Object.entries(targetDamageMap)) {
    const target = requireUnit(state, targetId);
    target.damage = damage;
    // Strip ammo from destroyed locations
    stripDestroyedLocationAmmo(target);
  }

  // Building collapse damage (TW p.176): each occupant takes ceil(CF at the
  // start of the phase / 10), rounded up. Level-1 buildings only — no
  // levels-above multiplier applies. Applied after the write-back so folded
  // attack damage lands first; new `collapseDamage` events stay inside the
  // attack-resolution block.
  for (const outcome of buildingOutcomes) {
    if (!outcome.collapsed) continue;
    const damage = Math.ceil(outcome.preCf / 10);
    for (const unitId of outcome.occupants) {
      const unit = requireUnit(state, unitId);
      const location = hitLocation(roll2D6(rng));
      const application = applyDamage(unit.damage, location, damage);
      unit.damage = application.after;
      state.events.push({
        kind: "collapseDamage",
        unitId,
        col: outcome.col,
        row: outcome.row,
        location,
        damage,
      });
    }
  }

  // Check destruction and mark units
  for (const unit of Object.values(state.units)) {
    if (!unit.destroyed && isUnitDestroyed(unit.damage)) {
      markUnitDestroyed(state, unit);
    }
  }

  // Clear declared attacks for all units
  for (const unit of Object.values(state.units)) {
    unit.declaredAttacks = [];
  }
}

export function advancePhase(state: BattleState, rng: Rng = DEFAULT_RNG): void {
  state.actorQueue = null;
  switch (state.phase) {
    case "initiative": {
      if (state.initiativeWinnerTeam === null) {
        throw new Error("Roll initiative before leaving the initiative phase");
      }
      state.phase = "movement";
      break;
    }
    case "movement": {
      state.phase = "weaponAttack";
      for (const unit of Object.values(state.units)) {
        unit.phaseStartDamage = {
          armor: { ...unit.damage.armor },
          armorRear: { ...unit.damage.armorRear },
          internalStructure: { ...unit.damage.internalStructure },
        };
      }
      state.actedThisPhase = [];
      break;
    }
    case "weaponAttack": {
      for (const unit of Object.values(state.units)) {
        if (!unit.destroyed && isUnitDestroyed(unit.damage)) {
          markUnitDestroyed(state, unit);
        }
      }
      // The end phase starts with heat resolution: engine crit heat,
      // shutdown/restart checks, heat ammo explosions, then dissipation.
      resolveHeatPhase(state, rng);
      state.phase = "end";
      break;
    }
    case "end": {
      state.turn += 1;
      state.initiativeWinnerTeam = null;
      state.phase = "initiative";
      state.actedThisPhase = [];
      for (const unit of Object.values(state.units)) {
        unit.moveMode = null;
        unit.movesThisTurn = [];
        unit.jumpedThisTurn = false;
        unit.mpSpent = 0;
        unit.declaredAttacks = [];
        unit.firedTargetId = null;
        unit.passedAttacks = false;
        // A successful voluntary startup comes online just before the next
        // initiative roll.
        if (unit.shutdown === "starting") unit.shutdown = "not";
      }
      state.events.push({ kind: "turn", turn: state.turn });
      break;
    }
  }

  state.events.push({ kind: "phase", phase: state.phase });
}

/**
 * Run one turn's heat resolution as the weapon attack phase hands off to the
 * end phase: engine crit heat on top of the turn's accumulated movement and
 * weapon heat, then shutdown/restart and heat ammo explosion checks at peak
 * heat, and finally dissipation against the operational heat-sink count.
 */
export function resolveHeatPhase(state: BattleState, rng: Rng): void {
  const units = Object.values(state.units).filter((u) => !u.removed);

  // Engine crit heat: +5 per damaged engine slot (flat once the second slot
  // is gone, acting as +5 per hit) per turn, stacking on remaining heat.
  for (const unit of units) {
    const def = getMechDefFor(unit);
    const heat = engineHitHeat(countDestroyedEngineSlots(def, unit.critSlotsDestroyed));
    if (heat > 0) {
      const prevHeat = unit.heat;
      unit.heat = Math.min(HEAT_CAP, unit.heat + heat);
      state.events.push({
        kind: "heatEngineCrit",
        unitId: unit.id,
        heat,
        prevHeat,
        currHeat: unit.heat,
      });
    }
  }

  // Shutdown / restart: heat 30+ shuts down automatically; otherwise roll 2D6
  // against the avoidance number when the Heat Scale is in shutdown range.
  // Only a heat-caused shutdown ("heat") restarts automatically once heat is
  // back below the shutdown threshold (or succeeds its avoidance roll). A
  // manually shut-down unit ("manual") stays off-line until a voluntary
  // startup roll succeeds, and a pending startup ("starting") is untouched
  // here — it comes online at the next initiative roll. Checked at peak heat,
  // before sinks dissipate.
  for (const unit of units) {
    const heat = unit.heat;
    if (unit.shutdown === "manual" || unit.shutdown === "starting") continue;
    const { avoid, threshold } = shutdownAvoidWithThreshold(heat);
    if (avoid >= 12) {
      // avoid exceeds 2D6 max, always
      unit.shutdown = "heat";
      state.events.push({
        kind: "shutdownCheck",
        unitId: unit.id,
        avoided: false,
        manual: false,
        roll: 0,
        heat,
        avoid,
        threshold,
      });
      continue;
    }
    if (avoid === 0) {
      // no check needed
      if (unit.shutdown === "heat") {
        unit.shutdown = "not";
        state.events.push({
          kind: "restartCheck",
          unitId: unit.id,
          success: true,
          manual: false,
          roll: 0,
          heat,
          avoid: 0,
          threshold,
        });
      }
      continue;
    }
    const roll = roll2D6(rng);
    if (unit.shutdown === "heat") {
      if (roll <= avoid) {
        // Remains off-line; try again next end phase.
        state.events.push({
          kind: "restartCheck",
          unitId: unit.id,
          success: false,
          manual: false,
          roll,
          heat,
          avoid,
          threshold,
        });
      } else {
        unit.shutdown = "not";
        state.events.push({
          kind: "restartCheck",
          unitId: unit.id,
          success: true,
          manual: false,
          roll,
          heat,
          avoid,
          threshold,
        });
      }
    } else {
      if (roll <= avoid) {
        unit.shutdown = "heat";
        state.events.push({
          kind: "shutdownCheck",
          unitId: unit.id,
          avoided: false,
          manual: false,
          roll,
          heat,
          avoid,
          threshold,
        });
      } else {
        state.events.push({
          kind: "shutdownCheck",
          unitId: unit.id,
          avoided: true,
          manual: false,
          roll,
          heat,
          avoid,
          threshold,
        });
      }
    }
  }

  // Heat ammo explosions: at heat 19+ the largest loaded bin can detonate if
  // the avoidance roll fails. The bin explodes against its location's
  // internal structure (armor bypassed), cascading normally. Every bin of the
  // detonating weapon mount is emptied.
  for (const unit of units) {
    const heat = unit.heat;
    const { avoid, threshold } = ammoExplosionAvoidWithThreshold(heat)!;
    if (avoid === 0) continue;
    const def = getMechDefFor(unit);
    const bin = largestAmmoBin(def, unit.ammoBins);
    if (bin === null) continue;
    const roll = roll2D6(rng);
    if (roll >= avoid) {
      state.events.push({
        kind: "ammoExplosionCheck",
        unitId: unit.id,
        weapon: bin.weapon,
        location: bin.location,
        slotIndex: bin.slotIndex,
        roll,
        heat,
        avoid,
        threshold,
        shotsRemaining: bin.shotsRemaining,
        damage: bin.damage,
        avoided: true,
      });
      continue;
    }
    const application = applyAmmoExplosion(
      unit.damage,
      bin.location,
      bin.damage,
      checkCASE(def, bin.location),
    );
    unit.damage = application.after;
    for (const loc of LOCATIONS) {
      if ((unit.damage.internalStructure[loc] ?? 0) <= 0) {
        stripBinsInLocation(unit.ammoBins, loc);
      }
    }
    // Detonated magazines read as empty (0), like a bin drained by firing;
    // bins removed by the strip above belonged to destroyed locations only.
    for (const binId of bin.binIds) unit.ammoBins[binId] = 0;
    unit.shotsLeft = ammoWeaponTotals(def, unit.ammoBins);
    state.events.push({
      kind: "ammoExplosionCheck",
      unitId: unit.id,
      weapon: bin.weapon,
      location: bin.location,
      slotIndex: bin.slotIndex,
      roll,
      heat,
      avoid,
      threshold,
      shotsRemaining: bin.shotsRemaining,
      damage: bin.damage,
      avoided: false,
    });
    if (!unit.destroyed && isUnitDestroyed(unit.damage)) {
      markUnitDestroyed(state, unit);
    }
  }

  // Dissipation: each operational heat sink removes 1 heat point.
  for (const unit of units) {
    if (unit.destroyed) continue; // stop tracking heat for destroyed unit
    const def = getMechDefFor(unit);
    const prevHeat = unit.heat;
    const capacity = heatDissipation(def, unit.critSlotsDestroyed);
    const dissipated = Math.min(capacity, prevHeat);
    unit.heat -= dissipated;
    if (dissipated > 0) {
      state.events.push({
        kind: "heatDissipated",
        unitId: unit.id,
        dissip: dissipated,
        prevHeat,
        currHeat: unit.heat,
        capacity,
      });
    }
  }
}

/** Voluntary shutdown declaration, resolved during the movement phase: the
 *  unit goes off-line ("manual") immediately and stays down until a
 *  successful voluntary startup. Marks the unit as having acted. */
export function voluntaryShutdown(state: BattleState, unitId: string): void {
  requirePhase(state, "movement");
  const unit = requireUnit(state, unitId);
  if (unit.removed) throw new Error(`${unitId} is removed from play`);
  if (isShutdown(unit)) throw new Error(`${unitId} is already shut down`);
  unit.shutdown = "manual";
  state.actedThisPhase.push(unitId);
  state.events.push({
    kind: "shutdownCheck",
    unitId,
    avoided: false,
    manual: true,
    roll: 0,
    heat: unit.heat,
    avoid: 0,
    threshold: 0,
  });
}

/** Voluntary startup attempt, resolved during the movement phase: roll 2D6
 *  against the shutdown avoidance number at the current heat. On success the
 *  unit enters "starting" — still off-line, but it comes online just before
 *  the next initiative roll. On failure it remains shut down. Marks the unit
 *  as having acted either way. */
export function attemptVoluntaryStartup(
  state: BattleState,
  unitId: string,
  rng: Rng = DEFAULT_RNG,
): void {
  requirePhase(state, "movement");
  const unit = requireUnit(state, unitId);
  if (unit.removed) throw new Error(`${unitId} is removed from play`);
  if (isNominal(unit)) throw new Error(`${unitId} is not shut down`);
  if (unit.shutdown === "starting") throw new Error(`${unitId} is already starting up`);
  const heat = unit.heat;
  const avoid = shutdownAvoid(heat);
  const roll = avoid === 0 ? 0 : roll2D6(rng);
  state.actedThisPhase.push(unitId);
  if (roll >= avoid) {
    unit.shutdown = "starting";
    state.events.push({
      kind: "restartCheck",
      unitId,
      success: true,
      manual: true,
      roll,
      heat,
      avoid,
      threshold: 0,
    });
  } else {
    state.events.push({
      kind: "restartCheck",
      unitId,
      success: false,
      manual: true,
      roll,
      heat,
      avoid,
      threshold: 0,
    });
  }
}

/** Movement-phase pass for a shut-down unit that attempts no startup: it
 *  stays off-line and is marked as having acted. */
export function passMovement(state: BattleState, unitId: string): void {
  requirePhase(state, "movement");
  const unit = requireUnit(state, unitId);
  if (unit.removed) throw new Error(`${unitId} is removed from play`);
  if (isNominal(unit)) throw new Error(`${unitId} is not shut down`);
  state.actedThisPhase.push(unitId);
}

/** Suggest which unit must act next (initiative loser alternates first). */
export function nextActor(state: BattleState): string | null {
  if (state.phase !== "movement" && state.phase !== "weaponAttack") return null;
  if (state.initiativeWinnerTeam === null) return null;
  return pendingActors(state)[0] ?? null;
}

export interface ActorQueueActorView {
  readonly id: string;
  readonly team: number;
  readonly hasPriority: boolean;
}
export interface ActorQueueView {
  readonly initiative: number | null;
  readonly acted: ActorQueueActorView[];
  readonly pending: ActorQueueActorView[];
  readonly removed: ActorQueueActorView[];
}

function actorToQueueView(actor: UnitState, forcePriority?: boolean): ActorQueueActorView {
  return {
    id: actor.id,
    team: actor.team,
    hasPriority: forcePriority ?? (actor.shutdown === "manual" || actor.shutdown === "heat"),
  };
}

/** Who already acted this phase, and the ordered queue of who must still act. */
export function actorQueue(state: BattleState): ActorQueueView {
  if (
    (state.phase !== "movement" && state.phase !== "weaponAttack") ||
    state.initiativeWinnerTeam === null
  ) {
    return { initiative: state.initiativeWinnerTeam, acted: [], pending: [], removed: [] };
  }
  const alive = new Map<string, UnitState>();
  const removed: ActorQueueActorView[] = [];
  for (const u of Object.values(state.units)) {
    if (u.removed) {
      removed.push(actorToQueueView(u, false));
      continue;
    }
    alive.set(u.id, u);
  }
  // const acted = state.actedThisPhase.filter((id) => alive.has(id));
  return {
    initiative: state.initiativeWinnerTeam,
    acted: state.actedThisPhase
      .map((id) => {
        const actor = alive.get(id);
        return actor !== undefined ? actorToQueueView(actor) : null;
      })
      .filter((av) => av !== null),
    pending: pendingActors(state).map((id) => actorToQueueView(state.units[id]!)),
    removed,
  };
}

/** Units still to act this phase, in activation order (cached per phase). */
function pendingActors(state: BattleState): string[] {
  if (state.actorQueue === null) state.actorQueue = buildActorQueue(state);
  const nominalOnly = state.phase === "weaponAttack";
  return state.actorQueue.filter((id) => {
    const unit = state.units[id];
    if (!unit || unit.removed) return false;
    if (state.actedThisPhase.includes(id)) return false;
    if (unit.passedAttacks) return false;
    if (nominalOnly && !isNominal(unit)) return false;
    return true;
  });
}

/** Full activation order for the current phase: movement phases front-load
 *  shut-down units (they can only attempt startup or pass); both phases then
 *  alternate initiative-loser-first, letting the larger team act
 *  ⌊size/minSize⌋ units per step (TW unequal-force activation). */
function buildActorQueue(state: BattleState): string[] {
  const alive = Object.values(state.units).filter((u) => !u.removed);
  const teams = [...new Set(alive.map((u) => u.team))];
  if (teams.length === 0 || state.initiativeWinnerTeam === null) return [];
  const winner = state.initiativeWinnerTeam;
  const loser = teams.find((t) => t !== winner) ?? winner;
  const order = loser === winner ? teams : [loser, ...teams.filter((t) => t !== loser)];

  const sizeByTeam = new Map<number, number>();
  for (const u of alive) sizeByTeam.set(u.team, (sizeByTeam.get(u.team) ?? 0) + 1);
  const minSize = Math.min(...teams.map((t) => sizeByTeam.get(t) ?? 0));
  const unitsPerStep = (team: number): number => {
    const size = sizeByTeam.get(team) ?? 0;
    if (size === 0 || minSize === 0) return 1;
    return Math.max(1, Math.floor(size / minSize));
  };

  const downIds = new Set<string>();
  if (state.phase === "movement") {
    for (const u of alive) if (isShutdown(u)) downIds.add(u.id);
  }

  // Number of units already "placed" per team, including down units that were
  // front-loaded; the alternating order is replayed from these counts.
  const placed = new Map<number, number>();
  for (const t of teams) placed.set(t, 0);

  const queue: string[] = [];
  const downOf = alive.filter((u) => downIds.has(u.id));
  for (const u of downOf) {
    queue.push(u.id);
    placed.set(u.team, (placed.get(u.team) ?? 0) + 1);
  }

  const stepNumber = (team: number): number =>
    Math.floor((placed.get(team) ?? 0) / unitsPerStep(team));

  const nominal = alive.filter((u) => !downIds.has(u.id));
  const nextIndex = new Map<number, number>();
  for (const t of teams) nextIndex.set(t, 0);

  while (queue.length < alive.length) {
    const pick = order
      .map((team) => ({ team, step: stepNumber(team) }))
      .sort((a, b) => {
        if (a.step !== b.step) return a.step - b.step;
        return a.team === loser ? -1 : b.team === loser ? 1 : 0;
      })
      .map((entry) => entry.team)[0]!;
    const idx = nextIndex.get(pick) ?? 0;
    const unit = nominal.filter((u) => u.team === pick)[idx];
    if (!unit) break;
    queue.push(unit.id);
    placed.set(pick, (placed.get(pick) ?? 0) + 1);
    nextIndex.set(pick, idx + 1);
  }
  return queue;
}

export interface VictoryResult {
  readonly winnerTeam: number | null;
  readonly draw: boolean;
}

export function checkVictory(state: BattleState): VictoryResult {
  const aliveTeams = new Set(
    Object.values(state.units)
      .filter((u) => !u.removed)
      .map((u) => u.team),
  );
  if (aliveTeams.size <= 1) {
    return { winnerTeam: aliveTeams.values().next().value ?? null, draw: aliveTeams.size === 0 };
  }
  return { winnerTeam: null, draw: false };
}

export function getUnit(state: BattleState, unitId: string): UnitState {
  return requireUnit(state, unitId);
}

/** Build the per-slot destroyed-flag table for a fresh unit, all false. */
function initCritDestroyed(def: ResolvedMechDef): Record<Location, boolean[]> {
  const out: Record<Location, boolean[]> = {} as Record<Location, boolean[]>;
  for (const loc of Object.keys(def.critSlots) as Location[]) {
    out[loc] = new Array(def.critSlots[loc].length).fill(false);
  }
  return out;
}

/**
 * Remove every ammo bin in a location whose internal structure has dropped to
 * zero (blown-off limbs, destroyed torsos), then refresh the derived per-weapon
 * totals so out-of-ammo checks and the record sheet stay accurate.
 */
function stripDestroyedLocationAmmo(target: UnitState): void {
  const def = getMechDefFor(target);
  for (const loc of LOCATIONS) {
    if ((target.damage.internalStructure[loc] ?? 0) <= 0) {
      stripBinsInLocation(target.ammoBins, loc);
    }
  }
  target.shotsLeft = ammoWeaponTotals(def, target.ammoBins);
}
