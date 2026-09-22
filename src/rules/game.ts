import { D2D6_MAX, roll2D6 } from "../core/dice.js";
import { bearingExact, hexDistance, isAdjacent, sameHex } from "../core/hex.js";
import {
  cellAt,
  costToClimb,
  costToEnter,
  type HexGrid,
  hasPartialCover,
  MP_PER_FACING_CHANGE,
  setCell,
} from "../core/terrain.js";
import {
  type Facing,
  type HexCell,
  type HexCoord,
  isFacing,
  isTorso,
  LOCATIONS,
  type Location,
  type MoveMode,
  type Rng,
  rotateFacing,
  type TerrainHexDef,
  type WreckState,
} from "../core/types.js";
import {
  getMechDef,
  getMechDefFor,
  getUnitTonnage,
  type MapDef,
  type MechModelHolder,
} from "../data/index.js";
import type { ResolvedMechDef } from "../data/mech.schema.js";
import { getWeaponDefFor } from "../data/weapon.schema.js";
import {
  type AmmoBins,
  type AmmoPolicy,
  ammoWeaponTotals,
  binsForWeapon,
  collectAmmoBins,
  consumeAmmo,
  consumeAmmoForName,
  loadAmmoBins,
  pooledShotsLeft,
  stripBinsInLocation,
} from "./ammo.js";
import {
  type Arc,
  classifyArcWithBoundary,
  defenderArcChoice,
  effectiveFacingForTwist,
  weaponCanFireIntoArc,
} from "./arcs.js";
import { type AttackResolution, PARTIAL_COVER_TERRAIN_MOD, resolveWeaponAttack } from "./attack.js";
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
  countDestroyedEngine,
  countDestroyedGyro,
  countDestroyedHip,
  countDestroyedLifeSupport,
  countDestroyedSensor,
  effectiveMovement,
  HIP,
  markLocationCatastrophicallyDestroyed,
  resolveCriticalHits,
} from "./critical.js";
import {
  applyDamage,
  canAttemptStandUp,
  canFireFromLocation,
  destroyedLegs,
  isUnitDestroyed,
  isUnitImmobile,
  type UnitDamageState,
} from "./damage.js";
import {
  ammoExplosionAvoidWithThreshold,
  effectiveMoveBudget,
  engineHitHeat,
  HEAT_CAP,
  heatDissipation,
  heatDissipationMax,
  largestAmmoBin,
  movementHeat,
  shutdownAvoid,
  shutdownAvoidWithThreshold,
  toHitHeatModifier,
} from "./heat.js";
import { hitLocation, hitLocationForArc } from "./hitlocation.js";
import { rollInitiative } from "./initiative.js";
import {
  interveningTerrains,
  losBlockedByBuilding,
  losBlockedByElevation,
  losClear,
  losWoodsPointsBetween,
} from "./los.js";
import * as mv from "./movement.js";
import {
  BACKWARD_LEVEL_CHANGE_MAX,
  FORWARD_LEVEL_CHANGE_MAX,
  JUMP_MP_PER_HEX,
} from "./movement.js";
import {
  buildingEntryModifier,
  consciousnessTarget,
  DEFAULT_PILOTING,
  facingAfterFall,
  fallingDamageGroups,
  fallingDamageTotal,
  GYRO_DESTROYED_HITS,
  GYRO_HIT_MOD,
  HIP_MOD,
  LEG_ACTUATOR_MOD,
  LEG_ACTUATORS,
  PSR_DAMAGE_THRESHOLD,
  preexistingDamageModifier,
  rollConsciousness,
  rollFallDirection,
  rollPilotingCheck,
  sensorAttackModifier,
  sensorsBlind,
  waterEntryModifier,
} from "./piloting.js";
import { computeToHit, DEFAULT_GUNNERY, type RangeBracket } from "./tohit.js";

export interface UnitInit extends MechModelHolder {
  readonly id: string;
  model: string;
  team: number;
  /** Gunnery skill (TW regular = 4); defaults to {@link DEFAULT_GUNNERY}. */
  gunnery: number;
  /** Pilot skill (TW regular = 5); defaults to {@link DEFAULT_PILOTING}. */
  piloting: number;
  position: HexCoord;
  facing: Facing;
}

export interface AttackDecl {
  readonly weaponIndex: number;
  readonly targetId: string;
  /** Request a rapid-fire (double-tap) volley; only valid on rapid-fire weapons. Defaults off. */
  readonly rapidFire?: boolean;
  /** Firing arc of the target relative to the ATTACKER's facing, classified at
   *  declaration time. Drives per-weapon fire legality (TW p.105 weapon
   *  arcs). On an exact arc-boundary line this is one arc of the pair; the
   *  legality check accepts the weapon when either arc of the pair allows it. */
  readonly arc?: Arc;
  /** Attack direction: the side of the TARGET the attack strikes (TW p.107),
   *  classified from the target's facing at declaration time. Drives the
   *  hit-location table column and the front/rear armor pool. Boundary-line
   *  ambiguity resolves to the defender's dominant choice
   *  (`defenderArcChoice`). */
  readonly attackDirection?: Arc;
}

export type MoveStep =
  | { readonly kind: "enter"; readonly to: HexCoord }
  | { readonly kind: "turn"; readonly facings: number };

/** Off-line status of a unit. `"not"` = online; any other value = shut down.
 *  `"manual"` persists until a voluntary startup roll succeeds, `"heat"`
 *  auto-restarts in the end phase once heat drops, and `"starting"` is a
 *  successful startup still pending the next initiative roll. */
export type ShutdownState = "manual" | "heat" | "starting" | "not";

/** Physical destruction state of a unit: "not" = intact. Reason tracks
 *  which kill condition ended the 'Mech (head/CT IS depleted, cockpit
 *  crit, head blown off, or three engine crits). */
export type DestroyedReason =
  | "headDestroyed"
  | "centerTorsoDestroyed"
  | "cockpitDestroyed"
  | "headBlownOff"
  | "engineDestroyed";
export type DestroyedState = "not" | DestroyedReason;

/** Why the pilot took damage. Drives the `pilotDamaged` event `reason`
 *  field and the `applyPilotHits` parameter; both stay typed so web and
 *  tests can pattern-match exhaustively. */
export type PilotHitReason = "headHit" | "ammoExplosion" | "fall" | "shutdownFall" | "lifeSupport";

/** Removal from play: "not" = on the board. "destroyed" = unit killed
 *  (paired with a DestroyedState reason). "pilotEjected" = pilot left
 *  the 'Mech (wreck left behind). "pilotKilled" = six pilot hits, unit
 *  removed but frame not destroyed (wreck left behind, like eject). */
export type RemovalReason = "destroyed" | "pilotEjected" | "pilotKilled";
export type RemovedState = "not" | RemovalReason;

export type Phase = "initiative" | "movement" | "weaponAttack" | "end";

/** Deterministic rng for ammo draws when the caller omits one: ties resolve
 *  to the first bin and the order is stable run to run. */
export const DEFAULT_RNG: Rng = {
  d6: () => 1,
  snapshot(): string {
    return "";
  },
  load(_snapshot: string): void {},
};

export interface UnitState extends MechModelHolder {
  readonly id: string;
  readonly model: string;
  readonly team: number;
  gunnery: number;
  /** Piloting skill (TW regular = 5); drives every Piloting Skill Roll. */
  piloting: number;
  /** Pilot hits taken (0..6; 6 kills the pilot and destroys the unit). */
  pilotHits: number;
  /** True once the pilot fails a consciousness roll; the unit cannot act
   *  and counts as immobile until it wakes in a later end phase. */
  unconscious: boolean;
  /** Turn number the pilot was knocked out on (no wake attempt that turn). */
  unconsciousSinceTurn: number | null;
  /** True while the 'Mech lies on the ground (fell or dropped). */
  prone: boolean;
  position: HexCoord;
  facing: Facing;
  damage: UnitDamageState;
  phaseStartDamage: UnitDamageState;
  /** Crit-slot destroyed flags at the start of the weapon attack phase; the
   *  piloting sweep diffs against this to find newly destroyed actuators,
   *  hips, and gyros (TW "previously destroyed" = destroyed before now). */
  phaseStartCritSlotsDestroyed: Record<Location, boolean[]>;
  /** Per-crit-slot ammo state: identity + remaining shots (see
   *  `src/rules/ammo.ts`). Per-weapon totals are derived on demand. */
  ammoBins: AmmoBins;
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
  /** Own heat generated this turn that has not yet been applied to the
   *  scale. Movement, weapon, posture, and engine-crit heat all accumulate
   *  here during their producing phases and land on the scale only in the
   *  end phase (TW p.159 single-step net update). Reset to 0 by the heat
   *  phase. The to-hit modifier used during this turn's weapon attack
   *  phase reads `heat` (not `heat + heatPending`), matching TW p.160. */
  heatPending: number;
  /** Shutdown state: "manual" (voluntary), "heat" (automatic, restartable in
   *  the end phase), "starting" (startup roll succeeded; still off-line until
   *  the next initiative roll) or "not" (online). Anything but "not" counts
   *  as shut down: cannot move, fire, or act as the next actor. */
  shutdown: ShutdownState;
  declaredAttacks: AttackDecl[];
  firedTargetId: string | null;
  /** True if the unit explicitly passed on declaring attacks this phase. */
  passedAttacks: boolean;
  destroyed: DestroyedState;
  removed: RemovedState;
}

