import { hexDistance, isAdjacent, sameHex } from "../../core/hex";
import { cellAt, costToClimb, groundLevel, hexEntryCost, waterDepth } from "../../core/terrain";
import {
  FACINGS,
  type Facing,
  type HexCoord,
  type MoveMode,
  msgHex,
  rotateFacing,
} from "../../core/types";
import { mechDefFor } from "../../data/index";
import { isBuildingTerrain } from "../building";
import {
  cloneCritTable,
  countDestroyedGyro,
  countDestroyedHip,
  effectiveMovement,
} from "../critical";
import { destroyedLegs, isUnitImmobile } from "../damage";
import { effectiveMoveBudget, isTsmActive, movementHeat } from "../heat";
import * as mv from "../movement";
import { BACKWARD_LEVEL_CHANGE_MAX, FORWARD_LEVEL_CHANGE_MAX, JUMP_MP_PER_HEX } from "../movement";
import { isPilotUnconscious } from "../pilot";
import { GYRO_DESTROYED_HITS, preexistingDamageModifier } from "../piloting";
import { applyFall, pushPilotingCheck } from "./consequences";
import { DROP_MP_COST, JUMP_MIN_HEXES, MOVE_MODES, TURN_FACINGS_MAX } from "./constants";
import { facingToward } from "./geometry";
import { meleeDeclarationProblem } from "./melee";
import { resolvePhasePiloting } from "./pilotingPhase";
import { attemptStandUp, dropProne, posturePool, remainingAfterPosture } from "./posture";
import {
  cloneDamage,
  hasWreckage,
  isHull,
  isNominal,
  isShutdown,
  isTargetableBy,
  isUnitOnBoard,
  isUnitRemoved,
  occupantAt,
  requirePhase,
  requireUnit,
} from "./queries";
import { movementTerrainPsr } from "./terrainPsr";
import { requireCurrentActor } from "./turnOrder";
import type {
  BattleState,
  ExecuteMoveOptions,
  GameEvent,
  MoveStep,
  PilotingCheckReason,
  PostureChange,
  PosturePool,
  UnitState,
} from "./types";

/**
 * Moves the current actor: declares `mode` and walks `steps` in one call.
 * The unit must head the movement queue, and the move ends its activation.
 * A stand-up or drop followed by movement goes through `executePostureMove`.
 */
export function executeMove(
  state: BattleState,
  unitId: string,
  mode: MoveMode,
  steps: readonly MoveStep[],
  sink: GameEvent[],
  options: ExecuteMoveOptions,
): void {
  moveUnit(state, unitId, mode, steps, sink, options, null);
}

/**
 * A stand-up or drop and the movement after it, as one activation with one
 * MP pool (TW pp.49-50): the posture cost counts against the locomotion
 * budget, and the activation is marked once. Movement follows only a
 * successful posture change; after a failed stand the 'Mech stays prone and
 * `steps` are not taken. A stand takes `locomotion` as its declared mode
 * (walk, run or stand still; never jump, TW p.49). A drop takes walk (turns
 * in place while prone) or stand still. Returns whether the posture change
 * succeeded.
 *
 * Not atomic: when the movement is illegal it throws after the posture change
 * has resolved. Callers wanting all-or-nothing hold a snapshot (see
 * `commitAtomic` in the web session).
 */
export function executePostureMove(
  state: BattleState,
  unitId: string,
  posture: PostureChange,
  locomotion: MoveMode,
  steps: readonly MoveStep[],
  sink: GameEvent[],
  options: ExecuteMoveOptions,
): boolean {
  if (posture !== "standUp" && posture !== "drop") {
    throw new Error(`Unknown posture change: ${String(posture)}`);
  }
  if (locomotion === "jump") {
    throw new Error(
      `${unitId} cannot jump in a turn it ${posture === "standUp" ? "stands up" : "drops prone"}`,
    );
  }
  if (posture === "drop" && locomotion === "run") {
    throw new Error(`${unitId} drops prone: walk (turn in place) or stand still only`);
  }
  // Checked before the posture change resolves, so a refused call leaves the
  // unit untouched (moveUnit repeats the checks for plain moves).
  if (locomotion !== "standStill" && locomotion !== "walk" && locomotion !== "run") {
    throw new Error(`Unknown movement mode: ${String(locomotion)}`);
  }
  requireValidFinalFacing(options.finalFacing);
  const rng = options.rng;
  // The posture change is a window of its own with nothing in scope: a
  // failed stand's fall rolls no sweep and earns no one credit.
  state.currentDealt = { before: { damage: {}, crit: {} }, total: {}, byAttacker: {} };
  let cost: number;
  if (posture === "standUp") {
    cost = attemptStandUp(state, unitId, sink, rng, locomotion);
    if (requireUnit(state, unitId).prone) return false;
  } else {
    dropProne(state, unitId, sink);
    cost = DROP_MP_COST;
  }
  if (steps.length > 0 || options.finalFacing !== undefined) {
    moveUnit(state, unitId, locomotion, steps, sink, options, posturePool(cost, posture));
  }
  return true;
}

