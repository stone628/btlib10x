import { roll2D6 } from "../core/dice.js";
import { bearing, hexDistance, isAdjacent, sameHex } from "../core/hex.js";
import { cellAt, costToClimb, costToEnter, type HexGrid } from "../core/terrain.js";
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
import { getMechDef, getMechDefFor, type MechModelHolder } from "../data/index.js";
import type { ResolvedMechDef } from "../data/mech.schema.js";
import { getWeaponDefFor } from "../data/weapon.schema.js";
import {
  type AmmoBinId,
  type AmmoPolicy,
  ammoWeaponTotals,
  binsForWeapon,
  consumeAmmo,
  loadAmmoBins,
  stripBinsInLocation,
} from "./ammo.js";
import { isInFrontArc } from "./arcs.js";
import { type AttackResolution, resolveWeaponAttack } from "./attack.js";
import {
  type BuildingState,
  buildingTypeOf,
  collapseToRubble,
  createBuildingState,
} from "./building.js";
import { applyAmmoExplosion, effectiveMovement } from "./critical.js";
import {
  canFireFromLocation,
  isImmobile,
  isUnitDestroyed,
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
import { rollInitiative } from "./initiative.js";
import {
  interveningTerrains,
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
    }
  | {
      readonly kind: "shutdown";
      readonly unitId: string;
      readonly roll: number;
      readonly heat: number;
      readonly avoid: number;
      readonly threshold: number;
    }
  | {
      readonly kind: "shutdownAuto";
      readonly unitId: string;
      readonly heat: number;
      readonly threshold: number;
    }
  | {
      readonly kind: "shutdownAvoided";
      readonly unitId: string;
      readonly roll: number;
      readonly heat: number;
      readonly avoid: number;
      readonly threshold: number;
    }
  | {
      readonly kind: "restarted";
      readonly unitId: string;
      readonly roll: number;
      readonly heat: number;
      readonly avoid: number;
      readonly threshold: number;
    }
  | { readonly kind: "shutdownManual"; readonly unitId: string }
  | { readonly kind: "shutdownPriority"; readonly unitId: string }
  | {
      readonly kind: "startupSuccess";
      readonly unitId: string;
      readonly roll: number;
      readonly heat: number;
      readonly avoid: number;
    }
  | {
      readonly kind: "startupFailed";
      readonly unitId: string;
      readonly roll: number;
      readonly heat: number;
      readonly avoid: number;
    }
  | {
      readonly kind: "heatAmmoExplosion";
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
    };

export interface BattleState extends HexGrid {
  turn: number;
  phase: Phase;
  initiativeWinnerTeam: number | null;
  units: Record<string, UnitState>;
  /** When true, critical hit resolution is suppressed at attack time. */
  critsDisabled: boolean;
  actedThisPhase: string[];
  events: GameEvent[];
  /** Building state keyed by hex `"col,row"`; only building hexes present. */
  buildings: Record<string, BuildingState>;
}

export type { TerrainHexDef };

export interface CreateBattleOptions {
  /** Non-clear hexes; anything not listed is clear terrain. */
  readonly terrain: readonly TerrainHexDef[];
  /** Board size, in engine coordinates (columns/rows). */
  readonly width: number;
  readonly height: number;
  /**
   * Disable critical hit resolution. Tests that script dice for narrow
   * damage scenarios (where any crit would alter the expected outcome) can
   * set this to `true` so the engine follows the scripted RNG only for the
   * attack and location rolls.
   */
  readonly critsDisabled: boolean;
}

function getUnitOrThrow(state: BattleState, unitId: string): UnitState {
  const unit = state.units[unitId];
  if (!unit) throw new Error(`Unknown unit id: ${unitId}`);
  return unit;
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

  for (const [label, n] of [
    ["width", options.width],
    ["height", options.height],
  ] as const) {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`Board ${label} must be an integer >= 1`);
    }
  }

  const { width, height } = options;
  const cells: HexCell[] = new Array<HexCell>(width * height).fill({
    terrain: "clear",
    level: 0,
  });
  const terrainSeen = new Set<string>();
  const buildings: Record<string, BuildingState> = {};
  for (const { col, row, type, level } of options.terrain) {
    const key = `${col},${row}`;
    if (terrainSeen.has(key))
      throw new Error(`Duplicate terrain definition for hex ${fmtHex({ col, row })}`);
    terrainSeen.add(key);
    cells[col - 1 + (row - 1) * width] = { terrain: type, level: level ?? 0 };
    const bt = buildingTypeOf(type);
    if (bt !== undefined) buildings[key] = createBuildingState(bt);
  }

  return {
    turn: 1,
    phase: "initiative",
    initiativeWinnerTeam: null,
    units: unitStates,
    cells,
    width,
    height,
    critsDisabled: options.critsDisabled,
    actedThisPhase: [],
    events: [{ kind: "turn", turn: 1 }],
    buildings,
  };
}

