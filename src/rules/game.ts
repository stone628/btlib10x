import { bearing, hexDistance, isAdjacent, sameHex } from "../core/hex.js";
import { costToClimb, costToEnter, levelAt } from "../core/terrain.js";
import {
  type Facing,
  type Hex,
  isFacing,
  type Location,
  type MoveMode,
  type Rng,
  rotateFacing,
  type TerrainHexDef,
  type TerrainType,
} from "../core/types.js";
import { getMechDef } from "../data/index.js";
import type { ResolvedMechDef } from "../data/schema.js";
import { getWeaponOrThrow } from "../data/weapons.js";
import { isInFrontArc } from "./arcs.js";
import { type AttackResolution, resolveWeaponAttack } from "./attack.js";
import { type CriticalResolution, effectiveMovement } from "./critical.js";
import { canFireFromLocation, isImmobile, isKilled, type UnitDamageState } from "./damage.js";
import { rollInitiative } from "./initiative.js";
import {
  interveningTerrains,
  losBlockedByElevation,
  losClear,
  losWoodsPointsBetween,
} from "./los.js";
import * as mv from "./movement.js";
import { computeToHit } from "./tohit.js";

export interface UnitInit {
  readonly id: string;
  readonly model: string;
  readonly team: number;
  readonly gunnery: number;
  readonly position: Hex;
  readonly facing: Facing;
}

export interface AttackDecl {
  readonly weaponIndex: number;
  readonly targetId: string;
  /** Request a rapid-fire (double-tap) volley; only valid on rapid-fire weapons. Defaults off. */
  readonly rapidFire?: boolean;
}

export type MoveStep =
  | { readonly kind: "enter"; readonly to: Hex }
  | { readonly kind: "turn"; readonly facings: number };

export type Phase = "initiative" | "movement" | "weaponAttack" | "end";

export interface UnitState {
  readonly id: string;
  readonly model: string;
  readonly team: number;
  gunnery: number;
  position: Hex;
  facing: Facing;
  damage: UnitDamageState;
  phaseStartDamage: UnitDamageState;
  ammoLeft: Record<number, number>;
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
      readonly position: Hex;
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
  | {
      readonly kind: "critsResolved";
      readonly unitId: string;
      readonly targetId: string;
      readonly resolutions: readonly CriticalResolution[];
    }
  | { readonly kind: "unitDestroyed"; readonly unitId: string }
  | { readonly kind: "unitRemoved"; readonly unitId: string };

export interface BattleState {
  turn: number;
  phase: Phase;
  initiativeWinnerTeam: number | null;
  units: Record<string, UnitState>;
  terrain: Record<string, TerrainType>;
  /** Per-hex ground elevation; missing entries are level 0. */
  elevation: Record<string, number>;
  /** Board size hint for rendering (engine coords); renderers fall back to content extent when absent. */
  width?: number | undefined;
  height?: number | undefined;
  /** When true, critical hit resolution is suppressed at attack time. */
  critsDisabled: boolean;
  actedThisPhase: string[];
  events: GameEvent[];
}

export type { TerrainHexDef };

export interface CreateBattleOptions {
  /** Non-clear hexes; anything not listed is clear terrain. */
  readonly terrain?: readonly TerrainHexDef[];
  /** Board size hint for rendering, in engine coordinates (columns/rows). */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /**
   * Disable critical hit resolution. Off by default. Tests that script
   * dice for narrow damage scenarios (where any crit would alter the
   * expected outcome) can set this to `false` so the engine follows the
   * scripted RNG only for the attack and location rolls.
   */
  readonly critsDisabled?: boolean;
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

function occupantAt(state: BattleState, hex: Hex, excludeId?: string): UnitState | undefined {
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
  options: CreateBattleOptions = {},
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
    const def: ResolvedMechDef = getMechDef(init.model)!;
    const ammoLeft: Record<number, number> = {};
    Object.entries(def.weapons).forEach(([key, mount]) => {
      const weaponIndex = Number(key);
      if (mount.ammoShots !== undefined) ammoLeft[weaponIndex] = mount.ammoShots;
    });
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
      ammoLeft,
      jammedWeapons: [],
      critSlotsDestroyed: initCritDestroyed(def),
      destroyedWeapons: [],
      moveMode: null,
      movesThisTurn: [],
      jumpedThisTurn: false,
      mpSpent: 0,
      declaredAttacks: [],
      firedTargetId: null,
      passedAttacks: false,
      destroyed: false,
      removed: false,
    };
  }

  const terrain: Record<string, TerrainType> = {};
  const elevation: Record<string, number> = {};
  if (options.terrain) {
    for (const { col, row, type, level } of options.terrain) {
      const key = `${col},${row}`;
      if (key in terrain)
        throw new Error(`Duplicate terrain definition for hex ${fmtHex({ col, row })}`);
      terrain[key] = type;
      if (level !== undefined) elevation[key] = level;
    }
  }
  for (const [label, n] of [
    ["width", options.width],
    ["height", options.height],
  ] as const) {
    if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
      throw new Error(`Board ${label} must be an integer >= 1`);
    }
  }

  return {
    turn: 1,
    phase: "initiative",
    initiativeWinnerTeam: null,
    units: unitStates,
    terrain,
    elevation,
    width: options.width,
    height: options.height,
    critsDisabled: options.critsDisabled ?? false,
    actedThisPhase: [],
    events: [{ kind: "turn", turn: 1 }],
  };
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

  const def = getMechDef(unit.model)!;
  const movement = effectiveMovement(def, unit.critSlotsDestroyed);
  const budget = mv.maxMovePoints(
    unit.moveMode,
    movement.walking,
    movement.running,
    movement.jumping,
  );
  const jumping = unit.moveMode === "jump";

  let cursor: Hex = { ...unit.position };
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
      const fromLevel = levelAt(state.elevation, cursor);
      const toLevel = levelAt(state.elevation, to);
      if (toLevel - fromLevel > 1) {
        throw new Error(
          `Ground moves can climb at most 1 level per hex (${fmtHex(to)} is ${toLevel - fromLevel} levels higher)`,
        );
      }
      spent += costToEnter(mv.terrainAt(state.terrain, to)) + costToClimb(fromLevel, toLevel);
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
}