export function requireValidFinalFacing(finalFacing: Facing | undefined): void {
  if (finalFacing !== undefined && !FACINGS.includes(finalFacing)) {
    throw new Error(`Invalid finalFacing: ${String(finalFacing)}`);
  }
}

/** `executeMove` body. With `posture`, the move continues the activation a
 *  stand-up or drop opened: that call already checked the actor and marked
 *  the activation, and its MP comes out of the same pool. */
export function moveUnit(
  state: BattleState,
  unitId: string,
  mode: MoveMode,
  steps: readonly MoveStep[],
  sink: GameEvent[],
  options: ExecuteMoveOptions,
  posture: PosturePool | null,
): void {
  requirePhase(state, "movement");
  if (posture === null) requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot move`);
  if (isPilotUnconscious(unit)) throw new Error(`${unitId} is unconscious and cannot move`);
  if (mode !== "standStill" && isUnitImmobile(unit.damage)) {
    throw new Error(`${unitId} has no intact legs and arms and can only stand still`);
  }
  // TW p.122: a one-leg-destroyed 'Mech cannot run (running MP is 0).
  // TW p.49: minimum movement (one forward hex, nothing else) is still legal.
  // Minimum Movement must be the turn's only MP expenditure, so never after a
  // stand or drop.
  const minMoveShape =
    posture === null &&
    mode === "run" &&
    !unit.prone &&
    steps.length === 1 &&
    steps[0]!.kind === "enter" &&
    mv.isForwardStep(unit.position, steps[0]!.to, unit.facing);
  if (mode === "run" && destroyedLegs(unit.damage) >= 1 && !minMoveShape) {
    throw new Error(`${unitId} has a destroyed leg and cannot run`);
  }
  // Prone units may only stand still or walk turn-only steps. Combined check:
  // reject run/jump outright; reject walk with any hex-enter step.
  if (unit.prone && mode !== "standStill" && mode !== "walk") {
    throw new Error(`${unitId} is prone: stand up, turn, or pronestill`);
  }
  // TW p.49: standing up (or dropping) uses the turn's movement; no jump after.
  if (mode === "jump" && posture !== null) {
    throw new Error(`${unitId} stood up or dropped prone this turn and cannot jump`);
  }
  if (unit.prone && mode === "walk" && steps.some((s) => s.kind === "enter")) {
    throw new Error(`${unitId} is prone: turn or pronestill only (no hex enters)`);
  }
  if (!MOVE_MODES.includes(mode)) throw new Error(`Unknown movement mode: ${String(mode)}`);
  requireValidFinalFacing(options.finalFacing);
  const startHex: HexCoord = unit.position;
  unit.moveMode = mode;
  unit.hexesMovedThisTurn = 0;
  unit.mpSpent = 0;
  sink.push({ kind: "moveDeclared", unitId, mode });
  const rng = options.rng;
  const prechargedMP = posture?.mp ?? 0;

  const def = mechDefFor(unit);
  const movement = effectiveMovement(
    def,
    unit.damage,
    unit.critSlotsDestroyed,
    isTsmActive(def, unit.heat),
    waterDepth(cellAt(state, unit.position).terrain),
  );
  const budget = effectiveMoveBudget(unit.moveMode, movement, unit.heat);
  const jumping = unit.moveMode === "jump";
  const proneTurn = unit.prone && unit.moveMode === "walk";
  // TW p.49 minimum movement: a unit with >= 1 MP always affords the single
  // hex straight ahead; the charge is capped at what it has (at least 1).
  const minMove =
    minMoveShape && effectiveMoveBudget("walk", movement, unit.heat) >= mv.MIN_MOVEMENT_MP;
  const minMoveCap = Math.max(budget, mv.MIN_MOVEMENT_MP);

  let cursor: HexCoord = unit.position;
  let facing: Facing = unit.facing;
  let spent = 0;
  const directions: ("forward" | "backward")[] = [];
  // Charge / DFA (TW pp.148-150): a path whose last step enters an enemy hex
  // stops in front of it; the attack resolves in the physical phase.
  let meleeTarget: UnitState | null = null;
  let meleeStop: HexCoord = unit.position;
  // Stacking and charges are judged in the hex the unit ends in: the last
  // one it enters, even when turn steps follow (TW p.57).
  const firstEnterIdx = steps.findIndex((s) => s.kind === "enter");
  const lastEnterIdx = steps.reduce((m, s, k) => (s.kind === "enter" ? k : m), -1);
  // TW p.50: after a stand-up, the turns before the first hex entry are free.
  const freeTurn = (i: number): boolean =>
    posture?.freeFacing === true && (firstEnterIdx < 0 || i < firstEnterIdx);
  const standPick = posture?.freeFacing === true && firstEnterIdx < 0;
  if (options.finalFacing !== undefined && !jumping && !standPick) {
    throw new Error("finalFacing applies only to a jump landing or a stand-up facing pick");
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const isFinalStep = i === lastEnterIdx;

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
      if (!freeTurn(i)) spent += mv.facingChangeCost(Math.abs(step.facings));
      facing = rotateFacing(facing, step.facings);
      continue;
    }

    const to = step.to;
    if (to.col < 1 || to.col > state.width || to.row < 1 || to.row > state.height) {
      throw new Error(`${msgHex(to)} is off the board`);
    }
    if (jumping) {
      if (!isAdjacent(cursor, to)) {
        throw new Error("Jump steps must enter an adjacent hex");
      }
      if (budget > 0 && cellAt(state, to).level > budget + groundLevel(state, unit.position)) {
        throw new Error(`Jump path crosses ${msgHex(to)}, higher than Jumping MP + starting level`);
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
      // TW p.53: running 'Mechs cannot enter depth 1+ water; Minimum Movement
      // (TW p.57) is the one exception.
      if (unit.moveMode === "run" && !minMove && waterDepth(cellAt(state, to).terrain) > 0) {
        throw new Error(`Running 'Mechs cannot enter water (${msgHex(to)})`);
      }
      const fromLevel = groundLevel(state, cursor);
      const toLevel = groundLevel(state, to);
      const delta = toLevel - fromLevel;
      const illegalChange = forward
        ? Math.abs(delta) > FORWARD_LEVEL_CHANGE_MAX
        : delta !== BACKWARD_LEVEL_CHANGE_MAX;
      if (illegalChange) {
        const slope = delta > 0 ? `${delta} levels higher` : `${-delta} levels lower`;
        throw new Error(
          forward
            ? `Ground moves can change at most 2 levels per hex (${msgHex(to)} is ${slope})`
            : `Walking backward cannot change level (${msgHex(to)} is ${slope})`,
        );
      }
      spent += hexEntryCost(state, to, hasWreckage(state, to)) + costToClimb(fromLevel, toLevel);
      directions.push(forward ? "forward" : "backward");
    }

    // Stacking (TW p.57; TO:AR p.184): friendly units and hulls of either
    // team may be passed through, never stopped on. Ending against an enemy
    // or a hull declares a charge / DFA.
    const occupant = occupantAt(state, to, unitId);
    if (occupant !== undefined) {
      if (isFinalStep && isTargetableBy(unit, occupant)) {
        if (i !== steps.length - 1) throw new Error("A charge or DFA ends the move");
        if (directions[directions.length - 1] !== "forward") {
          throw new Error("A charge must be made straight ahead");
        }
        meleeTarget = occupant;
        meleeStop = cursor;
      } else if (isFinalStep) {
        throw new Error(`Cannot end movement in ${msgHex(to)}: occupied by ${occupant.id}`);
      } else if (!jumping && occupant.team !== unit.team && !isHull(occupant)) {
        throw new Error(`Cannot move through enemy ${occupant.id} at ${msgHex(to)}`);
      }
    } else if (isFinalStep) {
      const holder = Object.values(state.units).find(
        (u) =>
          u.id !== unitId &&
          !isUnitRemoved(u) &&
          u.meleeCharge !== null &&
          sameHex(u.meleeCharge.hex, to),
      );
      if (holder !== undefined) {
        throw new Error(`Cannot end movement in ${msgHex(to)}: reserved for ${holder.id}'s charge`);
      }
    }

    cursor = to;
  }

  // TW p.125 Gyro: a prone 'Mech with a destroyed gyro may change facing one
  // hexside per turn.
  if (
    proneTurn &&
    spent > 1 &&
    countDestroyedGyro(def, unit.damage, unit.critSlotsDestroyed) >= GYRO_DESTROYED_HITS
  ) {
    throw new Error(`${unitId} has a destroyed gyro: one hexside facing change per turn`);
  }
  if (minMove) spent = Math.min(spent, minMoveCap);
  if (posture !== null) {
    // TW pp.49-50: the stand or drop and the move share one pool.
    const left = remainingAfterPosture(budget, posture);
    if (spent > left) {
      throw new Error(
        `Move costs ${spent} MP but only ${left} of the ${unit.moveMode} budget ${budget} is left after the posture change`,
      );
    }
  } else if (spent > budget && !minMove) {
    throw new Error(`Move costs ${spent} MP but ${unit.moveMode} budget is ${budget}`);
  }
  if (jumping && directions.length < JUMP_MIN_HEXES) {
    throw new Error("Jump needs at least 1 hex move");
  }
  if (
    jumping &&
    directions.length !== Math.max(JUMP_MIN_HEXES, hexDistance(unit.position, cursor))
  ) {
    throw new Error("A jump follows a shortest path to its landing hex");
  }
  if (
    steps.length > 0 &&
    !jumping &&
    unit.moveMode !== "standStill" &&
    isUnitImmobile(unit.damage)
  ) {
    throw new Error(`${unitId} has no intact legs and arms and cannot move`);
  }

  // Charge / DFA declaration checks (TW pp.148-150).
  let meleeKind: "charge" | "dfa" | null = null;
  let meleeFacing: Facing = facing;
  if (meleeTarget !== null) {
    meleeKind = jumping ? "dfa" : "charge";
    const problem = meleeDeclarationProblem(
      state,
      unitId,
      meleeStop,
      meleeTarget.id,
      meleeKind,
      budget,
    );
    if (problem !== null) throw new Error(problem);
    meleeFacing = facingToward(meleeStop, meleeTarget.position) ?? facing;
    cursor = meleeStop;
  }
  // TW p.168: a 'Mech cannot use Jumping MP to enter a building hex, only its
  // roof, and roofs are not modeled. Jumping out of or over one is legal.
  if (jumping && isBuildingTerrain(cellAt(state, cursor).terrain)) {
    throw new Error(`${unitId} cannot use Jumping MP to enter a building hex (${msgHex(cursor)})`);
  }

  // Preexisting damage applies to every movement-entry PSR (TW p.60). The
  // modifier is recomputed per roll: damage taken earlier in the move counts.
  const pre = preexistingDamageModifier(def, unit.damage, unit.critSlotsDestroyed);
  const currentPre = (): number =>
    preexistingDamageModifier(def, unit.damage, unit.critSlotsDestroyed).modifier;
  // Damage and criticals taken during the move trigger their end-of-phase
  // PSRs at the end of the move (TW pp.59-60, 126-128). The move is one
  // damage window with only the mover in scope.
  state.currentDealt = {
    before: {
      damage: { [unitId]: cloneDamage(unit.damage) },
      crit: { [unitId]: cloneCritTable(unit.critSlotsDestroyed) },
    },
    total: {},
    byAttacker: {},
  };
  const commitAt = (
    hex: HexCoord,
    face: Facing,
    mode: MoveMode,
    mp: number,
    dirs: ("forward" | "backward")[],
    declareCharge = false,
  ): void => {
    unit.position = hex;
    unit.facing = face;
    unit.jumpedThisTurn = jumping && steps.length > 0;
    // Target movement counts only hexes since the last reversal (TW p.107).
    let since = dirs.length;
    while (since > 0 && dirs[since - 1] === dirs[dirs.length - 1]) since -= 1;
    unit.hexesMovedThisTurn = dirs.length - since;
    unit.mpSpent = mp + prechargedMP;
    // A path that ends against an enemy declares the charge / DFA: the unit
    // takes no attack-phase actions and its attack resolves in the physical
    // sub-pass (TW pp.148-149). A later fall (strain PSR) leaves it declared;
    // the prone attacker then simply misses.
    let pendingCharge: { attack: "charge" | "dfa"; targetId: string; targetHex: HexCoord } | null =
      null;
    if (declareCharge && meleeKind !== null && meleeTarget !== null) {
      const target: UnitState = meleeTarget;
      unit.meleeCharge = {
        kind: meleeKind,
        targetId: target.id,
        hex: target.position,
        from: startHex,
        missed: false,
      };
      unit.declaredPhysicalAttacks = [{ type: meleeKind, targetId: target.id }];
      unit.passedAttacks = true;
      pendingCharge = {
        attack: meleeKind,
        targetId: target.id,
        targetHex: target.position,
      };
    }
    sink.push({
      kind: "moved",
      unitId,
      mode,
      prevMode: mode,
      position: hex,
      facing: face,
      mpSpent: mp + prechargedMP,
      mpBudget: budget,
      ...(pendingCharge !== null ? { pendingCharge } : {}),
    });
    const moveHeat = posture?.modeHeatPaid === true ? 0 : movementHeat(mode, mp);
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
  // Hexes the 'Mech has stood in on this path, start first. A jump passes
  // over its path, so only its start counts.
  const stoodIn: HexCoord[] = [{ ...cur }];
  /** Where a move cut short ends. Without displacement (VISION §2.5) a
   *  faller that cannot keep its hex goes back along its own path to the
   *  newest hex no other unit holds, so it never ends stacked (TW p.57).
   *  The start hex is always free: the mover has just left it. */
  const freeStop = (hex: HexCoord): HexCoord => {
    if (!isUnitOnBoard(unit) || occupantAt(state, hex, unitId) === undefined) return hex;
    for (let k = stoodIn.length - 1; k >= 0; k--) {
      const back = stoodIn[k]!;
      if (occupantAt(state, back, unitId) === undefined) return back;
    }
    return hex;
  };
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const isFinal = i === lastEnterIdx;
    if (step.kind === "turn") {
      curFacing = rotateFacing(curFacing, step.facings);
      if (!freeTurn(i)) curSpent += mv.facingChangeCost(Math.abs(step.facings));
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
        hexEntryCost(state, to, hasWreckage(state, to)) +
        costToClimb(groundLevel(state, from), groundLevel(state, to));
      curDirs.push(forward ? "forward" : "backward");
    }
    if (minMove) curSpent = Math.min(curSpent, minMoveCap);
    // The target hex of a charge / DFA is never entered: no terrain PSR, the
    // unit stays in the hex before it (MP for the step is still paid).
    if (isFinal && meleeKind !== null) break;
    cur = to;
    if (!jumping) stoodIn.push({ ...to });
    // Terrain-entry PSRs (TW p.60): ground checks every entered hex, jump
    // only its landing. A fall, crash-kill, or shutdown ends the move here,
    // committed at the hex the fall rule leaves the 'Mech in (the lower
    // hex on a fall across levels).
    if (!jumping || isFinal) {
      // Sync unit.facing before the PSR so a fall rotates from the
      // correct facing (walk: turned facing; jump: chosen landing facing).
      if (jumping) {
        unit.facing = options.finalFacing ?? facing;
      } else {
        unit.facing = curFacing;
      }
      const fellAt = movementTerrainPsr(
        state,
        unit,
        rng,
        from,
        to,
        !jumping,
        currentPre(),
        sink,
        curDirs.length,
        curDirs[curDirs.length - 1] !== "backward",
      );
      // A move cut short still uses up the unit's activation (TW p.59).
      if (fellAt !== null) {
        commitAt({ ...freeStop(fellAt) }, unit.facing, mode, curSpent, curDirs);
        if (posture === null) state.actedThisPhase.push(unitId);
        return;
      }
      if (unit.prone || unit.destroyed !== "not") {
        commitAt({ ...freeStop(cur) }, unit.facing, mode, curSpent, curDirs);
        if (posture === null) state.actedThisPhase.push(unitId);
        return;
      }
    }
  }

  // A charge counts only the hexes moved before the target's (TW p.148).
  commitAt(
    cursor,
    meleeKind !== null ? meleeFacing : (options.finalFacing ?? facing),
    mode,
    spent,
    meleeKind === "charge" ? directions.slice(0, -1) : directions,
    true,
  );
  if (posture === null) state.actedThisPhase.push(unitId);

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
      const reason: PilotingCheckReason = mode === "run" ? "runDamaged" : "jumpDamaged";
      const r = pushPilotingCheck(sink, unit, reason, 0, pre.modifier, rng, cursor);
      if (!r.success) {
        const terrain = cellAt(state, cursor).terrain;
        applyFall(
          state,
          unit,
          rng,
          {
            cause: { kind: "failedPsr", reason },
            hex: cursor,
            seatbeltModifier: pre.modifier,
            halved: terrain === "water2" || terrain === "water3",
          },
          sink,
        );
      }
    }
  }
  resolvePhasePiloting(state, rng, sink);
}

/** Movement-phase pass for a shut-down unit that attempts no startup: it
 *  stays off-line and is marked as having acted. */
export function passMovement(state: BattleState, unitId: string): void {
  requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (isNominal(unit)) throw new Error(`${unitId} is not shut down`);
  state.actedThisPhase.push(unitId);
}