export type GameEvent =
  | {
      readonly kind: "phase";
      readonly prevTurn: number;
      readonly prevPhase: Phase;
      readonly turn: number;
      readonly phase: Phase;
    }
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
      readonly prevMode: MoveMode;
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
  | {
      readonly kind: "unitRemoved";
      readonly unitId: string;
      readonly reason: RemovalReason;
      readonly destroyReason?: DestroyedReason | null;
    }
  // Pilot ejects: the 'Mech leaves the battle and its hex gains a `wrecks`
  // entry (a level-2 obstacle), see `ejectPilot`. Emits `unitRemoved` with
  // reason "pilotEjected". A pilot killed by six pilot hits emits
  // `unitRemoved` with reason "pilotKilled" and likewise leaves a level-2
  // wreck, see `removePilotKilled`.
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
  | {
      readonly kind: "heatMove";
      readonly unitId: string;
      readonly heat: number;
      /** Scale value at the time of the action (= previous turn's end).
       *  Same value the weapon attack phase uses for to-hit this turn. */
      readonly base: number;
      /** Cumulative own heat generated this turn for this unit, including
       *  this push. Equals `unit.heatPending` after the event. */
      readonly totalGenerated: number;
    }
  | {
      readonly kind: "heatWeapon";
      readonly unitId: string;
      readonly weapon: string;
      readonly heat: number;
      readonly base: number;
      readonly totalGenerated: number;
    }
  | {
      readonly kind: "heatEngineCrit";
      readonly unitId: string;
      readonly heat: number;
      readonly base: number;
      readonly totalGenerated: number;
    }
  | {
      readonly kind: "heatDissipated";
      readonly unitId: string;
      readonly dissip: number;
      /** Scale value entering the heat phase (pre-own-heat application). */
      readonly startHeat: number;
      /** Sum of own heat generated this turn (= `heatPending` at phase
       *  entry). */
      readonly totalGenerated: number;
      /** Scale value after dissipation (= `unit.heat` after this event). */
      readonly endHeat: number;
      /** Net change this turn = endHeat - startHeat. */
      readonly netChange: number;
      readonly capacity: number;
      readonly capacityMax: number;
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
      readonly avoid: number;
      readonly heat: number;
      readonly threshold: number;
      readonly shotsRemaining: number;
      readonly damage: number;
      readonly damagePerShot: number;
      readonly avoided: boolean;
    }
  | {
      /** One Piloting Skill Roll (TW p.59). `roll` is null when the outcome
       *  was automatic (target <= 2 auto-success, target > 12 auto-fall). */
      readonly kind: "pilotingCheck";
      readonly unitId: string;
      /** Trigger code: damage20 | legActuator | hip | gyro | standUp |
       *  rubble | water1 | water2 | water3 | building | seatbelt |
       *  shutdown | runDamaged | jumpDamaged. */
      readonly reason: string;
      readonly modifier: number;
      readonly target: number;
      readonly roll: number | null;
      readonly success: boolean;
    }
  | {
      /** The 'Mech falls (TW p.68): facing rotates per the Facing After
       *  Fall roll and the damage clusters land on that column. `crits`
       *  holds the determining resolutions the fall damage triggered.
       *  A voluntary drop reuses this shape with `cause: "voluntaryDrop"`:
       *  facing stays put, so `fallRoll` is null. */
      readonly kind: "unitFell";
      readonly unitId: string;
      /** failedPsr:<reason> | legDestroyed | gyroDestroyed | shutdown |
       *  rubble | water | building | voluntaryDrop. */
      readonly cause: string;
      readonly facingAfter: Facing;
      /** Facing After Fall roll, or null when no facing roll happened. */
      readonly fallRoll: number | null;
      readonly column: Arc;
      /** Underlying-terrain levels fallen (0 for a same-hex fall). */
      readonly levelsFallen: number;
      readonly groups: ReadonlyArray<{ readonly location: Location; readonly damage: number }>;
      readonly totalDamage: number;
      readonly crits: readonly CriticalResolution[];
    }
  | {
      readonly kind: "pilotDamaged";
      readonly unitId: string;
      readonly reason: PilotHitReason;
      readonly hits: number;
      readonly totalHits: number;
    }
  | {
      readonly kind: "consciousnessCheck";
      readonly unitId: string;
      readonly roll: number;
      readonly target: number;
      readonly success: boolean;
      readonly hits: number;
      readonly consciousBefore: boolean;
    }
  | {
      /** Building-entry PSR failed (TW p.167): the crash damages the 'Mech
       *  (ceil(CF / 10) in 5-point groups on the front column) but never
       *  knocks it down. `crits` holds the determining resolutions. */
      readonly kind: "buildingCrash";
      readonly unitId: string;
      readonly col: number;
      readonly row: number;
      readonly groups: ReadonlyArray<{ readonly location: Location; readonly damage: number }>;
      readonly totalDamage: number;
      readonly crits: readonly CriticalResolution[];
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
  readonly finalAmmoBins: AmmoBins;
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
  /** Building state keyed by hex `"col,row"`; only building hexes present. */
  buildings: Record<string, BuildingState>;
  /** 'Mech wrecks left by ejected pilots, keyed by hex `"col,row"`. Each is a
   *  permanent level-2 obstacle: hex is blocked to all movement, LOS crossing
   *  the hex is blocked, and an adjacent target gains +2 partial cover. */
  wrecks: Record<string, WreckState>;
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

export function requireUnit(state: BattleState, unitId: string): UnitState {
  const unit = state.units[unitId];
  if (!unit) throw new Error(`Unknown unit id: ${unitId}`);
  return unit;
}

/**
 * Enforce that `unitId` is the next pending actor for the given phase.
 * Drives off `pendingActors` so the same exclusions apply: removed, shut-down
 * (weapon phase), unconscious, and already-acted or passed units are not
 * eligible. Callers must pass the head-of-queue unit, otherwise the engine
 * rejects the action. Matches TW turn flow.
 */
function requireCurrentActor(
  state: BattleState,
  unitId: string,
  phase: "movement" | "weaponAttack",
): void {
  if (state.initiativeWinnerTeam === null) {
    throw new Error(`${unitId} cannot act before initiative is set`);
  }
  if (state.phase !== phase) {
    throw new Error(`${unitId} is not acting in the ${phase} phase`);
  }
  const head = pendingActors(state)[0] ?? null;
  if (head !== unitId) {
    throw new Error(`${unitId} is not the current actor (expected ${head ?? "none"})`);
  }
}

export function isNominal(unit: UnitState) {
  return unit.shutdown === "not";
}

export function isShutdown(unit: UnitState) {
  return unit.shutdown !== "not";
}

export function isImmobile(unit: UnitState) {
  if (isShutdown(unit) || unit.unconscious || isUnitImmobile(unit.damage)) return true;
  const def = getMechDefFor(unit);
  return countDestroyedGyro(def, unit.damage, unit.critSlotsDestroyed) >= GYRO_DESTROYED_HITS;
}

export function isUnitRemoved(unit: UnitState): boolean {
  return unit.removed !== "not";
}

export function isUnitAvailable(unit: UnitState): boolean {
  return unit.removed === "not";
}

/**
 * Partial-cover to-hit modifier against `target` from `attacker`:
 *  - terrain: 1 when the target stands in partial-cover terrain
 *    (water1 / building) and the attacker is not higher.
 *  - L2 wreck adjacent + attacker below wreck top: +2 (TW).
 *  - L2 wreck adjacent + attacker at/above wreck top + target elevated
 *    (target hex higher than attacker) or target at Level 3+: +1 (TO).
 *  - L1 wreck adjacent + attacker below wreck top + target is a standing
 *    ground 'Mech (not prone, not shut down, not unconscious): +1 (TO).
 * Larger wins when both apply (TW: partial cover does not stack beyond one
 * source). Leg hit-location rolls strike the cover under any non-zero value
 * (see `hitLocationCovered` in `src/rules/attack.ts`).
 */
export function partialCoverMod(
  state: BattleState,
  attacker: UnitState,
  target: UnitState,
): number {
  const terrain =
    hasPartialCover(cellAt(state, target.position).terrain) &&
    cellAt(state, attacker.position).level <= cellAt(state, target.position).level
      ? PARTIAL_COVER_TERRAIN_MOD
      : 0;
  let wreck = 0;
  const attackerLevel = cellAt(state, attacker.position).level;
  const targetLevel = cellAt(state, target.position).level;
  const targetStandingGround = !target.prone && isNominal(target) && !target.unconscious;
  for (const [key, w] of Object.entries(state.wrecks)) {
    const [col, row] = key.split(",");
    const wreckHex = { col: Number(col), row: Number(row) };
    if (!isAdjacent(target.position, wreckHex)) continue;
    const wreckTop = cellAt(state, wreckHex).level + w.level;
    if (attackerLevel < wreckTop) {
      // Attacker is below the wreck top: LOS may still pass for L1; cover mod
      // depends on wreck level and target posture.
      if (w.level === 1) {
        // Tactical Operations: L1 provides +1 partial cover to standing ground
        // 'Mechs behind it; no cover against prone / shutdown / unconscious
        // targets.
        if (targetStandingGround) wreck = Math.max(wreck, WRECK_COVER_BY_LEVEL[1]!);
      } else {
        // TW default: L2 provides +2 to any adjacent target the attacker
        // can't see over.
        wreck = Math.max(wreck, WRECK_COVER_BY_LEVEL[2]!);
      }
    } else if (w.level === 2 && (targetLevel > attackerLevel || targetLevel >= 3)) {
      // Tactical Operations: L2 wreck provides +1 partial cover to elevated
      // units or Level 3+ targets even when the attacker is at/above the
      // wreck top (LOS still passes; wreck under attacker's LOS plane).
      wreck = Math.max(wreck, WRECK_L2_ELEVATED_COVER_MOD);
    }
  }
  return Math.max(terrain, wreck);
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
    if (isUnitRemoved(unit) || unit.id === excludeId) continue;
    if (sameHex(unit.position, hex)) return unit;
  }
  return undefined;
}

/** Wreck occupying a hex, or undefined when the hex is clear of wrecks. */
export function wreckAt(state: BattleState, hex: HexCoord): WreckState | undefined {
  return state.wrecks[`${hex.col},${hex.row}`];
}

/** Mark a unit as killed and removed, returning the paired events. The first
 *  kill wins: an already-removed unit (e.g. ejected or pilot-killed) is left
 *  untouched so the recorded reason stays the earliest cause. */
function markUnitDestroyed(unit: UnitState, destroyed: DestroyedReason, sink: GameEvent[]): void {
  if (isUnitRemoved(unit)) return;
  unit.destroyed = destroyed;
  unit.removed = "destroyed";
  sink.push({
    kind: "unitRemoved",
    unitId: unit.id,
    reason: "destroyed",
    destroyReason: destroyed,
  });
}

/** A pilot killed by six accumulated pilot hits removes the unit from play
 *  without destroying the 'Mech (TW p.41-42: the pilot is dead; the hull is
 *  intact). Handled like an eject: a permanent wreck occupies the hex.
 *  Wreck level is decided by `wreckLevelFor` (TO rule: light chassis or
 *  prone posture reduce it to level 1). Returns a single `unitRemoved` event
 *  with reason "pilotKilled". */
function removePilotKilled(state: BattleState, unit: UnitState, sink: GameEvent[]): void {
  if (isUnitRemoved(unit)) return;
  unit.removed = "pilotKilled";
  state.wrecks[`${unit.position.col},${unit.position.row}`] = {
    unitId: unit.id,
    level: wreckLevelFor(state, unit),
  };
  sink.push({ kind: "unitRemoved", unitId: unit.id, reason: "pilotKilled" });
}

/** Physical kill reason from the current damage state, preferring a
 *  crit-derived cause when `critRows` carry one (cockpit, engine, head
 *  blow-off) and falling back to the location whose IS hit zero. */
function destroyedReasonFor(
  damage: UnitDamageState,
  critRows?: readonly CriticalResolution[],
): DestroyedReason {
  if (critRows) {
    for (const res of critRows) {
      for (const row of res.rows) {
        if (row.kind === "cockpitDestroyed") return "cockpitDestroyed";
        if (row.kind === "engineDestroyed") return "engineDestroyed";
        if (row.kind === "headBlownOff") return "headBlownOff";
      }
    }
  }
  if (damage.internalStructure.head <= 0) return "headDestroyed";
  return "centerTorsoDestroyed";
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
    if (!Number.isInteger(init.gunnery) || init.gunnery < SKILL_MIN || init.gunnery > SKILL_MAX) {
      throw new Error(`Gunnery for ${init.id} must be an integer 0..7`);
    }
    if (
      !Number.isInteger(init.piloting) ||
      init.piloting < SKILL_MIN ||
      init.piloting > SKILL_MAX
    ) {
      throw new Error(`Piloting for ${init.id} must be an integer 0..7`);
    }
  }

  const unitStates: Record<string, UnitState> = {};
  for (const init of units) {
    const def: ResolvedMechDef = getMechDefFor(init);
    const ammoBins = loadAmmoBins(def);
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
      piloting: init.piloting,
      pilotHits: 0,
      unconscious: false,
      unconsciousSinceTurn: null,
      prone: false,
      position: { ...init.position },
      facing: init.facing,
      damage,
      phaseStartDamage: {
        armor: { ...damage.armor },
        armorRear: { ...damage.armorRear },
        internalStructure: { ...damage.internalStructure },
      },
      phaseStartCritSlotsDestroyed: initCritDestroyed(def),
      ammoBins,
      ammoPolicy: "exposed",
      jammedWeapons: [],
      critSlotsDestroyed: initCritDestroyed(def),
      destroyedWeapons: [],
      moveMode: null,
      movesThisTurn: [],
      jumpedThisTurn: false,
      mpSpent: 0,
      heat: 0,
      heatPending: 0,
      shutdown: "not",
      declaredAttacks: [],
      firedTargetId: null,
      passedAttacks: false,
      destroyed: "not",
      removed: "not",
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
    buildings,
    wrecks: {},
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
  /** Unit ids occupying the hex at the moment of collapse. */
  readonly occupants: readonly string[];
}

/**
 * Apply weapon damage to the building occupying a hex, collapsing it to rubble
 * when its structural factor reaches zero. Pushes the `buildingDamaged` /
 * `buildingCollapsed` event into `sink` and returns the outcome, or `null`
 * when the hex has no building. Occupant collapse damage is applied by the
 * caller (see `resolveAllAttacks`).
 */
export function damageBuildingAt(
  state: BattleState,
  hex: HexCoord,
  damage: number,
  sink: GameEvent[],
): BuildingDamageResult | null {
  const key = `${hex.col},${hex.row}`;
  const building = state.buildings[key];
  if (building === undefined) return null;
  const preCf = building.cf;
  const occupants = Object.values(state.units)
    .filter((u) => !isUnitRemoved(u) && sameHex(u.position, hex))
    .map((u) => u.id);
  state.buildings[key] = applyBuildingDamage(building, damage);
  const cf = state.buildings[key]!.cf;
  if (isCollapsed(state.buildings[key]!)) {
    const rubble = collapseToRubble(state.cells[hex.col - 1 + (hex.row - 1) * state.width]!);
    if (rubble !== null) setCell(state, hex, rubble);
    delete state.buildings[key];
    sink.push({ kind: "buildingCollapsed", col: hex.col, row: hex.row });
    return { col: hex.col, row: hex.row, damage, preCf, cf: 0, collapsed: true, occupants };
  }
  sink.push({ kind: "buildingDamaged", col: hex.col, row: hex.row, damage, cf });
  return {
    col: hex.col,
    row: hex.row,
    damage,
    preCf,
    cf,
    collapsed: false,
    occupants: [],
  };
}

export function rollInitiativePhase(state: BattleState, rng: Rng, sink: GameEvent[]): void {
  requirePhase(state, "initiative");
  const teams = [...new Set(Object.values(state.units).map((u) => u.team))];
  const result = rollInitiative(teams, rng);
  state.initiativeWinnerTeam = result.winnerTeam;
  state.phase = "movement";
  state.actorQueue = null;
  sink.push(
    { kind: "initiative", rolls: result.rolls, winnerTeam: result.winnerTeam },
    {
      kind: "phase",
      prevTurn: state.turn,
      prevPhase: "initiative",
      turn: state.turn,
      phase: "movement",
    },
  );
}

/** MP cost of a stand-up attempt (TW p.50): shares the move budget. */
export const STAND_MP_COST = 2;
/** MP cost of a voluntary drop to prone (TW p.49): shares the walk budget. */
export const DROP_MP_COST = 1;

/** Pilot skill bounds for gunnery and piloting (TW regular scale 0..7). */
const SKILL_MIN = 0;
const SKILL_MAX = 7;
/** Max hexsides per facing-change step. */
const TURN_FACINGS_MAX = 5;
/** Minimum hexes entered for a jump declaration. */
const JUMP_MIN_HEXES = 1;
/** Heat from a posture move (stand up, prone turn). A voluntary drop to
 *  prone costs no heat. */