/**
 * Apply weapon damage to the building occupying a hex, collapsing it to rubble
 * when its structural factor reaches zero. Emits a `buildingCollapsed` event on
 * collapse. Returns the event, or `null` when the hex has no building.
 */
export function damageBuildingAt(
  state: BattleState,
  hex: HexCoord,
  damage: number,
): { readonly kind: "buildingCollapsed"; readonly col: number; readonly row: number } | null {
  const key = `${hex.col},${hex.row}`;
  const building = state.buildings[key];
  if (building === undefined) return null;
  const cf = Math.max(0, building.cf - damage);
  building.cf = cf;
  if (cf <= 0) {
    const cell = state.cells[hex.col - 1 + (hex.row - 1) * state.width]!;
    collapseToRubble(cell);
    delete state.buildings[key];
    const event = { kind: "buildingCollapsed", col: hex.col, row: hex.row } as const;
    state.events.push(event);
    return event;
  }
  return null;
}

export function rollInitiativePhase(state: BattleState, rng: Rng): void {
  requirePhase(state, "initiative");
  const teams = [...new Set(Object.values(state.units).map((u) => u.team))];
  const result = rollInitiative(teams, rng);
  state.initiativeWinnerTeam = result.winnerTeam;
  state.phase = "movement";
  state.events.push(
    { kind: "initiative", rolls: result.rolls, winnerTeam: result.winnerTeam },
    { kind: "phase", phase: "movement" },
  );
}