export function declareAttacks(
  state: BattleState,
  unitId: string,
  decls: readonly AttackDecl[],
): void {
  requirePhase(state, "weaponAttack");
  const unit = getUnitOrThrow(state, unitId);
  if (unit.destroyed || unit.removed) throw new Error(`${unitId} is destroyed`);
  if (unit.declaredAttacks.length > 0)
    throw new Error(`${unitId} already declared attacks this turn`);

  const def = getMechDef(unit.model)!;
  let targetId: string | null = null;
  let attackDistance = 0;
  let attackRangeBracket: string = "short";
  let attackRangeMod = 0;

  const seenWeapons = new Set<number>();
  decls.forEach((decl, index) => {
    const mount = def.weapons[decl.weaponIndex];
    if (!mount) throw new Error(`weaponIndex ${decl.weaponIndex} out of range for ${unitId}`);
    const weapon = getWeaponOrThrow(mount.weapon);

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

    const woodsPoints = losWoodsPointsBetween(state.terrain, unit.position, target.position);
    if (!losClear(state.elevation, state.terrain, unit.position, target.position)) {
      if (losBlockedByElevation(state.elevation, unit.position, target.position)) {
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
      targetTerrain: mv.terrainAt(state.terrain, target.position),
      interveningWoods: woodsPoints,
      distance: dist,
      weapon,
      attackerLevel: levelAt(state.elevation, unit.position),
      targetLevel: levelAt(state.elevation, target.position),
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
    if (mount.ammoShots !== undefined) {
      const left = unit.ammoLeft[decl.weaponIndex] ?? 0;
      if (left < needed) {
        throw new Error(`${mount.weapon}: needs ${needed} shot(s) but only ${left} remain`);
      }
      unit.ammoLeft[decl.weaponIndex] = left - needed;
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
  const def = getMechDef(unit.model)!;

  for (const decl of unit.declaredAttacks) {
    const mount = def.weapons[decl.weaponIndex]!;
    const weapon = getWeaponOrThrow(mount.weapon);
    const target = getUnitOrThrow(state, decl.targetId);
    const rapidFire = decl.rapidFire ?? false;
    const shots = rapidFire ? (weapon.rapidFireShots ?? 1) : 1;

    const resolution = resolveWeaponAttack({
      rng,
      gunnery: unit.gunnery,
      attackerMoved: unit.moveMode ?? "standStill",
      targetHexesMoved: mv.hexesSinceLastReversal(target.movesThisTurn),
      targetJumped: target.jumpedThisTurn,
      targetTerrain: mv.terrainAt(state.terrain, target.position),
      interveningTerrains: interveningTerrains(state.terrain, unit.position, target.position),
      distance: hexDistance(unit.position, target.position),
      weaponName: weapon.name,
      shots,
      targetDamage: target.damage,
      attackerLevel: levelAt(state.elevation, unit.position),
      targetLevel: levelAt(state.elevation, target.position),
      ...(state.critsDisabled
        ? {}
        : {
            targetDef: getMechDef(target.model)!,
            targetCritSlotsDestroyed: target.critSlotsDestroyed,
            targetDestroyedWeapons: target.destroyedWeapons,
            targetAmmoLeft: target.ammoLeft,
          }),
    });

    if (resolution.application !== null) target.damage = resolution.application.damage;
    if (resolution.jammed && !unit.jammedWeapons.includes(decl.weaponIndex)) {
      unit.jammedWeapons.push(decl.weaponIndex);
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
      target.ammoLeft = last.ammoLeft;
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
      state.events.push({
        kind: "critsResolved",
        unitId: unit.id,
        targetId: target.id,
        resolutions: resolution.crits,
      });
    }

    state.events.push({
      kind: "attackResolved",
      unitId: unit.id,
      targetId: target.id,
      resolution,
    });

    if (!target.destroyed && isKilled(target.damage)) {
      markUnitDestroyed(state, target);
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

export function advancePhase(state: BattleState): void {
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
        if (!unit.destroyed && isKilled(unit.damage)) {
          markUnitDestroyed(state, unit);
        }
      }
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
      }
      state.events.push({ kind: "turn", turn: state.turn });
      break;
    }
  }

  state.events.push({ kind: "phase", phase: state.phase });
}

/** Suggest which unit must act next (initiative loser alternates first). */
export function nextActor(state: BattleState): string | null {
  if (state.phase !== "movement" && state.phase !== "weaponAttack") return null;
  if (state.initiativeWinnerTeam === null) return null;
  const alive = Object.values(state.units).filter((u) => !u.removed);
  const teams = [...new Set(alive.map((u) => u.team))];
  if (teams.length === 0) return null;
  const winner = state.initiativeWinnerTeam;
  const loser = teams.find((t) => t !== winner) ?? winner;
  const order = loser === winner ? teams : [loser, ...teams.filter((t) => t !== loser)];

  const actedCount = (team: number): number =>
    alive.filter((u) => u.team === team && state.actedThisPhase.includes(u.id)).length;

  const sorted = order.sort((a, b) => actedCount(a) - actedCount(b));
  for (const team of sorted) {
    const candidate = alive.find(
      (u) => u.team === team && !state.actedThisPhase.includes(u.id) && !u.passedAttacks,
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