const POSTURE_MOVE_HEAT = 1;
/** Fixed damage from a voluntary drop to prone: 1 point on the front column. */
const VOLUNTARY_DROP_DAMAGE = 1;
/** Walk budget below which a prone drop or turn is refused. */
const DROP_BUDGET_MIN = 1;
/** One-hexside cap when a prone 'Mech has lost a leg (TW p. 122: "Staying
 *  prone, it may change facing one hexside per turn"). An undamaged prone
 *  'Mech (TW pp. 49, 50) instead pays 1 MP per hexside with no per-turn cap
 *  other than the in-place maximum below. */
const LEG_DESTROYED_PRONE_TURN_HEXSIDE = 1;
/** Largest in-place facing change for an undamaged prone 'Mech: 180° = 3
 *  hexsides (TW p. 50). Larger values would loop back to the same facing. */
const MAX_PRONE_TURN_HEXSIDE = 3;
/** End-of-heat-phase heat dealing 1 pilot hit with destroyed life support. */
const LIFE_SUPPORT_HEAT_1HIT = 15;
/** End-of-heat-phase heat dealing 2 pilot hits with destroyed life support. */
const LIFE_SUPPORT_HEAT_2HITS = 26;
/** Pilot hits per damaging head grouping. */
const HEAD_HIT_PILOT_HITS = 1;
/** Pilot hits per ammo explosion. */
const AMMO_BLAST_PILOT_HITS = 2;
/** Pilot hits per failed seatbelt or fall. */
const FALL_PILOT_HITS = 1;
/** Seatbelt modifier when a leg is destroyed. */
const SEATBELT_LEG_DESTROYED = 5;
/** Seatbelt modifier when the gyro is destroyed. */
const SEATBELT_GYRO_DESTROYED = 6;
/** PSR modifier for the 20+ damage trigger in the phase sweep. */
const PHASE_DAMAGE_PSR_MOD = 1;
/** PSR modifier when a reactor shuts down (TW p.60). Rolled immediately;
 *  only *other* PSRs required while the 'Mech is down fail automatically. */
const SHUTDOWN_PSR_MOD = 3;
/** Divisor for building-crash damage: ceil(remaining CF / 10). */
const BUILDING_CRASH_DIVISOR = 10;
/** Default wreck height in levels for a standing non-light 'Mech (TW).
 *  L1 wrecks are produced for light 'Mechs and for prone units via
 *  `wreckLevelFor` (see Tactical Operations block below). */
export const WRECK_LEVEL = 2;
/** Tactical Operations: light 'Mechs (<40 t) leave a level-1 wreck regardless
 *  of posture; a prone unit with a killed/ejected pilot also leaves a level-1
 *  wreck. Standing non-light units stay at WRECK_LEVEL = 2 (TW default). */
export const LIGHT_MECH_TONNAGE_MAX = 40;
/** Tactical Operations: per-level partial-cover to-hit mod provided by a
 *  wreck to a target adjacent to it. L1 = +1 to standing ground 'Mech;
 *  L2 = +2 (TW default), or +1 to elevated / Level 3+ targets per TO. */
export const WRECK_COVER_BY_LEVEL: Readonly<Record<number, number>> = { 1: 1, 2: 2 };
/** Tactical Operations: partial-cover to-hit mod granted by a L2 wreck to an
 *  elevated attacker looking down at a standard ground target or any
 *  attacker looking down at a Level 3+ target. */
export const WRECK_L2_ELEVATED_COVER_MOD = 1;

/** Tactical Operations wreck-level rule. Light chassis (<40 t) leave a
 *  level-1 wreck regardless of posture; otherwise a prone unit with a
 *  killed/ejected pilot leaves a level-1 wreck; standing non-light units
 *  leave the standard TW level-2 wreck. Caller reads `unit.prone` *before*
 *  setting `unit.removed = "pilotEjected" | "pilotKilled"`, since the
 *  posture field is discarded with the removed unit record. */
export function wreckLevelFor(_state: BattleState, unit: UnitState): 1 | 2 {
  if (getUnitTonnage(unit) < LIGHT_MECH_TONNAGE_MAX) return 1;
  if (unit.prone) return 1;
  return WRECK_LEVEL;
}

export interface ExecuteMoveOptions {
  /** Final facing after the move; when omitted, the unit keeps its facing. */
  readonly finalFacing?: Facing;
  /** Per-call random source. Defaults to `DEFAULT_RNG`. */
  readonly rng?: Rng;
  /** MP already charged by a preceding call on this same activation
   *  (e.g. `attemptStandUp`, `dropProne`). Added to the step-derived MP so
   *  both `unit.mpSpent` and the pushed `moved` event carry the combined
   *  posture+move total. Caller MUST also guarantee the unit is already
   *  in `actedThisPhase` (it pushed itself there) — `executeMove` then
   *  skips the head-of-queue guard and the redundant `actedThisPhase`
   *  push, so the activation marks exactly once. */
  readonly spentMP?: number;
}

export function executeMove(
  state: BattleState,
  unitId: string,
  mode: MoveMode,
  steps: readonly MoveStep[],
  sink: GameEvent[],
  options: ExecuteMoveOptions = {},
): void {
  requirePhase(state, "movement");
  const needActorCheck = options.spentMP === undefined;
  if (needActorCheck) requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot move`);
  if (unit.unconscious) throw new Error(`${unitId} is unconscious and cannot move`);
  if (mode !== "standStill" && isUnitImmobile(unit.damage)) {
    throw new Error(`${unitId} has no intact legs and arms and can only stand still`);
  }
  // TW p.122: a one-leg-destroyed 'Mech cannot run (running MP is 0).
  if (mode === "run" && destroyedLegs(unit.damage) >= 1) {
    throw new Error(`${unitId} has a destroyed leg and cannot run`);
  }
  // Prone units may only stand still or walk turn-only steps. Combined check:
  // reject run/jump outright; reject walk with any hex-enter step.
  if (unit.prone && mode !== "standStill" && mode !== "walk") {
    throw new Error(`${unitId} is prone: stand up, turn, or pronestill`);
  }
  if (unit.prone && mode === "walk" && steps.some((s) => s.kind === "enter")) {
    throw new Error(`${unitId} is prone: turn or pronestill only (no hex enters)`);
  }
  unit.moveMode = mode;
  unit.movesThisTurn = [];
  unit.mpSpent = 0;
  sink.push({ kind: "moveDeclared", unitId, mode });
  const rng = options.rng ?? DEFAULT_RNG;
  const prechargedMP = options.spentMP ?? 0;

  const def = getMechDefFor(unit);
  const movement = effectiveMovement(def, unit.phaseStartDamage, unit.critSlotsDestroyed);
  const budget = effectiveMoveBudget(unit.moveMode, movement, unit.heat);
  const jumping = unit.moveMode === "jump";
  const proneTurn = unit.prone && unit.moveMode === "walk";

  let cursor: HexCoord = unit.position;
  let facing: Facing = unit.facing;
  let spent = 0;
  const directions: ("forward" | "backward")[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const isFinalStep = i === steps.length - 1;

    if (step.kind === "turn") {
      if (jumping) throw new Error("Jumping 'Mechs choose facing freely on landing; no turn steps");
      if (unit.moveMode === "standStill") throw new Error("Standing still forbids facing changes");
      if (
        !Number.isInteger(step.facings) ||
        step.facings === 0 ||
        Math.abs(step.facings) > TURN_FACINGS_MAX
      ) {
        throw new Error("Facing change must be 1..5 hexsides in either direction");
      }
      spent += mv.facingChangeCost(Math.abs(step.facings));
      facing = rotateFacing(facing, step.facings);
      continue;
    }

    const to = step.to;
    if (jumping) {
      if (!isAdjacent(cursor, to)) {
        throw new Error("Jump steps must enter an adjacent hex");
      }
      spent += JUMP_MP_PER_HEX;
      directions.push("forward");
    } else {
      if (unit.moveMode === "standStill") throw new Error("Standing still forbids entering hexes");
      if (proneTurn) {
        throw new Error(`${unitId} is prone: turn or pronestill only (no hex enters)`);
      }
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
      const illegalChange = forward
        ? Math.abs(delta) > FORWARD_LEVEL_CHANGE_MAX
        : delta !== BACKWARD_LEVEL_CHANGE_MAX;
      if (illegalChange) {
        const slope = delta > 0 ? `${delta} levels higher` : `${-delta} levels lower`;
        throw new Error(
          forward
            ? `Ground moves can change at most 2 levels per hex (${fmtHex(to)} is ${slope})`
            : `Walking backward cannot change level (${fmtHex(to)} is ${slope})`,
        );
      }
      {
        const fromLevel = cellAt(state, cursor).level;
        const toLevel = cellAt(state, to).level;
        spent += costToEnter(cellAt(state, to).terrain) + costToClimb(fromLevel, toLevel);
      }
      directions.push(forward ? "forward" : "backward");
    }

    const wreck = wreckAt(state, to);
    if (wreck !== undefined) {
      throw new Error(`Cannot enter ${fmtHex(to)}: blocked by ${wreck.unitId}'s wreck`);
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

    cursor = to;
  }

  if (spent > budget) {
    throw new Error(`Move costs ${spent} MP but ${unit.moveMode} budget is ${budget}`);
  }
  if (jumping && directions.length < JUMP_MIN_HEXES) {
    throw new Error("Jump needs at least 1 hex move");
  }
  if (
    steps.length > 0 &&
    !jumping &&
    unit.moveMode !== "standStill" &&
    isUnitImmobile(unit.damage)
  ) {
    throw new Error(`${unitId} has no intact legs and arms and cannot move`);
  }

  // Preexisting damage applies to every movement-entry PSR (TW p.60).
  const pre = preexistingDamageModifier(def, unit.damage, unit.critSlotsDestroyed);
  const commitAt = (
    hex: HexCoord,
    face: Facing,
    mode: MoveMode,
    mp: number,
    dirs: ("forward" | "backward")[],
  ): void => {
    unit.position = hex;
    unit.facing = face;
    unit.jumpedThisTurn = jumping && steps.length > 0;
    unit.movesThisTurn = [...dirs];
    unit.mpSpent = mp + prechargedMP;
    sink.push({
      kind: "moved",
      unitId,
      mode,
      prevMode: mode,
      position: hex,
      facing: face,
      mpSpent: mp + prechargedMP,
      mpBudget: budget,
    });
    const moveHeat = movementHeat(mode, mp);
    if (moveHeat > 0) {
      // Deferred own heat: accumulate into heatPending; the scale only
      // updates at the heat phase (TW p.159).
      unit.heatPending += moveHeat;
      sink.push({
        kind: "heatMove",
        unitId,
        heat: moveHeat,
        base: unit.heat,
        totalGenerated: unit.heatPending,
      });
    }
  };

  // Progressive commit: the validated path replays step by step so a failed
  // terrain PSR stops the 'Mech in the hex it fell in (TW: falls resolve as
  // they happen in the movement phase).
  let cur: HexCoord = unit.position;
  let curFacing: Facing = unit.facing;
  let curSpent = 0;
  const curDirs: ("forward" | "backward")[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const isFinal = i === steps.length - 1;
    if (step.kind === "turn") {
      curFacing = rotateFacing(curFacing, step.facings);
      curSpent += mv.facingChangeCost(Math.abs(step.facings));
      continue;
    }
    const from = cur;
    const to = step.to;
    if (jumping) {
      curSpent += JUMP_MP_PER_HEX;
      curDirs.push("forward");
    } else {
      const forward = mv.isForwardStep(from, to, curFacing);
      curSpent +=
        costToEnter(cellAt(state, to).terrain) +
        costToClimb(cellAt(state, from).level, cellAt(state, to).level);
      curDirs.push(forward ? "forward" : "backward");
    }
    cur = to;
    // Terrain-entry PSRs (TW p.60): ground checks every entered hex, jump
    // only its landing. A fall, crash-kill, or shutdown ends the move here,
    // committed at the hex the fall rule leaves the 'Mech in (the lower
    // hex on a fall across levels).
    if (!jumping || isFinal) {
      const fellAt = movementTerrainPsr(state, unit, rng, from, to, !jumping, pre.modifier, sink);
      if (fellAt !== null) {
        commitAt({ ...fellAt }, unit.facing, mode, curSpent, curDirs);
        return;
      }
      if (unit.prone || unit.destroyed !== "not") {
        commitAt({ ...cur }, unit.facing, mode, curSpent, curDirs);
        return;
      }
    }
  }

  commitAt(cursor, options.finalFacing ?? facing, mode, spent, directions);
  if (needActorCheck) state.actedThisPhase.push(unitId);

  // Running with a damaged hip/gyro, or jumping with damaged gyro, leg,
  // foot, or hip actuators (or a destroyed leg), forces a PSR at the end of
  // the move with preexisting-damage modifiers (TW p.60). The trigger adds
  // nothing on top of `pre`: both table rows read "per Preexisting Damage".
  // Stationary declarations (no hex entered) skip the check. A failed
  // jump-phase PSR falls 0 levels per errata even across levels, and the
  // landing hex is already committed, so no levelsFallen is passed.
  if (!unit.prone && directions.length > 0) {
    const gyroHits = countDestroyedGyro(def, unit.damage, unit.critSlotsDestroyed);
    const hipHits = countDestroyedHip(def, unit.damage, unit.critSlotsDestroyed);
    const strained =
      mode === "run" ? hipHits > 0 || gyroHits > 0 : mode === "jump" ? pre.modifier > 0 : false;
    if (strained) {
      const reason = mode === "run" ? "runDamaged" : "jumpDamaged";
      const r = rollPilotingCheck(rng, unit.piloting, pre.modifier);
      sink.push({
        kind: "pilotingCheck",
        unitId,
        reason,
        modifier: pre.modifier,
        target: r.target,
        roll: r.roll,
        success: r.success,
      });
      if (!r.success) {
        const terrain = cellAt(state, cursor).terrain;
        applyFall(
          state,
          unit,
          rng,
          {
            cause: `failedPsr:${reason}`,
            seatbeltModifier: pre.modifier,
            halved: terrain === "water2" || terrain === "water3",
          },
          sink,
        );
      }
    }
  }
}