export function declareMove(state: BattleState, unitId: string, mode: MoveMode): void {
  requirePhase(state, "movement");
  const unit = getUnitOrThrow(state, unitId);
  if (unit.removed) throw new Error(`${unitId} is removed from play`);
  if (unit.shutdown !== "not") throw new Error(`${unitId} is shut down and cannot move`);
  if (mode !== "standStill" && isImmobile(unit.damage)) {
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
  const unit = getUnitOrThrow(state, unitId);
  if (unit.moveMode === null) throw new Error(`Declare a movement mode for ${unitId} first`);
  if (unit.removed) throw new Error(`${unitId} is removed from play`);
  if (unit.shutdown !== "not") throw new Error(`${unitId} is shut down and cannot move`);

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
      if (toLevel - fromLevel > 1) {
        throw new Error(
          `Ground moves can climb at most 1 level per hex (${fmtHex(to)} is ${toLevel - fromLevel} levels higher)`,
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
  if (steps.length > 0 && !jumping && unit.moveMode !== "standStill" && isImmobile(unit.damage)) {
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
  const unit = getUnitOrThrow(state, unitId);
  if (unit.destroyed || unit.removed) throw new Error(`${unitId} is destroyed`);
  if (unit.shutdown !== "not") throw new Error(`${unitId} is shut down and cannot fire`);
  if (unit.declaredAttacks.length > 0)
    throw new Error(`${unitId} already declared attacks this turn`);

  const def = getMechDefFor(unit);
  let targetId: string | null = null;
  let attackDistance = 0;
  let attackRangeBracket: string = "short";
  let attackRangeMod = 0;

  const seenWeapons = new Set<number>();
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

    const target = getUnitOrThrow(state, decl.targetId);
    if (target.removed) throw new Error(`Target ${target.id} is removed from play`);
    if (target.team === unit.team) throw new Error("Target must belong to another team");

    const dist = hexDistance(unit.position, target.position);
    const b = bearing(unit.position, target.position);
    if (b === null) throw new Error("Attacker and target share a hex");
    if (!isInFrontArc(unit.facing, b)) {
      throw new Error(`${mount.weapon}: target not in front firing arc`);
    }

    const woodsPoints = losWoodsPointsBetween(state, unit.position, target.position);
    if (!losClear(state, unit.position, target.position)) {
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
      targetHexesMoved: mv.hexesSinceLastReversal(target.movesThisTurn),
      targetJumped: target.jumpedThisTurn,
      targetTerrain: cellAt(state, target.position).terrain,
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
      const entry = consumeAmmo(def, unit.ammoBins, decl.weaponIndex, needed, unit.ammoPolicy, rng);
      unit.ammoBins = entry;
      unit.shotsLeft = ammoWeaponTotals(def, entry);
    }
  });

  if (targetId === null) throw new Error("declareAttacks requires at least one declaration");

  unit.declaredAttacks = [...decls];
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

function resolveUnitAttacks(state: BattleState, unit: UnitState, rng: Rng): void {
  const def = getMechDefFor(unit);
  const preHeat = unit.heat;

  for (const decl of unit.declaredAttacks) {
    const mount = def.weapons[decl.weaponIndex]!;
    const weapon = getWeaponDefFor(mount);
    const target = getUnitOrThrow(state, decl.targetId);
    const rapidFire = decl.rapidFire ?? false;
    const shots = rapidFire ? (weapon.rapidFireShots ?? 1) : 1;

    const resolution = resolveWeaponAttack({
      rng,
      gunnery: unit.gunnery,
      attackerMoved: unit.moveMode ?? "standStill",
      attackerHeat: preHeat,
      targetHexesMoved: mv.hexesSinceLastReversal(target.movesThisTurn),
      targetJumped: target.jumpedThisTurn,
      targetTerrain: cellAt(state, target.position).terrain,
      interveningTerrains: interveningTerrains(state, unit.position, target.position),
      distance: hexDistance(unit.position, target.position),
      weapon: weapon.name,
      shots,
      targetDamage: target.damage,
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

    if (resolution.application !== null) target.damage = resolution.application.after;
    if (resolution.jammed && !unit.jammedWeapons.includes(decl.weaponIndex)) {
      unit.jammedWeapons.push(decl.weaponIndex);
    }

    // Weapon damage that lands on a unit standing in a building hex is also
    // applied to the building's structural factor (total damage that hit).
    if (resolution.hit && resolution.groups.length > 0) {
      const total = resolution.groups.reduce((acc, g) => acc + g.damage, 0);
      damageBuildingAt(state, target.position, total);
    }

    // Commit crit results: each crit rolls for a location that lost IS, and
    // its snapshot of destroyed slots, destroyed weapons, ammo, and damage
    // state must be merged into the target's persistent state. Crits
    // accumulate in the order they were resolved (each successive crit
    // sees the post-state of the previous one because resolveWeaponAttack
    // already threads the updated state through its per-group loop).
    if (resolution.crits.length > 0) {
      const last = resolution.crits[resolution.crits.length - 1]!;
      target.critSlotsDestroyed = last.critSlotsDestroyed;
      target.destroyedWeapons = last.destroyedWeapons;
      target.ammoBins = last.ammoBins;
      target.shotsLeft = last.shotsLeft;
      // Damage was already committed above (it includes the explosion
      // cascades); the crit rows also include newlyDestroyed /
      // blownOffArms contributions that the per-group application didn't
      // account for, so merge them.
      for (const crit of resolution.crits) {
        for (const arm of crit.blownOffArms) {
          if (!target.destroyed) {
            // arms blown off by crit -> zero the arm
            target.damage.armor[arm] = 0;
            target.damage.internalStructure[arm] = 0;
          }
        }
      }
    }

    // Ammo in any location whose internal structure is gone (blown off,
    // transferred away, or drained by this attack) can no longer explode.
    stripDestroyedLocationAmmo(target);

    state.events.push({
      kind: "attackResolved",
      unitId: unit.id,
      targetId: target.id,
      resolution,
    });

    if (!target.destroyed && isUnitDestroyed(target.damage)) {
      markUnitDestroyed(state, target);
    }

    // Weapon heat is committed here so the Heat Scale reflects it from next
    // turn onward (this turn's to-hit roll already used the pre-fire heat).
    const weaponHeat = (weapon.heat ?? 0) * shots;
    if (weaponHeat > 0) {
      const prevHeat = unit.heat;
      unit.heat = Math.min(HEAT_CAP, unit.heat + weaponHeat);
      state.events.push({
        kind: "heatWeapon",
        unitId: unit.id,
        weapon: weapon.name,
        heat: weaponHeat,
        prevHeat,
        currHeat: unit.heat,
      });
    }
  }

  unit.declaredAttacks = [];
}

/** Resolve one unit's declared attacks against the current phase snapshot. */
export function resolveDeclaredAttacks(state: BattleState, unitId: string, rng: Rng): void {
  requirePhase(state, "weaponAttack");
  const unit = getUnitOrThrow(state, unitId);
  if (unit.declaredAttacks.length === 0) throw new Error(`${unitId} has no declared attacks`);
  resolveUnitAttacks(state, unit, rng);
}

/**
 * Phase-end sweep: resolve every unit's declared attacks together, then remove
 * the destroyed. All declarations are collected first (during the weapon attack
 * phase), so damage is applied only after every unit has declared.
 */
export function resolveAllAttacks(state: BattleState, rng: Rng): void {
  requirePhase(state, "weaponAttack");
  for (const unit of Object.values(state.units)) {
    if (unit.removed) continue;
    if (unit.declaredAttacks.length === 0) continue;
    resolveUnitAttacks(state, unit, rng);
  }
}

export function advancePhase(state: BattleState, rng: Rng = DEFAULT_RNG): void {
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
      state.events.push({ kind: "shutdownAuto", unitId: unit.id, heat, threshold });
      continue;
    }
    if (avoid === 0) {
      // no check needed
      if (unit.shutdown === "heat") {
        unit.shutdown = "not";
        state.events.push({
          kind: "restarted",
          unitId: unit.id,
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
        state.events.push({ kind: "shutdown", unitId: unit.id, roll, heat, avoid, threshold });
      } else {
        unit.shutdown = "not";
        state.events.push({ kind: "restarted", unitId: unit.id, roll, heat, avoid, threshold });
      }
    } else {
      if (roll <= avoid) {
        unit.shutdown = "heat";
        state.events.push({ kind: "shutdown", unitId: unit.id, roll, heat, avoid, threshold });
      } else {
        state.events.push({
          kind: "shutdownAvoided",
          unitId: unit.id,
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
    if (roll >= avoid) continue;
    const application = applyAmmoExplosion(unit.damage, bin.location, bin.damage);
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
      kind: "heatAmmoExplosion",
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
    const dissipated = Math.min(heatDissipation(def, unit.critSlotsDestroyed), unit.heat);
    unit.heat -= dissipated;
    if (dissipated > 0) {
      state.events.push({
        kind: "heatDissipated",
        unitId: unit.id,
        dissip: dissipated,
        prevHeat,
        currHeat: unit.heat,
      });
    }
  }
}

/** Voluntary shutdown declaration, resolved during the movement phase: the
 *  unit goes off-line ("manual") immediately and stays down until a
 *  successful voluntary startup. Marks the unit as having acted. */
export function voluntaryShutdown(state: BattleState, unitId: string): void {
  requirePhase(state, "movement");
  const unit = getUnitOrThrow(state, unitId);
  if (unit.removed) throw new Error(`${unitId} is removed from play`);
  if (unit.shutdown !== "not") throw new Error(`${unitId} is already shut down`);
  unit.shutdown = "manual";
  state.actedThisPhase.push(unitId);
  state.events.push({ kind: "shutdownManual", unitId });
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
  const unit = getUnitOrThrow(state, unitId);
  if (unit.removed) throw new Error(`${unitId} is removed from play`);
  if (unit.shutdown === "not") throw new Error(`${unitId} is not shut down`);
  if (unit.shutdown === "starting") throw new Error(`${unitId} is already starting up`);
  const heat = unit.heat;
  const avoid = shutdownAvoid(heat);
  const roll = avoid === 0 ? 0 : roll2D6(rng);
  state.actedThisPhase.push(unitId);
  if (roll >= avoid) {
    unit.shutdown = "starting";
    state.events.push({ kind: "startupSuccess", unitId, roll, heat, avoid });
  } else {
    state.events.push({ kind: "startupFailed", unitId, roll, heat, avoid });
  }
}

/** Movement-phase pass for a shut-down unit that attempts no startup: it
 *  stays off-line and is marked as having acted. */
export function passMovement(state: BattleState, unitId: string): void {
  requirePhase(state, "movement");
  const unit = getUnitOrThrow(state, unitId);
  if (unit.removed) throw new Error(`${unitId} is removed from play`);
  if (unit.shutdown === "not") throw new Error(`${unitId} is not shut down`);
  state.actedThisPhase.push(unitId);
}

/** Suggest which unit must act next (initiative loser alternates first). */
export function nextActor(state: BattleState): string | null {
  if (state.phase !== "movement" && state.phase !== "weaponAttack") return null;
  if (state.initiativeWinnerTeam === null) return null;
  const alive = Object.values(state.units).filter((u) => !u.removed);
  // Shut-down units act first during the movement phase regardless of
  // initiative: they can only attempt startup (or pass) and must not wait.
  if (state.phase === "movement") {
    const down = alive.find((u) => u.shutdown !== "not" && !state.actedThisPhase.includes(u.id));
    if (down) return down.id;
  }
  const teams = [...new Set(alive.map((u) => u.team))];
  if (teams.length === 0) return null;
  const winner = state.initiativeWinnerTeam;
  const loser = teams.find((t) => t !== winner) ?? winner;
  const order = loser === winner ? teams : [loser, ...teams.filter((t) => t !== loser)];

  const sizeByTeam = new Map<number, number>();
  for (const u of alive) sizeByTeam.set(u.team, (sizeByTeam.get(u.team) ?? 0) + 1);

  const minSize = Math.min(...teams.map((t) => sizeByTeam.get(t) ?? 0));

  const actedCount = (team: number): number =>
    alive.filter((u) => u.team === team && state.actedThisPhase.includes(u.id)).length;

  const unitsPerStep = (team: number): number => {
    const size = sizeByTeam.get(team) ?? 0;
    if (size === 0 || minSize === 0) return 1;
    return Math.max(1, Math.floor(size / minSize));
  };

  const stepNumber = (team: number): number => {
    const ups = unitsPerStep(team);
    return Math.floor(actedCount(team) / ups);
  };

  const sorted = order
    .map((team) => ({ team, step: stepNumber(team) }))
    .sort((a, b) => {
      if (a.step !== b.step) return a.step - b.step;
      return a.team === loser ? -1 : b.team === loser ? 1 : 0;
    })
    .map((entry) => entry.team);
  for (const team of sorted) {
    const candidate = alive.find(
      (u) =>
        u.team === team &&
        !state.actedThisPhase.includes(u.id) &&
        !u.passedAttacks &&
        u.shutdown === "not",
    );
    if (candidate) return candidate.id;
  }
  return null;
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
  return getUnitOrThrow(state, unitId);
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