/**
 * Arm a prone volley props itself up on, inferred from its declared weapons:
 * a volley with left-arm weapons props on the right arm and vice versa.
 * Null when standing, or when a prone volley fires no arm-mounted weapons.
 */
export function inferPronePropArm(
  def: ResolvedMechDef,
  decls: readonly AttackDecl[],
  prone: boolean,
): "leftArm" | "rightArm" | null {
  if (!prone) return null;
  let hasLeft = false;
  let hasRight = false;
  for (const decl of decls) {
    const loc = def.weapons[decl.weaponIndex]?.location;
    if (loc === "leftArm") hasLeft = true;
    if (loc === "rightArm") hasRight = true;
  }
  if (hasLeft && hasRight) return null;
  if (hasLeft) return "rightArm";
  if (hasRight) return "leftArm";
  return null;
}

export interface DeclareAttacksOptions {
  /** Torso twist (TW pp.105-106): shifts the attacker's effective facing by one
   *  hexside before classifying the firing arc. Defaults to untwisted. */
  readonly twist?: Arc | null;
}

export interface ValidateAttacksOptions {
  /** Torso twist (TW pp.105-106): shifts the attacker's effective facing by one
   *  hexside before classifying the firing arc. Defaults to untwisted. */
  readonly twist?: Arc | null;
}

/** Per-weapon resolved arc plus volley-wide direction/range fields.
 *  Returned by `validateAttacks` so `declareAttacks` (and any UIs that
 *  want to display the resolved arc before commit) can skip recomputing
 *  LOS, arc classification, and the to-hit range breakdown. */
export interface ValidatedAttackVolley {
  readonly targetId: string;
  readonly attackDirection: Arc;
  readonly attackDistance: number;
  readonly attackRangeBracket: RangeBracket;
  readonly attackRangeMod: number;
  readonly arcs: Readonly<Record<number, Arc>>;
}

/** Validation core shared by `validateAttacks` and `declareAttacks`.
 *  Runs every gate `declareAttacks` enforces: unit status (removed /
 *  shutdown / unconscious), sensors, prone arm-prop, and per-decl checks
 *  (weapon bounds, dup, jammed / destroyed, location, rapid-fire, single
 *  target, target validity, arc, LOS, range, to-hit, ammo). On success
 *  returns the volley's resolved arc, attack direction, distance, and
 *  range bracket. Does NOT mutate state, consume RNG, or emit events.
 *  Phase and actor-queue are checked by `declareAttacks`, not here. */
export function validateAttacksImpl(
  state: BattleState,
  unitId: string,
  decls: readonly AttackDecl[],
  options: ValidateAttacksOptions,
): ValidatedAttackVolley {
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is destroyed`);
  if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot fire`);
  if (unit.unconscious) throw new Error(`${unitId} is unconscious and cannot fire`);
  const def = getMechDefFor(unit);
  const sensorsOut = countDestroyedSensor(def, unit.damage, unit.critSlotsDestroyed);
  if (sensorsBlind(sensorsOut)) {
    throw new Error(`${unitId} cannot fire: sensors destroyed (no weapon attacks)`);
  }
  const sensorMod = sensorAttackModifier(sensorsOut);
  const effectiveFacing = effectiveFacingForTwist(unit.facing, options.twist ?? null);
  if (unit.prone) {
    const hasLeft = decls.some((d) => def.weapons[d.weaponIndex]?.location === "leftArm");
    const hasRight = decls.some((d) => def.weapons[d.weaponIndex]?.location === "rightArm");
    if (hasLeft && hasRight) {
      throw new Error(`${unitId} cannot fire while prone (volley uses both arms; prop one)`);
    }
  }

  let targetId: string | null = null;
  let attackDirection: Arc | undefined;
  let attackDistance = 0;
  let attackRangeBracket: RangeBracket = "short";
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
    if (unit.prone && (mount.location === "rightLeg" || mount.location === "leftLeg")) {
      throw new Error(`${mount.weapon} on ${unitId} cannot fire while prone (leg-mounted)`);
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
    if (isUnitRemoved(target)) throw new Error(`Target ${target.id} is removed from play`);
    if (target.team === unit.team) throw new Error("Target must belong to another team");

    const dist = hexDistance(unit.position, target.position);
    const b = bearingExact(unit.position, target.position);
    if (b === null) throw new Error("Attacker and target share a hex");
    // Attacker-side firing arc (weapon legality, TW p.105). On an exact
    // boundary line the target counts as lying in both arcs of the pair.
    // Torso twist rotates the attacker's effective facing (see
    // `effectiveFacingForTwist`) before this classification so arm and
    // front-torso weapons cover the twisted arc.
    const fireArc = classifyArcWithBoundary(effectiveFacing, b);
    arcs[decl.weaponIndex] = fireArc.arc;
    const rearFacing = mount.rearFacing === true;
    const inArc =
      weaponCanFireIntoArc(mount.location, rearFacing, fireArc.arc) ||
      (fireArc.altArc !== null && weaponCanFireIntoArc(mount.location, rearFacing, fireArc.altArc));
    if (!inArc) {
      throw new Error(
        `${mount.weapon} on ${unitId} cannot fire into the ${fireArc.arc} arc (target outside its firing arc)`,
      );
    }
    // Target-side attack direction (TW p.119): which side of the target the
    // attack strikes. Same for every weapon of this volley.
    if (attackDirection === undefined) {
      const back = bearingExact(target.position, unit.position)!;
      const dir = classifyArcWithBoundary(target.facing, back);
      attackDirection = defenderArcChoice(dir.arc, dir.altArc);
    }

    const woodsPoints = losWoodsPointsBetween(state, unit.position, target.position);
    if (!losClear(state, unit.position, target.position, state.wrecks)) {
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
      attackerProne: unit.prone,
      sensorMod,
      targetHexesMoved: target.movesThisTurn.length,
      targetJumped: target.jumpedThisTurn,
      targetImmobile: isImmobile(target),
      targetProne: target.prone,
      targetTerrain: cellAt(state, target.position).terrain,
      partialCoverMod: partialCoverMod(state, unit, target),
      interveningWoods: woodsPoints,
      distance: dist,
      weapon,
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
      const left = ammoWeaponTotals(def, unit.ammoBins)[decl.weaponIndex] ?? 0;
      if (left < needed) {
        throw new Error(`${mount.weapon}: needs ${needed} shot(s) but only ${left} remain`);
      }
    }
  });

  if (targetId === null) throw new Error("declareAttacks requires at least one declaration");
  return {
    targetId,
    attackDirection: attackDirection!,
    attackDistance,
    attackRangeBracket,
    attackRangeMod,
    arcs,
  };
}

export function validateAttacks(
  state: BattleState,
  unitId: string,
  decls: readonly AttackDecl[],
  options: ValidateAttacksOptions = {},
): void {
  validateAttacksImpl(state, unitId, decls, options);
}

export function declareAttacks(
  state: BattleState,
  unitId: string,
  decls: readonly AttackDecl[],
  sink: GameEvent[],
  rng: Rng = DEFAULT_RNG,
  options: DeclareAttacksOptions = {},
): void {
  requireCurrentActor(state, unitId, "weaponAttack");
  const unit = requireUnit(state, unitId);
  if (unit.declaredAttacks.length > 0)
    throw new Error(`${unitId} already declared attacks this turn`);
  const volley = validateAttacksImpl(state, unitId, decls, { twist: options.twist ?? null });
  const def = getMechDefFor(unit);
  // Consume non-streak per-bin ammo per decl; streak fires on hit and
  // resolves its own ammo in `resolveUnitAttacks`. RNG via ammo policy.
  for (const decl of decls) {
    unit.declaredAttacks.push({
      ...decl,
      ...(volley.arcs[decl.weaponIndex] !== undefined
        ? { arc: volley.arcs[decl.weaponIndex] }
        : {}),
      attackDirection: volley.attackDirection,
    });
    const mount = def.weapons[decl.weaponIndex];
    if (!mount) continue;
    const weapon = getWeaponDefFor(mount);
    const rapidFire = decl.rapidFire ?? false;
    const shots = rapidFire ? (weapon.rapidFireShots ?? 1) : 1;
    const needed = weapon.missiles !== undefined ? 1 : shots;
    if (binsForWeapon(def, decl.weaponIndex).length === 0) continue;
    if (weapon.streak === true) continue;
    unit.ammoBins = consumeAmmo(def, unit.ammoBins, decl.weaponIndex, needed, unit.ammoPolicy, rng);
  }
  unit.firedTargetId = volley.targetId;
  state.actedThisPhase.push(unitId);
  sink.push({
    kind: "attacksDeclared",
    unitId,
    targetId: volley.targetId,
    count: decls.length,
    distance: volley.attackDistance,
    rangeBracket: volley.attackRangeBracket,
    rangeMod: volley.attackRangeMod,
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
  const sensorMod = sensorAttackModifier(
    countDestroyedSensor(def, unit.damage, unit.critSlotsDestroyed),
  );
  const pronePropArm = inferPronePropArm(def, unit.declaredAttacks, unit.prone);
  let currentAmmoBins = { ...unit.ammoBins };
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
      attackerProne: unit.prone,
      ...(pronePropArm !== null ? { propArm: pronePropArm } : {}),
      sensorMod,
      targetHexesMoved: target.movesThisTurn.length,
      targetJumped: target.jumpedThisTurn,
      targetImmobile: isImmobile(target),
      targetProne: target.prone,
      targetTerrain: cellAt(state, target.position).terrain,
      partialCoverMod: partialCoverMod(state, unit, target),
      interveningTerrains: interveningTerrains(state, unit.position, target.position),
      distance: hexDistance(unit.position, target.position),
      // Resolution keys hit location and armor pool off the attack direction
      // (side of the target struck); the attacker-side firing arc only
      // gatekept the declaration.
      ...(decl.attackDirection !== undefined
        ? { arc: decl.attackDirection }
        : decl.arc !== undefined
          ? { arc: decl.arc }
          : {}),
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
    jammedWeapons,
  };
}

/**
 * Total armor + structure points lost between two damage states (TW "damage
 * points taken" for the 20-point PSR trigger).
 */
function damageTaken(before: UnitDamageState, after: UnitDamageState): number {
  let n = 0;
  for (const loc of LOCATIONS) {
    n += Math.max(0, before.armor[loc] - after.armor[loc]);
    if (isTorso(loc)) {
      n += Math.max(0, (before.armorRear[loc] ?? 0) - (after.armorRear[loc] ?? 0));
    }
    n += Math.max(0, before.internalStructure[loc] - after.internalStructure[loc]);
  }
  return n;
}

/** Append `extra` items to `base` skipping any already present. Returns `base`
 *  when nothing new arrives; otherwise a fresh array. */
function appendUnique<T>(base: readonly T[], extra: readonly T[]): T[] {
  if (extra.length === 0) return base.slice();
  const out = base.slice();
  for (const x of extra) if (!out.includes(x)) out.push(x);
  return out;
}

interface NewStructureHit {
  readonly location: Location;
  readonly name: string;
}

/** Structure slots destroyed now that were intact in the phase snapshot. */
function newlyDestroyedStructures(
  def: ResolvedMechDef,
  before: Readonly<Record<Location, readonly boolean[]>>,
  now: Readonly<Record<Location, readonly boolean[]>>,
): NewStructureHit[] {
  const out: NewStructureHit[] = [];
  for (const loc of Object.keys(def.critSlots) as Location[]) {
    const layout = def.critSlots[loc];
    const beforeFlags = before[loc] ?? [];
    const nowFlags = now[loc] ?? [];
    for (let i = 0; i < layout.length; i++) {
      const slot = layout[i];
      if (slot?.kind !== "structure") continue;
      if ((nowFlags[i] ?? false) && !(beforeFlags[i] ?? false)) {
        out.push({ location: loc, name: slot.name });
      }
    }
  }
  return out;
}

function legGone(damage: UnitDamageState, leg: "rightLeg" | "leftLeg"): boolean {
  return (damage.internalStructure[leg] ?? 0) <= 0;
}

/**
 * Deal `hits` pilot hits to `unit` (TW p.41-42): head hits, ammo explosions,
 * falls, and heat-soaked life support all land here. Every point forces a
 * consciousness roll (2D6 >= the table target) unless the pilot is already
 * unconscious; six total hits kills the pilot and destroys the unit.
 */
export function applyPilotHits(
  state: BattleState,
  unit: UnitState,
  hits: number,
  reason: PilotHitReason,
  rng: Rng,
  sink: GameEvent[],
): void {
  for (let i = 0; i < hits; i++) {
    if (isUnitRemoved(unit)) return;
    unit.pilotHits += 1;
    sink.push({
      kind: "pilotDamaged",
      unitId: unit.id,
      reason,
      hits: 1,
      totalHits: unit.pilotHits,
    });
    const target = consciousnessTarget(unit.pilotHits);
    if (target === null) {
      removePilotKilled(state, unit, sink);
      return;
    }
    // No further consciousness rolls once out this turn (TW p.42).
    if (unit.unconscious) continue;
    const { roll, success } = rollConsciousness(rng, target);
    const wasConscious = !unit.unconscious;
    sink.push({
      kind: "consciousnessCheck",
      unitId: unit.id,
      roll,
      target,
      success,
      hits: unit.pilotHits,
      consciousBefore: wasConscious,
    });
    if (!success) {
      unit.unconscious = true;
      unit.unconsciousSinceTurn = state.turn;
    }
  }
}

/**
 * Apply pre-rolled damage groupings (falling, building crashes) with the
 * normal crit cascade per stripping group; ammo explosions injure the pilot
 * (2 hits each). Returns the determining resolutions plus emitted events.
 */
function applyDamageGroups(
  state: BattleState,
  unit: UnitState,
  rng: Rng,
  groups: ReadonlyArray<{ location: Location; damage: number }>,
  arc: Arc,
  sink: GameEvent[],
): CriticalResolution[] {
  const def = getMechDefFor(unit);
  const crits: CriticalResolution[] = [];
  for (const group of groups) {
    const app = applyDamage(unit.damage, group.location, group.damage, arc);
    unit.damage = app.after;
    if (!state.critsDisabled) {
      const stripped = app.steps.some(
        (s) => s.location === group.location && s.pool === "structure" && s.damageApplied > 0,
      );
      if (stripped) {
        const res = resolveCriticalHits({
          rng,
          def,
          source: { location: group.location, damage: group.damage },
          critSlotsDestroyed: unit.critSlotsDestroyed,
          destroyedWeapons: unit.destroyedWeapons,
          damage: unit.damage,
          ammoBins: unit.ammoBins,
        });
        unit.critSlotsDestroyed = res.critSlotsDestroyed;
        unit.destroyedWeapons = res.destroyedWeapons;
        unit.ammoBins = res.ammoBins;
        unit.damage = res.damage;
        for (const row of res.rows) {
          if (row.kind === "ammoExplosion")
            applyPilotHits(state, unit, 2, "ammoExplosion", rng, sink);
        }
        crits.push(res);
      }
    }
  }
  for (const loc of LOCATIONS) {
    if ((unit.damage.internalStructure[loc] ?? 0) <= 0) {
      stripBinsInLocation(unit.ammoBins, loc);
    }
  }
  if (
    isUnitAvailable(unit) &&
    (isUnitDestroyed(unit.damage) || crits.some((c) => c.killedReason !== null))
  ) {
    markUnitDestroyed(unit, destroyedReasonFor(unit.damage, crits), sink);
  }
  return crits;
}
export interface FallOptions {
  /** failedPsr:<reason> | legDestroyed | gyroDestroyed | water | rubble | building. */
  readonly cause: string;
  /**
   * Seatbelt-check modifier (same modifiers as the failed PSR; +5 for an
   * automatic fall off a destroyed leg, +6 off a destroyed gyro). `null`
   * skips the roll — the pilot takes 1 hit automatically (shut-down fall).
   */
  readonly seatbeltModifier: number | null;
  /** Halve the falling damage, rounding down (fall underwater, depth 2+). */
  readonly halved: boolean;
  /** Underlying-terrain levels fallen (TW p.68): hex fell into minus hex
   *  the fall began from. Defaults to 0 (same-hex fall); callers that fall
   *  while moving across levels pass the drop. Jump-phase falls stay 0
   *  per errata even when the landing sits at another level. */
  readonly levelsFallen?: number;
  /** Allow the fall damage path on an already-prone unit (failed stand-up). */
  readonly allowProne?: boolean;
}

/**
 * Immediate PSR when a unit's reactor shuts down (TW p.60, +3): rolled with
 * preexisting-damage modifiers even though the 'Mech is now down (only
 * *other* PSRs required while shut down fail automatically). Failure drops
 * the 'Mech on the spot; the pilot then takes the hit automatically via the
 * shutdown path in `applyFall`. No-op for removed or already-prone units.
 */
function shutdownFallCheck(state: BattleState, unit: UnitState, rng: Rng, sink: GameEvent[]): void {
  if (isUnitRemoved(unit) || unit.prone) return;
  const def = getMechDefFor(unit);
  const pre = preexistingDamageModifier(def, unit.damage, unit.critSlotsDestroyed);
  const modifier = SHUTDOWN_PSR_MOD + pre.modifier;
  const r = rollPilotingCheck(rng, unit.piloting, modifier);
  sink.push({
    kind: "pilotingCheck",
    unitId: unit.id,
    reason: "shutdown",
    modifier,
    target: r.target,
    roll: r.roll,
    success: r.success,
  });
  if (!r.success) {
    applyFall(state, unit, rng, { cause: "shutdown", seatbeltModifier: null, halved: false }, sink);
  }
}

/**
 * Drop `unit` to the ground (TW p.68): facing rotates per the Facing After
 * Fall roll, `ceil(tonnage / 10) x (levels fallen + 1)` damage lands in
 * 5-point clusters on the fall column (with crit rolls like any damage;
 * halved rounding down underwater), and the pilot makes a seatbelt PSR or
 * takes 1 hit. A no-op on an already-prone unit unless `allowProne` is set
 * (a failed stand-up crashes back down).
 */
export function applyFall(
  state: BattleState,
  unit: UnitState,
  rng: Rng,
  opts: FallOptions,
  sink: GameEvent[],
): void {
  if (isUnitRemoved(unit)) return;
  if (unit.prone && opts.allowProne !== true) return;
  const def = getMechDefFor(unit);
  const dir = rollFallDirection(rng);
  unit.facing = facingAfterFall(unit.facing, dir.shift);
  unit.prone = true;

  const levels = opts.levelsFallen ?? 0;
  let total = fallingDamageTotal(def.tonnage, levels);
  if (opts.halved) total = Math.floor(total / 2);
  const groups: Array<{ location: Location; damage: number }> = [];
  for (const amount of fallingDamageGroups(total)) {
    groups.push({ location: hitLocationForArc(dir.column, roll2D6(rng)), damage: amount });
  }
  const crits = applyDamageGroups(
    state,
    unit,
    rng,
    groups,
    dir.column === "rear" ? "rear" : "front",
    sink,
  );
  sink.push({
    kind: "unitFell",
    unitId: unit.id,
    cause: opts.cause,
    facingAfter: unit.facing,
    fallRoll: dir.roll,
    column: dir.column,
    levelsFallen: levels,
    groups,
    totalDamage: total,
    crits,
  });

  // Seatbelt check (TW p.68): same modifiers as the failed roll, or automatic
  // pilot damage when the 'Mech is immobile or the TN exceeds 12.
  const down = isShutdown(unit) || unit.unconscious || isUnitImmobile(unit.damage);
  const modifier = opts.seatbeltModifier;
  if (modifier === null || down || unit.piloting + modifier > D2D6_MAX) {
    applyPilotHits(
      state,
      unit,
      FALL_PILOT_HITS,
      modifier === null ? "shutdownFall" : "fall",
      rng,
      sink,
    );
  } else {
    const r = rollPilotingCheck(rng, unit.piloting, modifier);
    sink.push({
      kind: "pilotingCheck",
      unitId: unit.id,
      reason: "seatbelt",
      modifier,
      target: r.target,
      roll: r.roll,
      success: r.success,
    });
    if (!r.success) applyPilotHits(state, unit, FALL_PILOT_HITS, "fall", rng, sink);
  }
  if (isUnitAvailable(unit) && isUnitDestroyed(unit.damage)) {
    markUnitDestroyed(unit, destroyedReasonFor(unit.damage), sink);
  }
}

export interface PhaseSnapshots {
  readonly damage: Record<string, UnitDamageState>;
  readonly crit: Record<string, Record<Location, boolean[]>>;
}

/**
 * End-of-phase piloting sweep (TW p.59-60): every standing unit that took
 * 20+ damage rolls a PSR (+1); every newly destroyed leg/foot actuator (+1),
 * hip (+2), and first gyro hit (+3) forces its own PSR; a destroyed second
 * gyro slot or a destroyed leg falls the 'Mech automatically. A shut-down or
 * unconscious unit that must roll falls automatically instead. Stops a unit's
 * queue at its first failed roll. Fall damage never re-triggers the sweep.
 */
export function resolvePhasePiloting(
  state: BattleState,
  rng: Rng,
  before: PhaseSnapshots,
  sink: GameEvent[],
): void {
  for (const unit of Object.values(state.units)) {
    if (isUnitRemoved(unit) || unit.prone) continue;
    const def = getMechDefFor(unit);
    const dmgBefore = before.damage[unit.id] ?? unit.damage;
    const critBefore = before.crit[unit.id] ?? unit.critSlotsDestroyed;
    const pre = preexistingDamageModifier(def, dmgBefore, critBefore);

    const triggers: Array<{ reason: string; modifier: number }> = [];
    if (damageTaken(dmgBefore, unit.damage) >= PSR_DAMAGE_THRESHOLD) {
      triggers.push({ reason: "damage20", modifier: PHASE_DAMAGE_PSR_MOD });
    }
    for (const hit of newlyDestroyedStructures(def, critBefore, unit.critSlotsDestroyed)) {
      if (hit.name === HIP) triggers.push({ reason: "hip", modifier: HIP_MOD });
      else if (LEG_ACTUATORS.has(hit.name))
        triggers.push({ reason: "legActuator", modifier: LEG_ACTUATOR_MOD });
    }
    const gyroBefore = countDestroyedGyro(def, dmgBefore, critBefore);
    const gyroNow = countDestroyedGyro(def, unit.damage, unit.critSlotsDestroyed);
    if (gyroNow < GYRO_DESTROYED_HITS && gyroBefore < 1 && gyroNow >= 1) {
      triggers.push({ reason: "gyro", modifier: GYRO_HIT_MOD });
    }
    let autoFall: { cause: string; seatbelt: number | null } | null = null;
    const legDestroyed =
      (legGone(unit.damage, "rightLeg") && !legGone(dmgBefore, "rightLeg")) ||
      (legGone(unit.damage, "leftLeg") && !legGone(dmgBefore, "leftLeg"));
    if (legDestroyed) autoFall = { cause: "legDestroyed", seatbelt: SEATBELT_LEG_DESTROYED };
    else if (gyroNow >= GYRO_DESTROYED_HITS && gyroBefore < GYRO_DESTROYED_HITS)
      autoFall = { cause: "gyroDestroyed", seatbelt: SEATBELT_GYRO_DESTROYED };

    let fell = false;
    for (const t of triggers) {
      const modifier = t.modifier + pre.modifier;
      if (isShutdown(unit) || unit.unconscious) {
        // TW p.60: a PSR required of a shut-down 'Mech falls it automatically
        // (and the pilot takes the hit automatically).
        autoFall = { cause: `failedPsr:${t.reason}`, seatbelt: null };
        break;
      }
      const r = rollPilotingCheck(rng, unit.piloting, modifier);
      sink.push({
        kind: "pilotingCheck",
        unitId: unit.id,
        reason: t.reason,
        modifier,
        target: r.target,
        roll: r.roll,
        success: r.success,
      });
      if (!r.success) {
        const terrain = cellAt(state, unit.position).terrain;
        const halved = terrain === "water2" || terrain === "water3";
        applyFall(
          state,
          unit,
          rng,
          {
            cause: `failedPsr:${t.reason}`,
            seatbeltModifier: modifier,
            halved,
          },
          sink,
        );
        fell = true;
        break;
      }
    }
    if (!fell && autoFall !== null) {
      const terrain = cellAt(state, unit.position).terrain;
      const halved = terrain === "water2" || terrain === "water3";
      applyFall(
        state,
        unit,
        rng,
        {
          cause: autoFall.cause,
          seatbeltModifier: autoFall.seatbelt,
          halved,
        },
        sink,
      );
    }
  }
}

/**
 * Phase-end sweep: resolve every unit's declared attacks simultaneously.
 * All declarations are collected first (during the weapon attack phase),
 * then damage is applied in two phases: collect all resolutions, then
 * apply damage/crits/heat simultaneously. TW resolves weapon attacks
 * simultaneously — a 'Mech killed during the weapon attack phase still
 * fires its declared shots.
 */
export function resolveAllAttacks(state: BattleState, rng: Rng, sink: GameEvent[]): void {
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
  const targetAmmoBinsMap: Record<string, AmmoBins> = {};
  const targetDestroyedWeaponsMap: Record<string, number[]> = {};
  const buildingOutcomes: BuildingDamageResult[] = [];
  /** First crit-derived kill reason per target (cockpit, engine, head
   *  blow-off); drives `markUnitDestroyed` when the damage state alone
   *  wouldn't show a kill (the engine-crit case). */
  const targetKilledReason: Record<string, DestroyedReason> = {};

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
        const outcome = damageBuildingAt(state, target.position, buildingDamage, sink);
        if (outcome !== null) buildingOutcomes.push(outcome);
      }

      // Emit attackResolved event
      sink.push({
        kind: "attackResolved",
        unitId: result.unitId,
        targetId,
        resolution,
      });
    }

    // Apply attacker's ammo state changes
    const attacker = requireUnit(state, result.unitId);
    attacker.ammoBins = result.finalAmmoBins;
    for (const wi of result.jammedWeapons) {
      if (!attacker.jammedWeapons.includes(wi)) {
        attacker.jammedWeapons.push(wi);
      }
    }

    // Apply attacker's weapon heat (deferred).
    const totalWeaponHeat = result.resolutions.reduce((sum, r) => sum + r.weaponHeat, 0);
    if (totalWeaponHeat > 0) {
      attacker.heatPending += totalWeaponHeat;
      sink.push({
        kind: "heatWeapon",
        unitId: attacker.id,
        weapon: result.resolutions[0]?.resolution.weapon ?? "",
        heat: totalWeaponHeat,
        base: attacker.heat,
        totalGenerated: attacker.heatPending,
      });
    }
  }

  // Apply crits sequentially per target. TW p. 38 simultaneity: all damage
  // and crits from a volley take effect at end of phase, so flags set by
  // earlier weapons must persist for later weapons and survive into the
  // unit's persistent state. Each crit's `critSlotsDestroyed` was resolved
  // from a fresh pre-volley snapshot inside `resolveWeaponAttack` and
  // therefore only carries ITS own hits — merge (OR) into the running
  // accumulator instead of overwriting.
  for (const [targetId, crits] of Object.entries(targetCritsMap)) {
    if (crits.length === 0) continue;
    const target = requireUnit(state, targetId);
    const currentDamage = targetDamageMap[targetId]!;
    // Clone the inner arrays so OR-merge below mutates a fresh copy, not
    // the unit's persistent table.
    const currentCritSlots: Record<Location, boolean[]> = {} as Record<Location, boolean[]>;
    for (const loc of Object.keys(target.critSlotsDestroyed) as Location[]) {
      currentCritSlots[loc] = target.critSlotsDestroyed[loc]!.slice();
    }
    let currentDestroyedWeapons = [...(targetDestroyedWeaponsMap[targetId] ?? [])];
    let currentAmmoBins: AmmoBins = {
      ...(targetAmmoBinsMap[targetId] ?? target.ammoBins),
    };

    for (const crit of crits) {
      // OR new destroyed flags into the accumulator. TW p. 124–125: crit
      // re-roll skips already-destroyed slots; crit transfer checks prior
      // hits in the location. Both rules require flags to be visible
      // across weapons in the same volley.
      for (const loc of Object.keys(crit.critSlotsDestroyed) as Location[]) {
        const next = crit.critSlotsDestroyed[loc];
        const cur = currentCritSlots[loc];
        if (cur === undefined) {
          currentCritSlots[loc] = next.slice();
          continue;
        }
        for (let i = 0; i < next.length; i++) if (next[i]) cur[i] = true;
      }
      currentDestroyedWeapons = appendUnique(currentDestroyedWeapons, crit.destroyedWeapons);
      // Ammo bins: per-bin last-write-wins. Two weapons in the same volley
      // never share a bin id (each crit touches bins only in the location
      // it hit, and simultaneous weapons can't both hit the same bin), so
      // the spread already preserves earlier hits.
      currentAmmoBins = { ...currentAmmoBins, ...crit.ammoBins };

      // Merge newly destroyed / blown off arms from crit
      for (const arm of crit.blownOffArms) {
        currentDamage.armor[arm] = 0;
        currentDamage.internalStructure[arm] = 0;
      }
      if (crit.killedReason !== null && targetKilledReason[targetId] === undefined) {
        targetKilledReason[targetId] = crit.killedReason;
      }
    }

    targetDamageMap[targetId] = currentDamage;
    targetCritsMap[targetId] = []; // consumed
    // Update target's persistent crit state
    target.critSlotsDestroyed = currentCritSlots;
    target.destroyedWeapons = currentDestroyedWeapons;
    target.ammoBins = currentAmmoBins;
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
      sink.push({
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
    if (
      isUnitAvailable(unit) &&
      (isUnitDestroyed(unit.damage) || targetKilledReason[unit.id] !== undefined)
    ) {
      markUnitDestroyed(unit, targetKilledReason[unit.id] ?? destroyedReasonFor(unit.damage), sink);
    }
  }

  // Pilot damage (TW p.41): a head hit lands 1 point per damaging grouping,
  // an ammo explosion 2 points. Consciousness rolls run per point at once,
  // before any Piloting Skill Rolls (TW p.42 errata).
  for (const result of results) {
    for (const { targetId, resolution } of result.resolutions) {
      if (!resolution.hit) continue;
      const target = requireUnit(state, targetId);
      if (isUnitRemoved(target)) continue;
      const headGroups = resolution.groups.filter(
        (g) => g.location === "head" && g.damage >= 1,
      ).length;
      if (headGroups > 0)
        applyPilotHits(state, target, headGroups * HEAD_HIT_PILOT_HITS, "headHit", rng, sink);
      let ammoBlasts = 0;
      for (const crit of resolution.crits) {
        for (const row of crit.rows) {
          if (row.kind === "ammoExplosion") ammoBlasts += 1;
        }
      }
      if (ammoBlasts > 0)
        applyPilotHits(
          state,
          target,
          ammoBlasts * AMMO_BLAST_PILOT_HITS,
          "ammoExplosion",
          rng,
          sink,
        );
    }
  }
  for (const unit of Object.values(state.units)) {
    if (isUnitAvailable(unit) && isUnitDestroyed(unit.damage)) {
      markUnitDestroyed(unit, destroyedReasonFor(unit.damage), sink);
    }
  }

  // End-of-phase piloting: falls from this phase's damage and crits.
  const before: PhaseSnapshots = { damage: phaseStartDamage, crit: {} };
  for (const unit of Object.values(state.units)) {
    before.crit[unit.id] = unit.phaseStartCritSlotsDestroyed;
  }
  resolvePhasePiloting(state, rng, before, sink);

  // Clear declared attacks for all units
  for (const unit of Object.values(state.units)) {
    unit.declaredAttacks = [];
  }
}

export function advancePhase(state: BattleState, sink: GameEvent[], rng: Rng = DEFAULT_RNG): void {
  const prevTurn = state.turn;
  const prevPhase = state.phase;
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
        unit.phaseStartCritSlotsDestroyed = cloneCritDestroyed(unit.critSlotsDestroyed);
      }
      state.actedThisPhase = [];
      break;
    }
    case "weaponAttack": {
      for (const unit of Object.values(state.units)) {
        if (isUnitAvailable(unit) && isUnitDestroyed(unit.damage)) {
          markUnitDestroyed(unit, destroyedReasonFor(unit.damage), sink);
        }
      }
      // The end phase starts with heat resolution: engine crit heat,
      // shutdown/restart checks, heat ammo explosions, then dissipation.
      resolveHeatPhase(state, rng, sink);
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
      break;
    }
  }
  sink.push({ kind: "phase", prevTurn, prevPhase, turn: state.turn, phase: state.phase });
}

/**
 * Run one turn's heat resolution as the weapon attack phase hands off to the
 * end phase. TW p.159 reads the heat scale update as a single step:
 * "add own heat + outside heat, subtract heat sink dissipation, apply the net
 * result to the Heat Scale." Movement, weapon, posture, and engine-crit heat
 * were all accumulated into `unit.heatPending` during their producing
 * phases; here we land them on the scale, subtract dissipation, then run the
 * shutdown/restart and ammo-explosion checks against `max(startHeat, endHeat)`
 * (the worst the scale reached at any discrete read — start, post-own-heat,
 * or post-dissipation). Peak within the heat phase has no separate meaning;
 * the user's TW p.159 reading explicitly rejects it.
 *
 * Engine crit heat is skipped for any non-online unit (TW p.160: "even
 * engine criticals generate no extra heat while shut down"), bundled with
 * the rest of the deferred own-heat.
 *
 * Shutdown / restart uses `roll >= avoid` for success (matches the
 * voluntary startup and ammo-explosion checks; previously the involuntary
 * branch used `roll <= avoid = fail`, an off-by-one).
 */
export function resolveHeatPhase(state: BattleState, rng: Rng, sink: GameEvent[]): void {
  const units = Object.values(state.units).filter((u) => !isUnitRemoved(u));
  const before: PhaseSnapshots = { damage: {}, crit: {} };

  // Single pass: snapshot pre-heat-phase state, then for each unit apply
  // deferred own-heat, dissipate, run shutdown/restart, run ammo explosion,
  // apply life-support pilot damage, attempt consciousness wakeup. Per-unit
  // mutations are isolated; cross-iteration state is only `before`, captured
  // here and consumed by `resolvePhasePiloting` after the loop.
  for (const unit of units) {
    // Snapshot pre-heat-phase damage/crit for `resolvePhasePiloting` diff.
    before.damage[unit.id] = {
      armor: { ...unit.damage.armor },
      armorRear: { ...unit.damage.armorRear },
      internalStructure: { ...unit.damage.internalStructure },
    };
    before.crit[unit.id] = cloneCritDestroyed(unit.critSlotsDestroyed);

    const def = getMechDefFor(unit);
    const startHeat = unit.heat;
    const heatPending = unit.heatPending;

    // Apply deferred own-heat: movement + weapon + posture + engine crit
    // (engine crit only if online per TW p.160). Reset pending; the
    // post-own-heat read is the scale value dissipation will subtract from.
    const engineHeat = isNominal(unit)
      ? engineHitHeat(countDestroyedEngine(def, unit.damage, unit.critSlotsDestroyed))
      : 0;
    const totalGenerated = heatPending + engineHeat;
    if (totalGenerated > 0) {
      unit.heat = Math.min(HEAT_CAP, unit.heat + totalGenerated);
      if (engineHeat > 0) {
        sink.push({
          kind: "heatEngineCrit",
          unitId: unit.id,
          heat: engineHeat,
          base: startHeat,
          totalGenerated,
        });
      }
    }
    unit.heatPending = 0;

    // Dissipate (TW p.159 net update; applies to all units including
    // shut-down — heat sinks keep working).
    const capacity = heatDissipation(def, unit.critSlotsDestroyed);
    const capacityMax = heatDissipationMax(def);
    const dissipated = Math.min(capacity, unit.heat);
    const endHeat = unit.heat - dissipated;
    unit.heat = endHeat;
    if (dissipated > 0 || totalGenerated > 0) {
      sink.push({
        kind: "heatDissipated",
        unitId: unit.id,
        dissip: dissipated,
        startHeat,
        totalGenerated,
        endHeat,
        netChange: endHeat - startHeat,
        capacity,
        capacityMax,
      });
    }

    // Shutdown / restart at checkHeat = max(start, end). Voluntary "manual"
    // and pending "starting" skip (voluntary restart only; comes-online at
    // next initiative roll).
    if (unit.shutdown !== "manual" && unit.shutdown !== "starting") {
      const checkHeat = Math.max(startHeat, endHeat);
      const { avoid, threshold } = shutdownAvoidWithThreshold(checkHeat);

      if (unit.shutdown === "heat") {
        // Already heat-shut-down: restart path.
        if (avoid === 0) {
          unit.shutdown = "not";
          sink.push({
            kind: "restartCheck",
            unitId: unit.id,
            success: true,
            manual: false,
            roll: 0,
            heat: checkHeat,
            avoid: 0,
            threshold,
          });
        } else {
          const roll = roll2D6(rng);
          if (roll >= avoid) {
            unit.shutdown = "not";
            sink.push({
              kind: "restartCheck",
              unitId: unit.id,
              success: true,
              manual: false,
              roll,
              heat: checkHeat,
              avoid,
              threshold,
            });
          } else {
            sink.push({
              kind: "restartCheck",
              unitId: unit.id,
              success: false,
              manual: false,
              roll,
              heat: checkHeat,
              avoid,
              threshold,
            });
          }
        }
      } else if (avoid > 0) {
        // Online unit — initial check.
        if (avoid >= D2D6_MAX) {
          // 30+ heat: auto-shutdown (TW p.160 "Shutdown cannot be avoided
          // at 30+ heat").
          unit.shutdown = "heat";
          sink.push({
            kind: "shutdownCheck",
            unitId: unit.id,
            avoided: false,
            manual: false,
            roll: 0,
            heat: checkHeat,
            avoid,
            threshold,
          });
          shutdownFallCheck(state, unit, rng, sink);
        } else {
          const roll = roll2D6(rng);
          if (roll >= avoid) {
            sink.push({
              kind: "shutdownCheck",
              unitId: unit.id,
              avoided: true,
              manual: false,
              roll,
              heat: checkHeat,
              avoid,
              threshold,
            });
          } else {
            unit.shutdown = "heat";
            sink.push({
              kind: "shutdownCheck",
              unitId: unit.id,
              avoided: false,
              manual: false,
              roll,
              heat: checkHeat,
              avoid,
              threshold,
            });
            shutdownFallCheck(state, unit, rng, sink);
          }
        }
      }
    }

    // Heat ammo explosion at the same checkHeat. Largest loaded explosive
    // bin; on avoidance fail it detonates against the bin's location with
    // CASE-aware damage transfer.
    if (!isUnitRemoved(unit)) {
      const checkHeat = Math.max(startHeat, endHeat);
      const { avoid, threshold } = ammoExplosionAvoidWithThreshold(checkHeat)!;
      if (avoid > 0) {
        const bin = largestAmmoBin(def, unit.ammoBins, rng);
        if (bin !== null) {
          const roll = roll2D6(rng);
          if (roll >= avoid) {
            sink.push({
              kind: "ammoExplosionCheck",
              unitId: unit.id,
              weapon: bin.weapon,
              location: bin.location,
              slotIndex: bin.slotIndex,
              roll,
              heat: checkHeat,
              avoid,
              threshold,
              shotsRemaining: bin.shotsRemaining,
              damage: bin.damage,
              damagePerShot: bin.damagePerShot,
              avoided: true,
            });
          } else {
            const application = applyAmmoExplosion(
              unit.damage,
              bin.location,
              bin.damage,
              checkCASE(def, bin.location),
            );
            unit.damage = application.after;
            // Mark every freshly-zeroed location as catastrophic so
            // counters (`countDestroyedEngine`, `heatSinksOperational`,
            // `effectiveMovement`) report truthful destruction state for
            // the rest of the phase. No cascade `runDetermining` here —
            // heat-triggered ammo explosions do not chain crit determining.
            for (const lost of application.newlyDestroyed) {
              markLocationCatastrophicallyDestroyed(
                unit.damage,
                unit.critSlotsDestroyed,
                unit.ammoBins,
                lost,
              );
            }
            const slot = collectAmmoBins(def).find((b) => b.id === bin.binId);
            if (slot !== undefined) unit.ammoBins[bin.binId] = { ...slot, shots: 0 };
            sink.push({
              kind: "ammoExplosionCheck",
              unitId: unit.id,
              weapon: bin.weapon,
              location: bin.location,
              slotIndex: bin.slotIndex,
              roll,
              heat: checkHeat,
              avoid,
              threshold,
              shotsRemaining: bin.shotsRemaining,
              damage: bin.damage,
              damagePerShot: bin.damagePerShot,
              avoided: false,
            });
            // TW p.160: ammo explosion auto-deals 2 pilot hits and a
            // Consciousness Roll per hit. Apply before the destroyed check
            // so a pilot killed by the explosion is recorded with reason
            // "pilotKilled" rather than the explosion's structural kill.
            applyPilotHits(state, unit, AMMO_BLAST_PILOT_HITS, "ammoExplosion", rng, sink);
            if (isUnitAvailable(unit) && isUnitDestroyed(unit.damage)) {
              markUnitDestroyed(unit, destroyedReasonFor(unit.damage), sink);
            }
          }
        }
      }
    }

    // Life-support pilot damage (TW p.41): 1 hit at end-of-phase heat 15+,
    // 2 hits at 26+. Skip if ammo explosion just removed the unit.
    if (!isUnitRemoved(unit)) {
      if (countDestroyedLifeSupport(def, unit.damage, unit.critSlotsDestroyed) > 0) {
        if (unit.heat >= LIFE_SUPPORT_HEAT_2HITS)
          applyPilotHits(state, unit, 2, "lifeSupport", rng, sink);
        else if (unit.heat >= LIFE_SUPPORT_HEAT_1HIT)
          applyPilotHits(state, unit, 1, "lifeSupport", rng, sink);
      }
    }

    // Consciousness wakeup (TW p.42): end phase of a turn after the
    // knockout turn. May flip `unconscious` false if the roll passes.
    if (
      !isUnitRemoved(unit) &&
      unit.unconscious &&
      unit.unconsciousSinceTurn !== null &&
      unit.unconsciousSinceTurn < state.turn
    ) {
      const target = consciousnessTarget(unit.pilotHits);
      if (target !== null) {
        const { roll, success } = rollConsciousness(rng, target);
        if (success) {
          unit.unconscious = false;
          unit.unconsciousSinceTurn = null;
        }
        sink.push({
          kind: "consciousnessCheck",
          unitId: unit.id,
          roll,
          target,
          success,
          hits: unit.pilotHits,
          consciousBefore: false,
        });
      }
    }
  }

  // End-of-heat-phase piloting: falls from heat-phase ammo-explosion damage.
  resolvePhasePiloting(state, rng, before, sink);
}

/**
 * Movement terrain PSRs for one entered hex (TW p.60, p.167): entering water
 * (depth 1: -1, depth 2: +0, depth 3+: +1), rubble (+0), or a building hex
 * (light +0 / medium +1 / heavy +2 / hardened +5). Exiting a building hex
 * does NOT trigger a PSR (TW p.170). Failed water/rubble rolls drop the
 * 'Mech in the hex; a failed building roll crashes it (ceil(CF / 10)
 * front-column damage, no fall) instead. A fall across levels drops into
 * the lower of the two hexes (TW p.68) with levels fallen feeding damage
 * and the seatbelt check (+1 per level above 1); jump landings stay
 * 0-level falls per errata. Returns the hex the move stops in when it
 * must stop here (fell, crashed, or shut down mid-path), or null to
 * continue.
 */
function movementTerrainPsr(
  state: BattleState,
  unit: UnitState,
  rng: Rng,
  from: HexCoord,
  to: HexCoord,
  ground: boolean,
  preModifier: number,
  sink: GameEvent[],
): HexCoord | null {
  const stop = (): boolean =>
    unit.prone || isUnitRemoved(unit) || isShutdown(unit) || unit.unconscious;
  /** Lower hex of the step plus levels fallen into it (jump: landing, 0). */
  const lowerLanding = (hex: HexCoord): { lower: HexCoord; levels: number } => {
    if (!ground) return { lower: hex, levels: 0 };
    const fromLevel = cellAt(state, from).level;
    const toLevel = cellAt(state, to).level;
    const lower = toLevel <= fromLevel ? to : from;
    return { lower, levels: Math.max(0, fromLevel - cellAt(state, lower).level) };
  };
  const rollFall = (
    reason: string,
    trigger: number,
    cause: string,
    hex: HexCoord,
  ): HexCoord | null => {
    const modifier = trigger + preModifier;
    const { lower, levels } = lowerLanding(hex);
    if (isShutdown(unit) || unit.unconscious) {
      const terrain = cellAt(state, lower).terrain;
      applyFall(
        state,
        unit,
        rng,
        {
          cause,
          seatbeltModifier: null,
          halved: terrain === "water2" || terrain === "water3",
          levelsFallen: levels,
        },
        sink,
      );
      return lower;
    }
    const r = rollPilotingCheck(rng, unit.piloting, modifier);
    sink.push({
      kind: "pilotingCheck",
      unitId: unit.id,
      reason,
      modifier,
      target: r.target,
      roll: r.roll,
      success: r.success,
    });
    if (r.success) return null;
    const terrain = cellAt(state, lower).terrain;
    applyFall(
      state,
      unit,
      rng,
      {
        cause,
        seatbeltModifier: modifier + Math.max(0, levels - 1),
        halved: terrain === "water2" || terrain === "water3",
        levelsFallen: levels,
      },
      sink,
    );
    return lower;
  };
  const entering = cellAt(state, to).terrain;
  const water = waterEntryModifier(entering);
  if (water !== null) {
    const reason = entering === "water1" ? "water1" : entering === "water2" ? "water2" : "water3";
    const fellAt = rollFall(reason, water, "water", to);
    if (fellAt !== null) return fellAt;
    if (stop()) return to;
  }
  if (entering === "rubble") {
    const fellAt = rollFall("rubble", 0, "rubble", to);
    if (fellAt !== null) return fellAt;
    if (stop()) return to;
  }
  const building = buildingEntryModifier(entering);
  const def = getMechDefFor(unit);
  if (building !== null) {
    const legWasGoneR = legGone(unit.damage, "rightLeg");
    const legWasGoneL = legGone(unit.damage, "leftLeg");
    const gyroWasGone = countDestroyedGyro(def, unit.damage, unit.critSlotsDestroyed);
    const modifier = building + preModifier;
    if (isShutdown(unit) || unit.unconscious) {
      applyFall(
        state,
        unit,
        rng,
        { cause: "building", seatbeltModifier: null, halved: false },
        sink,
      );
      return to;
    }
    const r = rollPilotingCheck(rng, unit.piloting, modifier);
    sink.push({
      kind: "pilotingCheck",
      unitId: unit.id,
      reason: "building",
      modifier,
      target: r.target,
      roll: r.roll,
      success: r.success,
    });
    if (!r.success) {
      const cf = state.buildings[`${to.col},${to.row}`]?.cf ?? 0;
      const total = Math.ceil(cf / BUILDING_CRASH_DIVISOR);
      const groups: Array<{ location: Location; damage: number }> = [];
      for (const amount of fallingDamageGroups(total)) {
        groups.push({ location: hitLocation(roll2D6(rng)), damage: amount });
      }
      const crits = applyDamageGroups(state, unit, rng, groups, "front", sink);
      sink.push({
        kind: "buildingCrash",
        unitId: unit.id,
        col: to.col,
        row: to.row,
        groups,
        totalDamage: total,
        crits,
      });
      // A crash that wrecks a leg or the gyro (or knocks the pilot out via
      // an ammo blast) drops the 'Mech on the spot (TW automatic fall);
      // without this the unit would stand into the weapon phase on a gone
      // leg or keep moving while unconscious.
      if (!unit.prone && !isUnitRemoved(unit)) {
        const legFell =
          (!legWasGoneR && legGone(unit.damage, "rightLeg")) ||
          (!legWasGoneL && legGone(unit.damage, "leftLeg"));
        const gyroNow = countDestroyedGyro(def, unit.damage, unit.critSlotsDestroyed);
        const gyroFell = gyroNow >= GYRO_DESTROYED_HITS && gyroWasGone < GYRO_DESTROYED_HITS;
        const down = isShutdown(unit) || unit.unconscious;
        if (legFell || gyroFell || down) {
          applyFall(
            state,
            unit,
            rng,
            {
              cause: "building",
              seatbeltModifier: down
                ? null
                : gyroFell
                  ? SEATBELT_GYRO_DESTROYED
                  : SEATBELT_LEG_DESTROYED,
              halved: false,
            },
            sink,
          );
        }
      }
      return to;
    }
  }
  return stop() ? to : null;
}

/**
 * Stand-up attempt for a prone unit (TW p.50): spends `STAND_MP_COST` (or the
 * remaining walk budget, whichever is smaller — TW p.50 lets a 1-MP-prone
 * 'Mech like a one-leg unit still attempt to stand) and adds 1 heat, then
 * rolls a PSR with preexisting-damage modifiers only. On success the 'Mech
 * is left standing facing the direction it had been prone in; on failure it
 * crashes back down for fresh falling damage. A 'Mech with a destroyed gyro,
 * both legs gone, or one leg + both arms gone cannot attempt to stand (TW
 * p.50).
 *
 * Returns the MP cost actually charged for the stand, so the caller can
 * chain an `executeMove` with `options.spentMP = <returned>` for the
 * continuation. `attemptStandUp` pushes `unitId` to `actedThisPhase` so the
 * chained `executeMove` skips the head-of-queue guard and the redundant
 * `actedThisPhase` push, marking the activation exactly once.
 */
export function attemptStandUp(
  state: BattleState,
  unitId: string,
  sink: GameEvent[],
  rng: Rng = DEFAULT_RNG,
): number {
  requirePhase(state, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (!unit.prone) throw new Error(`${unitId} is not prone`);
  if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot stand up`);
  if (unit.unconscious) throw new Error(`${unitId} is unconscious and cannot stand up`);
  const def = getMechDefFor(unit);
  const pre = preexistingDamageModifier(def, unit.damage, unit.critSlotsDestroyed);
  const budget = effectiveMoveBudget(
    "walk",
    effectiveMovement(def, unit.damage, unit.critSlotsDestroyed),
    unit.heat,
  );
  if (pre.gyroHits >= GYRO_DESTROYED_HITS)
    throw new Error(`${unitId} has a destroyed gyro and cannot stand up`);
  if (!canAttemptStandUp(unit.damage)) throw new Error(`${unitId} cannot stand up in this state`);
  // TW p.50: a prone 'Mech with only 1 MP (e.g. a one-leg 'Mech) may still
  // attempt to stand, but the stand cost is whatever walking budget they
  // have. Charge the actual budget so the move still resolves.
  const standCost = Math.min(STAND_MP_COST, budget);
  unit.moveMode = "walk";
  unit.movesThisTurn = [];
  unit.jumpedThisTurn = false;
  unit.mpSpent = standCost;
  state.actedThisPhase.push(unitId);
  unit.heatPending += POSTURE_MOVE_HEAT;
  sink.push({
    kind: "heatMove",
    unitId,
    heat: POSTURE_MOVE_HEAT,
    base: unit.heat,
    totalGenerated: unit.heatPending,
  });
  const r = rollPilotingCheck(rng, unit.piloting, pre.modifier);
  sink.push({
    kind: "pilotingCheck",
    unitId,
    reason: "standUp",
    modifier: pre.modifier,
    target: r.target,
    roll: r.roll,
    success: r.success,
  });
  if (r.success) {
    unit.prone = false;
    sink.push({
      kind: "moved",
      unitId,
      mode: "walk",
      prevMode: "prone",
      position: { ...unit.position },
      facing: unit.facing,
      mpSpent: standCost,
      mpBudget: budget,
    });
    return standCost;
  }
  // Failed stand: the 'Mech crashes back down (TW p.50) for fresh fall damage.
  const terrain = cellAt(state, unit.position).terrain;
  applyFall(
    state,
    unit,
    rng,
    {
      cause: "failedPsr:standUp",
      seatbeltModifier: pre.modifier,
      halved: terrain === "water2" || terrain === "water3",
      allowProne: true,
    },
    sink,
  );
  return standCost;
}

/**
 * Voluntary drop to the ground (1 MP): no roll, no heat; the 'Mech counts
 * as walking for to-hit this turn. Landing jars the chassis: fixed 1 point
 * on the front hit-location column (crit rolls like any damage). Underwater
 * at depth 2+ that point halves rounding down, so it lands 0.
 */
export function dropProne(
  state: BattleState,
  unitId: string,
  sink: GameEvent[],
  rng: Rng = DEFAULT_RNG,
): void {
  requirePhase(state, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (unit.prone) throw new Error(`${unitId} is already prone`);
  if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot move`);
  if (unit.unconscious) throw new Error(`${unitId} is unconscious and cannot move`);
  const def = getMechDefFor(unit);
  const budget = effectiveMoveBudget(
    "walk",
    effectiveMovement(def, unit.damage, unit.critSlotsDestroyed),
    unit.heat,
  );
  if (budget < DROP_BUDGET_MIN) throw new Error(`${unitId} has no MP to drop prone`);
  const prevMode = unit.moveMode ?? "standStill";
  unit.moveMode = "walk";
  unit.movesThisTurn = [];
  unit.jumpedThisTurn = false;
  unit.mpSpent = DROP_MP_COST;
  unit.prone = true;
  state.actedThisPhase.push(unitId);
  const location = hitLocationForArc("front", roll2D6(rng));
  const terrain = cellAt(state, unit.position).terrain;
  // Underwater falls halve rounding down (TW errata, p.57): a 1-point drop
  // in depth-2+ water lands 0 damage.
  const total =
    terrain === "water2" || terrain === "water3"
      ? Math.floor(VOLUNTARY_DROP_DAMAGE / 2)
      : VOLUNTARY_DROP_DAMAGE;
  const groups = total > 0 ? [{ location, damage: total }] : [];
  const crits = applyDamageGroups(state, unit, rng, groups, "front", sink);
  sink.push(
    {
      kind: "unitFell",
      unitId,
      cause: "voluntaryDrop",
      facingAfter: unit.facing,
      fallRoll: null,
      column: "front",
      levelsFallen: 0,
      groups,
      totalDamage: total,
      crits,
    },
    {
      kind: "moved",
      unitId,
      mode: "prone",
      prevMode,
      position: { ...unit.position },
      facing: unit.facing,
      mpSpent: DROP_MP_COST,
      mpBudget: budget,
    },
  );
}

/**
 * Facing change while prone (TW pp. 49, 50, 122): costs the unit's movement
 * activation plus 1 heat, counts as walking for to-hit, and charges 1 MP per
 * hexside rotated.
 *
 * - Both legs destroyed (TW p. 122): cannot turn at all.
 * - One leg destroyed (TW p. 122): exactly one hexside per turn.
 * - Undamaged (TW pp. 49, 50): 1 MP per hexside, up to 3 (180°) in place.
 */
export function proneFacingTurn(
  state: BattleState,
  unitId: string,
  facings: number,
  sink: GameEvent[],
): void {
  requirePhase(state, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (!unit.prone) throw new Error(`${unitId} is not prone`);
  if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot move`);
  if (unit.unconscious) throw new Error(`${unitId} is unconscious and cannot move`);
  const def = getMechDefFor(unit);
  const pre = preexistingDamageModifier(def, unit.damage, unit.critSlotsDestroyed);
  if (pre.legsDestroyed >= 2) {
    throw new Error(`${unitId} has no intact legs and cannot turn while prone`);
  }
  const absFacings = Math.abs(facings);
  if (!Number.isInteger(facings) || absFacings === 0) {
    throw new Error(`${unitId} prone turn: facings must be a non-zero integer`);
  }
  if (pre.legsDestroyed === 1) {
    if (absFacings !== LEG_DESTROYED_PRONE_TURN_HEXSIDE) {
      throw new Error(
        `${unitId} is prone with a leg destroyed and may only turn 1 hexside per turn`,
      );
    }
  } else if (absFacings > MAX_PRONE_TURN_HEXSIDE) {
    throw new Error(`${unitId} prone turn: 1-3 hexsides per turn (got ${facings})`);
  }
  const mpCost = absFacings * MP_PER_FACING_CHANGE;
  const budget = effectiveMoveBudget(
    "walk",
    effectiveMovement(def, unit.damage, unit.critSlotsDestroyed),
    unit.heat,
  );
  if (budget < mpCost) {
    throw new Error(`${unitId} has no MP to turn ${absFacings} hexside(s) while prone`);
  }
  unit.facing = rotateFacing(unit.facing, facings);
  unit.moveMode = "walk";
  unit.movesThisTurn = [];
  unit.jumpedThisTurn = false;
  unit.mpSpent = mpCost;
  state.actedThisPhase.push(unitId);
  unit.heatPending += POSTURE_MOVE_HEAT;
  sink.push(
    {
      kind: "heatMove",
      unitId,
      heat: POSTURE_MOVE_HEAT,
      base: unit.heat,
      totalGenerated: unit.heatPending,
    },
    {
      kind: "moved",
      unitId,
      mode: "walk",
      prevMode: "walk",
      position: { ...unit.position },
      facing: unit.facing,
      mpSpent: mpCost,
      mpBudget: budget,
    },
  );
}

/** Pilot eject, resolved during the movement phase: the pilot abandons the
 *  'Mech, the unit leaves the battle (counted against victory like a wrecked
 *  hull), and a permanent wreck occupies its hex. Available to any unit
 *  still on the board — including shut-down and immobile ones.
 *  Wreck level is decided by `wreckLevelFor` (TO rule: light chassis or
 *  prone posture reduce it to level 1). */
export function ejectPilot(state: BattleState, unitId: string, sink: GameEvent[]): void {
  requirePhase(state, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  unit.removed = "pilotEjected";
  state.wrecks[`${unit.position.col},${unit.position.row}`] = {
    unitId,
    level: wreckLevelFor(state, unit),
  };
  state.actedThisPhase.push(unitId);
  sink.push({ kind: "unitRemoved", unitId, reason: "pilotEjected" });
}

/** Voluntary shutdown declaration, resolved during the movement phase: the
 *  unit goes off-line ("manual") immediately and stays down until a
 *  successful voluntary startup. The shutdown itself forces the immediate
 *  +3 PSR like any reactor shutdown (TW p.60). Marks the unit as having
 *  acted. */
export function voluntaryShutdown(
  state: BattleState,
  unitId: string,
  sink: GameEvent[],
  rng: Rng = DEFAULT_RNG,
): void {
  requirePhase(state, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (isShutdown(unit)) throw new Error(`${unitId} is already shut down`);
  unit.shutdown = "manual";
  state.actedThisPhase.push(unitId);
  sink.push({
    kind: "shutdownCheck",
    unitId,
    avoided: false,
    manual: true,
    roll: 0,
    heat: unit.heat,
    avoid: 0,
    threshold: 0,
  });
  shutdownFallCheck(state, unit, rng, sink);
}

/** Voluntary startup attempt, resolved during the movement phase: roll 2D6
 *  against the shutdown avoidance number at the current heat. On success the
 *  unit enters "starting" — still off-line, but it comes online just before
 *  the next initiative roll. On failure it remains shut down. Marks the unit
 *  as having acted either way. */
export function attemptVoluntaryStartup(
  state: BattleState,
  unitId: string,
  sink: GameEvent[],
  rng: Rng = DEFAULT_RNG,
): void {
  requirePhase(state, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (isNominal(unit)) throw new Error(`${unitId} is not shut down`);
  if (unit.shutdown === "starting") throw new Error(`${unitId} is already starting up`);
  const heat = unit.heat;
  const avoid = shutdownAvoid(heat);
  const roll = avoid === 0 ? 0 : roll2D6(rng);
  state.actedThisPhase.push(unitId);
  if (roll >= avoid) {
    unit.shutdown = "starting";
    sink.push({
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
    sink.push({
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
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (isNominal(unit)) throw new Error(`${unitId} is not shut down`);
  state.actedThisPhase.push(unitId);
}

/** Outcome of one {@link gameLoop} invocation. */
export interface GameLoopResult {
  /** Next unit that must act, or null if no actor ready (victory or transient phase). */
  actorId: string | null;
  /** True iff game loop stopper decides to stop. */
  stopped: boolean;
}

export type GameLoopStopper = (state: BattleState) => boolean;

/**
 * Advance the battle through transient phases (initiative roll, attack
 * resolution, phase transitions) until an actor must act or the game ends.
 * Mutates `state` in place; pure engine rules only — no session/UI state.
 * Throws if the loop exceeds 200 iterations (debug-only safety net).
 * engine keeps simulating, not responsible for win or lose
 */
export function gameLoop(
  state: BattleState,
  rng: Rng,
  stopper: GameLoopStopper,
  sink: GameEvent[],
): GameLoopResult {
  for (let i = 0; i < 200; i++) {
    if (stopper(state)) {
      return { actorId: null, stopped: true };
    }
    if (state.phase === "initiative") {
      rollInitiativePhase(state, rng, sink);
      continue;
    }
    if (state.phase === "end") {
      advancePhase(state, sink, rng);
      continue;
    }
    const id = nextActor(state);
    if (id !== null) return { actorId: id, stopped: false };
    if (state.phase === "weaponAttack") {
      resolveAllAttacks(state, rng, sink);
    }
    advancePhase(state, sink, rng);
  }
  throw new Error("phase driver exceeded 200 iterations");
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
    if (isUnitRemoved(u)) {
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
    if (!unit || isUnitRemoved(unit)) return false;
    if (state.actedThisPhase.includes(id)) return false;
    if (unit.passedAttacks) return false;
    // An unconscious pilot cannot move, fire, or act (TW p.42).
    if (unit.unconscious) return false;
    if (nominalOnly && !isNominal(unit)) return false;
    return true;
  });
}

/** Full activation order for the current phase: movement phases front-load
 *  shut-down units (they can only attempt startup or pass); both phases then
 *  alternate initiative-loser-first, letting the larger team act
 *  ⌊size/minSize⌋ units per step (TW unequal-force activation). */
function buildActorQueue(state: BattleState): string[] {
  const alive = Object.values(state.units).filter((u) => !isUnitRemoved(u));
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

/** Build the per-slot destroyed-flag table for a fresh unit, all false. */
function initCritDestroyed(def: ResolvedMechDef): Record<Location, boolean[]> {
  const out: Record<Location, boolean[]> = {} as Record<Location, boolean[]>;
  for (const loc of Object.keys(def.critSlots) as Location[]) {
    out[loc] = new Array(def.critSlots[loc].length).fill(false);
  }
  return out;
}

/** Deep copy of a per-slot destroyed-flag table (phase snapshots). */
function cloneCritDestroyed(src: Record<Location, boolean[]>): Record<Location, boolean[]> {
  const out: Record<Location, boolean[]> = {} as Record<Location, boolean[]>;
  (Object.keys(src) as Location[]).forEach((loc) => {
    out[loc] = src[loc].slice();
  });
  return out;
}

/**
 * Remove every ammo bin in a location whose internal structure has dropped to
 * zero (blown-off limbs, destroyed torsos). Per-weapon totals are derived on
 * demand, so no refresh is needed here.
 */
function stripDestroyedLocationAmmo(target: UnitState): void {
  for (const loc of LOCATIONS) {
    if ((target.damage.internalStructure[loc] ?? 0) <= 0) {
      stripBinsInLocation(target.ammoBins, loc);
    }
  }
}
