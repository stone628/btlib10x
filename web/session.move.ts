import {
  attemptStandUp,
  attemptVoluntaryStartup,
  type BattleState,
  canAttemptStandUp,
  cellAt,
  DROP_MP_COST,
  destroyedArms,
  destroyedLegs,
  dropProne,
  effectiveMoveBudget,
  effectiveMovement,
  ejectPilot,
  executeMove,
  type Facing,
  type GameEvent,
  type HexCoord,
  isShutdown,
  isTsmActive,
  isUnitImmobile,
  isUnitRemoved,
  type MapNameHolder,
  type MoveMode,
  type MoveStep,
  MP_PER_FACING_CHANGE,
  mapDefFor,
  mechDefFor,
  movementMpPenalty,
  neighbor,
  oppositeFacing,
  passMovement,
  type RevealedLanding,
  reachableLandings,
  requireUnit,
  rotateFacing,
  STAND_MP_COST,
  type UnitState,
  voluntaryShutdown,
  waterDepth,
  wreckAt,
} from "btlib10x";
import { buildBoardChunk, buildLinesChunk, type Chunk } from "./chunk";
import { i18n } from "./i18n";
import { F, PRN, TRN } from "./misc";
import {
  type BoardRenderReachableInfo,
  createBoardRenderUnit,
  createEjectedBoardRenderUnits,
} from "./render";
import { commitAtomic, drive, requireBattle, type Session, type SessionGameEvent } from "./session";
import { actorOrderLines, clubHexKeys } from "./session.common";

const MOVE_MODES: Readonly<Record<string, MoveMode>> = {
  standstill: "standStill",
  walk: "walk",
  run: "run",
  jump: "jump",
};

const VOLUNTARY_MODES: Readonly<Record<string, "shutdown" | "startup" | "eject">> = {
  shutdown: "shutdown",
  startup: "startup",
  eject: "eject",
};

const PRONE_MODES: Readonly<Record<string, "prone">> = {
  prone: "prone",
};

export type DeclaredMovementMode =
  | MoveMode
  | "shutdown"
  | "startup"
  | "eject"
  | "standup"
  | "prone"
  | "turn"
  | "pronestill";

/** Eagerly allocated by `drive()` on movement-phase entry, nulled when the
 *  phase exits or a new actor becomes current. Carries the pending move
 *  declaration: `moveMode`, `postureMove`, `moveSteps`, `moveFinalFacing`,
 *  `placedLanding`, plus `moveCandidate` (cached reachable map). Snapshotted
 *  whole by `commitAtomic` so failed commits can restore the declaration. */
export interface MovementContext {
  actorId: string;
  /** Pending declaration for the acting unit: a movement mode (engine
   *  `MoveMode`), a posture-change `standup` / `prone` attempt, or
   *  the voluntary `"shutdown"` / `"startup"` / `"eject"` declaration,
   *  committed by the `done` command. `standup` / `prone` may carry a queued
   *  `place` landing in `placedLanding`; `postureMove` holds the locomotion
   *  mode the queued steps run under after the posture change succeeds. */
  moveMode: DeclaredMovementMode | null;
  /** Locomotion mode for a posture-change + move: `walk` for `prone turn`
   *  (in-place turns after the drop), `standStill` for `prone pronestill`,
   *  the declared walk/run/jump for `standup`. Null otherwise. */
  postureMove: MoveMode | null;
  moveSteps: MoveStep[];
  /** Landing facing chosen by `place` (jump only: engine rejects turn steps
   *  while jumping, so the landing facing travels via `executeMove`'s
   *  `finalFacing` option). Null when unset or ground movement. */
  moveFinalFacing: Facing | null;
  /** Landing from `moveCandidate` buffered by `place`; `status`/`candidate`
   *  preview renders its `path` directly. Null when no landing queued. */
  placedLanding: RevealedLanding | null;
  moveCandidate: BoardRenderReachableInfo | null;
}

/** Allocate a fresh move context for `actorId`. Default declaration is
 *  empty (`moveMode: null`); mutators fill in. */
export function initMovementContext(s: Session, actorId: string): MovementContext {
  const newContext: MovementContext = {
    actorId,
    moveMode: null,
    postureMove: null,
    moveSteps: [],
    moveFinalFacing: null,
    placedLanding: null,
    moveCandidate: null,
  };
  s.move = newContext;
  return newContext;
}

export function movementContextInvalid(s: Session, actorId: string): boolean {
  return s.move === null || s.move.actorId !== actorId;
}

function clearContext(s: Session) {
  s.move = null;
}

/** Mutator-side accessor for the active move context. Throws if not in the
 *  movement phase (the engine never reaches a move-declaring code path
 *  outside movement). */
function requireBattleAndContext(s: Session): { battle: BattleState; context: MovementContext } {
  const battle = requireBattle(s);
  if (!s.move || battle.phase !== "movement") {
    throw new Error(i18n("err.wrongPhase", { phase: "movement" }));
  }
  return { battle, context: s.move };
}

export function requireMovementActor(s: Session) {
  const battle = requireBattle(s);
  if (!s.move || battle.phase !== "movement") {
    throw new Error(i18n("err.wrongPhase", { phase: "movement" }));
  }
  return requireUnit(battle, s.move.actorId);
}

export function parseMoveMode(word: string): DeclaredMovementMode {
  const mode = MOVE_MODES[word.toLowerCase()];
  if (mode) return mode;
  const voluntary = VOLUNTARY_MODES[word.toLowerCase()];
  if (voluntary) return voluntary;
  const w = word.toLowerCase();
  if (w === "standup") return "standup";
  if (w === "turn") return "turn";
  if (w === "pronestill") return "pronestill";
  const prone = PRONE_MODES[word.toLowerCase()];
  if (prone) return prone;
  throw new Error(i18n("err.badModeWord", { modes: modeSyntaxFor(null) }));
}

/** Locale-neutral `mode` syntax legal for `unit` right now (null = unknown unit). */
export function modeSyntaxFor(unit: UnitState | null): string {
  if (unit === null)
    return "standstill|walk|run|jump|prone [turn|pronestill]|turn|pronestill|standup [walk|run|jump|standstill]|shutdown|startup|eject";
  if (isShutdown(unit)) return "startup|eject";
  const legs = destroyedLegs(unit.damage);
  const arms = destroyedArms(unit.damage);
  if (isUnitImmobile(unit.damage)) {
    return unit.prone ? "pronestill|shutdown|eject" : "standstill|shutdown|eject";
  }
  // Both legs gone but not immobile (props up with arms intact): cannot stand,
  // cannot change facing (TW p.122). Stay prone; fire while propped.
  if (legs >= 2) {
    return "pronestill|shutdown|eject";
  }
  // One leg destroyed + both arms: cannot stand, cannot fire, cannot turn.
  if (legs === 1 && arms >= 2) {
    return "pronestill|shutdown|eject";
  }
  if (unit.prone) {
    const standOk = canAttemptStandUp(unit.damage);
    const runOk = false; // one-leg cannot run
    const standupModes = standOk
      ? runOk
        ? "standup [walk|run|jump|standstill]"
        : "standup [walk|jump|standstill]"
      : "";
    const sep = standupModes ? "|" : "";
    return `turn|pronestill${sep}${standupModes}|shutdown|eject`;
  }
  // Standing one-leg 'Mech: walk 1 MP, jump allowed; run only as minimum movement (TW p.49).
  if (legs === 1) {
    return "standstill|walk|run|jump|prone [turn|pronestill]|shutdown|eject";
  }
  return "standstill|walk|run|jump|prone [turn|pronestill]|shutdown|eject";
}

/** One-line `modes: ...` hint shown above the movement prompt; null outside it. */
export function moveModesHint(s: Session): string | null {
  const { battle, context } = requireBattleAndContext(s);
  return i18n("mode.hint", { modes: modeSyntaxFor(requireUnit(battle, context.actorId)) });
}

export function ensureMoveCandidate(
  s: Session,
  forceUpdate: boolean = false,
): BoardRenderReachableInfo {
  const m = s.move!;
  if (m.moveCandidate == null || forceUpdate) {
    m.moveCandidate = reachablesInfo(s);
  }
  return m.moveCandidate;
}

export function emptyMoveCandidate(s: Session): BoardRenderReachableInfo {
  const { battle, context } = requireBattleAndContext(s);
  const actor = requireUnit(battle, context.actorId);
  const mc = { team: actor.team, revealed: [] };
  context.moveCandidate = mc;
  return mc;
}

export function declareMovementMode(
  s: Session,
  mode: DeclaredMovementMode,
  locomotionWord?: string,
): void {
  const { battle, context } = requireBattleAndContext(s);
  const unit = requireUnit(battle, context.actorId);
  if (mode === "shutdown") {
    if (isShutdown(unit)) throw new Error(i18n("err.mustBeOnlineForShutdown"));
    context.moveMode = "shutdown";
    context.postureMove = null;
    clearMoveQueue(context);
    return;
  }
  if (mode === "startup") {
    if (unit.shutdown === "not") throw new Error(i18n("err.mustBeDownForStartup"));
    if (unit.shutdown === "starting") throw new Error(i18n("err.alreadyStarting"));
    if (unit.shutdown === "heat") throw new Error(i18n("err.heatShutdownNoStartup", { id: unit.id }));
    context.moveMode = "startup";
    context.postureMove = null;
    clearMoveQueue(context);
    return;
  }
  if (mode === "eject") {
    if (isUnitRemoved(unit)) throw new Error(i18n("err.alreadyEjected", { id: unit.id }));
    context.moveMode = "eject";
    context.postureMove = null;
    clearMoveQueue(context);
    return;
  }
  if (mode === "standup") {
    if (!unit.prone)
      throw new Error(
        i18n("err.standupRequiresProne", {
          id: unit.id,
          modes: modeSyntaxFor(unit),
        }),
      );
    if (isUnitImmobile(unit.damage)) throw new Error(i18n("err.postureBudget", { id: unit.id }));
    const chosen = parseStandupLocomotion(locomotionWord);
    const def = mechDefFor(unit);
    const movement = effectiveMovement(
      def,
      unit.damage,
      unit.critSlotsDestroyed,
      isTsmActive(def, unit.heat),
    );
    // Standing in place draws the stand cost from the walk pool.
    const budgetMode = chosen === "standStill" ? "walk" : chosen;
    if (effectiveMoveBudget(budgetMode, movement, unit.heat) < STAND_MP_COST) {
      throw new Error(i18n("err.postureBudget", { id: unit.id }));
    }
    // Engine declareMove deferred to commit: unit still prone, would throw.
    context.moveMode = "standup";
    context.postureMove = chosen;
    clearMoveQueue(context);
    return;
  }
  if (mode === "prone") {
    if (unit.prone)
      throw new Error(
        i18n("err.proneRequiresStanding", {
          id: unit.id,
          modes: modeSyntaxFor(unit),
        }),
      );
    if (isUnitImmobile(unit.damage)) throw new Error(i18n("err.postureBudget", { id: unit.id }));
    const sub = parseProneLocomotion(unit, locomotionWord);
    const def = mechDefFor(unit);
    const movement = effectiveMovement(
      def,
      unit.damage,
      unit.critSlotsDestroyed,
      isTsmActive(def, unit.heat),
    );
    if (effectiveMoveBudget("walk", movement, unit.heat) < DROP_MP_COST) {
      throw new Error(i18n("err.postureBudget", { id: unit.id }));
    }
    // Drop deferred to commit; turn candidate assumes prone-after-drop.
    context.moveMode = "prone";
    context.postureMove = sub;
    clearMoveQueue(context);
    return;
  }
  if (mode === "turn") {
    if (!unit.prone)
      throw new Error(i18n("err.turnRequiresProne", { id: unit.id, modes: modeSyntaxFor(unit) }));
    if (isUnitImmobile(unit.damage)) throw new Error(i18n("err.postureBudget", { id: unit.id }));
    if (locomotionWord !== undefined)
      throw new Error(i18n("err.turnTakesNoArg", { modes: modeSyntaxFor(unit) }));
    const def = mechDefFor(unit);
    const movement = effectiveMovement(
      def,
      unit.damage,
      unit.critSlotsDestroyed,
      isTsmActive(def, unit.heat),
    );
    if (effectiveMoveBudget("walk", movement, unit.heat) < 1) {
      throw new Error(i18n("err.postureBudget", { id: unit.id }));
    }
    // Engine declareMove deferred to commit: unit still prone, would throw.
    context.moveMode = "turn";
    context.postureMove = null;
    clearMoveQueue(context);
    return;
  }
  if (mode === "pronestill") {
    if (!unit.prone)
      throw new Error(
        i18n("err.pronestillRequiresProne", {
          id: unit.id,
          modes: modeSyntaxFor(unit),
        }),
      );
    if (locomotionWord !== undefined)
      throw new Error(i18n("err.pronestillTakesNoArg", { modes: modeSyntaxFor(unit) }));
    context.moveMode = "pronestill";
    context.postureMove = null;
    clearMoveQueue(context);
    return;
  }
  if (isShutdown(unit)) {
    throw new Error(i18n("err.shutdownNoMove", { id: unit.id, modes: modeSyntaxFor(unit) }));
  }
  if (unit.prone) {
    throw new Error(i18n("err.proneMustDeclare", { id: unit.id, modes: modeSyntaxFor(unit) }));
  }
  if (mode !== "standStill" && mode !== "walk" && mode !== "run" && mode !== "jump") {
    throw new Error(i18n("err.badModeWord", { modes: modeSyntaxFor(unit) }));
  }
  if (isUnitImmobile(unit.damage) && mode !== "standStill") {
    throw new Error(i18n("err.immobileStandstill", { id: unit.id, modes: modeSyntaxFor(unit) }));
  }
  // One-leg 'Mech: run is legal only as TW p.49 minimum movement (a single
  // forward hex); the reachable map and the engine enforce that shape.
  // Engine call is deferred to commit (mode walk/run/jump/standstill executeMove).
  context.moveMode = mode;
  context.postureMove = null;
  clearMoveQueue(context);
}

export function declaredMovementModeChunk(s: Session, mode: DeclaredMovementMode): Chunk[] {
  const { battle, context } = requireBattleAndContext(s);
  const actor = requireUnit(battle, context.actorId);
  if (mode === "shutdown" || mode === "startup" || mode === "eject") {
    emptyMoveCandidate(s);
    return [
      buildLinesChunk(
        i18n("ok.modeDeclaredVoluntary", { id: actor.id, mode }),
        i18n("stepResult.from", {
          col: actor.position.col,
          row: actor.position.row,
          facing: F(actor.facing),
          posture: PRN(actor.prone),
        }),
      ),
    ];
  }
  const chunks = [
    buildLinesChunk(
      i18n("ok.modeDeclared", {
        id: actor.id,
        mode: displayMovementModeStr(context),
        budget: budgetFor(actor, context),
      }),
      stepResultFromLine(actor),
    ),
  ];
  const mc = ensureMoveCandidate(s, true);
  if (mc.revealed.length > 0) {
    chunks.push(reachableChunk(s.setup, s.battle!, mc));
  }
  return chunks;
}

function stepResultFromLine(actor: UnitState): string {
  return i18n("stepResult.from", {
    col: actor.position.col,
    row: actor.position.row,
    facing: F(actor.facing),
    posture: PRN(actor.prone),
  });
}

/** Locomotion arg for `mode prone [turn|pronestill]` (default turn). */
function parseProneLocomotion(unit: UnitState, word: string | undefined): MoveMode {
  if (word === undefined) return "walk";
  const w = word.toLowerCase();
  if (w === "turn") return "walk";
  if (w === "pronestill") return "standStill";
  throw new Error(i18n("err.proneNeedsMode", { modes: modeSyntaxFor(unit) }));
}
/** Locomotion arg for `mode standup [walk|run|jump|standstill]` (default standstill). */
function parseStandupLocomotion(word: string | undefined): MoveMode {
  if (word === undefined) return "standStill";
  const w = word.toLowerCase();
  if (w === "walk" || w === "run" || w === "jump" || w === "standstill")
    return w === "standstill" ? "standStill" : w;
  throw new Error(i18n("err.standupNeedsMode"));
}

/** Clear queued movement: steps, buffered landing/turn, landing facing. */
function clearMoveQueue(m: MovementContext): void {
  m.moveSteps = [];
  m.placedLanding = null;
  m.moveFinalFacing = null;
}

/** Movement budget for the declared mode (stand-in modes map to standstill).
 *  Posture-change modes share one budget: drop 1 / stand 2 deducted. */
export function budgetFor(unit: UnitState, context: MovementContext): number {
  const def = mechDefFor(unit);
  const movement = effectiveMovement(
    def,
    unit.damage,
    unit.critSlotsDestroyed,
    isTsmActive(def, unit.heat),
  );
  const declared = context.moveMode ?? null;
  if (declared === "prone") {
    return Math.max(0, effectiveMoveBudget("walk", movement, unit.heat) - DROP_MP_COST);
  }
  if (declared === "turn") {
    return effectiveMoveBudget("walk", movement, unit.heat);
  }
  if (declared === "pronestill") {
    return 0;
  }
  if (declared === "standup") {
    const loco = context.postureMove ?? "walk";
    return Math.max(0, effectiveMoveBudget(loco, movement, unit.heat) - STAND_MP_COST);
  }
  const mode: MoveMode =
    declared === "shutdown" || declared === "startup" || declared === "eject" || declared === null
      ? "standStill"
      : declared;
  return effectiveMoveBudget(mode, movement, unit.heat);
}

/** Full locomotion budget without posture deduction (stepResult denominator). */
function fullBudgetFor(unit: UnitState, context: MovementContext): number {
  const def = mechDefFor(unit);
  const movement = effectiveMovement(
    def,
    unit.damage,
    unit.critSlotsDestroyed,
    isTsmActive(def, unit.heat),
  );
  const mode = context.moveMode ?? null;
  if (mode === "prone") return effectiveMoveBudget("walk", movement, unit.heat);
  if (mode === "turn") return effectiveMoveBudget("walk", movement, unit.heat);
  if (mode === "pronestill") return 0;
  if (mode === "standup")
    return effectiveMoveBudget(context.postureMove ?? "walk", movement, unit.heat);
  return budgetFor(unit, context);
}

/** Posture MP already reserved by the declared mode (0 for plain moves). */
export function postureCostFor(s: Session): number {
  const mode = s.move?.moveMode ?? null;
  if (mode === "prone") return DROP_MP_COST;
  if (mode === "standup") return STAND_MP_COST;
  return 0;
}

/** Display mode for previews: prone/standup carry their sub-mode arg. */
function displayMovementModeStr(m: MovementContext): string {
  if (m.moveMode === "standup") return `standup ${m.postureMove ?? "walk"}`;
  if (m.moveMode === "prone")
    return `prone ${m.postureMove === "standStill" ? "pronestill" : "turn"}`;
  return m.moveMode ?? "";
}

/**
 * Buffer the full path to a reachable landing, replacing any previously queued
 * steps. `landing` must come from the current `moveCandidate`; its `path`
 * fragment sequence is replayed from the unit's start, so every enter is
 * necessarily straight ahead/back vs the moving facing and within the mode
 * budget (the candidate was validated by `reachableLandings` at `mode` time).
 * Jump turns are free (engine rejects turn steps), so `R`/`L` fragments only
 * advance the cursor facing and the landing facing travels via `moveFinalFacing`.
 * The buffered landing doubles as the preview source: `status`/`candidate`
 * render `placedLanding.path` directly, no replay.
 */
export function placeLanding(s: Session, landing: RevealedLanding): void {
  const { battle, context } = requireBattleAndContext(s);
  const unit = requireUnit(battle, context.actorId);
  if (
    context.moveMode === "shutdown" ||
    context.moveMode === "startup" ||
    context.moveMode === "eject"
  ) {
    throw new Error(i18n("err.noMoveInShutdownMode"));
  }
  if (!context.moveMode)
    throw new Error(i18n("err.declareModeFirst", { id: unit.id, modes: modeSyntaxFor(unit) }));
  if (context.moveMode === "standStill" || context.moveMode === "pronestill")
    throw new Error(i18n("err.standStillNoEnter"));
  const locomotion =
    context.moveMode === "standup" || context.moveMode === "prone"
      ? (context.postureMove ?? "walk")
      : context.moveMode === "turn"
        ? "walk"
        : context.moveMode;
  const jumping = locomotion === "jump";
  const steps: MoveStep[] = [];
  let hex: HexCoord = unit.position;
  let facing: Facing = unit.facing;
  for (const step of landing.path) {
    const frag = step.fragment;
    if (frag === "R" || frag === "L") {
      const delta = frag === "R" ? 1 : -1;
      facing = rotateFacing(facing, delta);
      if (!jumping) steps.push({ kind: "turn", facings: delta });
      continue;
    }
    const isBackward = frag === "B";
    const to = neighbor(hex, isBackward ? oppositeFacing(facing) : facing);
    steps.push({ kind: "enter", to });
    hex = to;
  }
  // Standup free facing pick (TW p.50): the unit is staying on its start
  // hex but wants a different facing — no MP, no steps, just the new facing
  // carried through `moveFinalFacing`. Other landings replay from
  // `unit.facing` normally.
  if (context.moveMode === "standup" && isStandupFreePick(unit, landing)) {
    context.moveSteps = [];
    context.moveFinalFacing = landing.facing;
    context.placedLanding = landing;
    return;
  }
  context.moveSteps = steps;
  context.moveFinalFacing = jumping ? landing.facing : null;
  context.placedLanding = landing;
}

/**
 * Detect the standup "free facing" pick (TW p.50): start hex, empty path,
 * non-unit facing. Such a pick costs no MP and no turn steps; the chosen
 * facing is carried via `moveFinalFacing`.
 */
function isStandupFreePick(
  unit: { position: HexCoord; facing: Facing },
  landing: RevealedLanding,
): boolean {
  return (
    landing.path.length === 0 &&
    landing.hex.col === unit.position.col &&
    landing.hex.row === unit.position.row &&
    landing.facing !== unit.facing
  );
}

export function cancelMovement(s: Session): void {
  const { context } = requireBattleAndContext(s);
  context.moveMode = null;
  context.postureMove = null;
  context.moveCandidate = null;
  clearMoveQueue(context);
}

export function commitMovement(s: Session): SessionGameEvent[] {
  const events: SessionGameEvent[] = [];
  commitAtomic(s, () => {
    // const collected: GameEvent[] = [];
    const { battle, context } = requireBattleAndContext(s);
    const unitId = context.actorId;
    const unit = requireUnit(battle, unitId);
    const collected: GameEvent[] = [];
    if (context.moveMode === "shutdown") {
      voluntaryShutdown(battle, unitId, collected);
    } else if (context.moveMode === "startup") {
      attemptVoluntaryStartup(battle, unitId, collected, s.rng);
    } else if (context.moveMode === "eject") {
      ejectPilot(battle, unitId, s.rng, collected);
    } else if (isShutdown(unit) || unit.unconscious) {
      // Down unit committing any other movement mode: hold position and
      // pass (startup/shutdown/eject handled above; nothing else is legal
      // while off-line or out cold). Without this the commit throws and the
      // activation never advances.
      passMovement(battle, unitId);
    } else if (context.moveMode === "standup") {
      const locomotion = context.postureMove ?? "walk";
      const steps = context.moveSteps;
      const finalFacing = context.moveFinalFacing;
      const posture = attemptStandUp(battle, unitId, collected, s.rng);
      const after = battle.units[unitId]!;
      if (!after.prone) {
        if (steps.length > 0 || finalFacing !== null) {
          executeMove(battle, unitId, locomotion, steps, collected, {
            ...(finalFacing === null ? { rng: s.rng } : { finalFacing, rng: s.rng }),
            spentMP: posture,
          });
        }
      }
    } else if (context.moveMode === "prone") {
      const steps = context.moveSteps;
      const finalFacing = context.moveFinalFacing;
      const locomotion = context.postureMove ?? "walk";
      dropProne(battle, unitId, collected, s.rng);
      if (steps.length > 0 || finalFacing !== null) {
        const posture = DROP_MP_COST;
        executeMove(battle, unitId, locomotion, steps, collected, {
          ...(finalFacing === null ? { rng: s.rng } : { finalFacing, rng: s.rng }),
          spentMP: posture,
        });
      }
    } else if (context.moveMode === "turn") {
      const steps = context.moveSteps;
      executeMove(battle, unitId, "walk", steps, collected, { rng: s.rng });
    } else if (context.moveMode === "pronestill") {
      executeMove(battle, unitId, "standStill", [], collected, { rng: s.rng });
    } else {
      // Past this branch m.moveMode is a real MoveMode (the special posture
      // strings above were the only alternatives).
      const mode = context.moveMode as MoveMode;
      executeMove(
        battle,
        unitId,
        mode,
        context.moveSteps,
        collected,
        context.moveFinalFacing === null
          ? { rng: s.rng }
          : { finalFacing: context.moveFinalFacing, rng: s.rng },
      );
    }
    clearContext(s);
    events.push(...collected, { kind: "sessionMoveActorDone", actorId: unitId }, ...drive(s));
  });
  return events;
}

/**
 * Board render info of the reachable hex map for the declared mode, or null
 * when no reachable hexes exist. Every reachable (hex, facing) landing is
 * handed to `createBoardModel` (in the render layer), which crops the model
 * to the reachable bounding box and tints markers/edges with the actor team.
 * Raw `RevealedLanding.path` data is retained on the landing and rendered
 * by the `place`/`status` preview straight from the candidate.
 */
export function reachablesInfo(s: Session): BoardRenderReachableInfo {
  const { battle, context } = requireBattleAndContext(s);
  const actor = requireUnit(battle, context.actorId);
  const mode = s.move!.moveMode;
  if (
    mode === null ||
    mode === "shutdown" ||
    mode === "startup" ||
    mode === "eject" ||
    mode === "pronestill"
  ) {
    return { team: actor.team, revealed: [] };
  }
  // Engine guarantee: `actor.model` was validated by `createBattle`.
  const def = mechDefFor(actor);
  const effMove = effectiveMovement(
    def,
    actor.damage,
    actor.critSlotsDestroyed,
    isTsmActive(def, actor.heat),
    waterDepth(cellAt(s.battle!, actor.position).terrain),
  );
  const heatPenalty = movementMpPenalty(actor.heat);
  // Posture-change modes share one budget: candidate assumes posture succeeds.
  // prone turn: drop first (1 MP) then in-place turns (walk + prone, 1 MP each).
  // prone pronestill: drop in place, no map. turn: in-place turns on walk budget.
  // pronestill: no map, `place` stays shut.
  // standup: stand first (2 MP) then chosen locomotion as standing unit.
  let locomotion: MoveMode;
  let proneFlag = actor.prone;
  let walking = Math.max(0, effMove.walking - heatPenalty);
  let running = Math.max(0, effMove.running - heatPenalty);
  let jumping = Math.max(0, effMove.jumping - heatPenalty);
  const postureMove = s.move?.postureMove ?? null;
  if (mode === "prone") {
    if ((postureMove ?? "walk") === "standStill") return { team: actor.team, revealed: [] }; // drop in place: no map
    locomotion = "walk";
    proneFlag = true;
    walking = Math.max(0, walking - DROP_MP_COST);
  } else if (mode === "turn") {
    locomotion = "walk";
    proneFlag = true;
  } else if (mode === "standup") {
    locomotion = postureMove ?? "standStill";
    proneFlag = false;
    if (locomotion === "standStill") return { team: actor.team, revealed: [] }; // stand in place: no map, `place` stays shut
    if (locomotion === "walk") walking = Math.max(0, walking - STAND_MP_COST);
    else if (locomotion === "run") running = Math.max(0, running - STAND_MP_COST);
    else if (locomotion === "jump") jumping = Math.max(0, jumping - STAND_MP_COST);
    else walking = Math.max(0, walking - STAND_MP_COST);
  } else {
    locomotion = mode;
  }
  return {
    team: actor.team,
    revealed: reachableLandings({ ...actor.position }, actor.facing, {
      mode: locomotion,
      walking,
      running,
      jumping,
      prone: proneFlag,
      grid: s.battle!,
      team: actor.team,
      ...(mode === "standup" ? { standup: true } : {}),
      wreckAt: (hex: HexCoord): boolean => wreckAt(s.battle!, hex) !== undefined,
      occupantTeam: (hex: HexCoord): number | undefined => {
        for (const u of Object.values(s.battle!.units)) {
          if (isUnitRemoved(u)) continue;
          if (u.position.col === hex.col && u.position.row === hex.row) return u.team;
        }
        return undefined;
      },
    }),
  };
}

/** Header plus one line per path step, for `place` output. Costs come
 *  straight from `MovePathStep` (`baseMp` per step, `totalMp` cumulative);
 *  destination hexes are recomputed by walking fragments from the actor start
 *  (turns rotate the cursor, `F`/`J`/`P`/`U` go forward, `B` goes backward).
 *  Jump re-facing fragments cost 0 and render no line (landing facing rides
 *  in the header). */
function stepResultLines(s: Session, landing: RevealedLanding): string[] {
  const { battle, context } = requireBattleAndContext(s);
  const actor = requireUnit(battle, context.actorId);
  const path = landing.path;
  const last = path[path.length - 1];
  const m = s.move;
  const mode = m?.moveMode ?? null;
  const postureCost = mode === "prone" ? DROP_MP_COST : mode === "standup" ? STAND_MP_COST : 0;
  const locomotion =
    mode === "standup" || mode === "prone"
      ? (m?.postureMove ?? "walk")
      : mode === "turn"
        ? "walk"
        : (mode ?? "standStill");
  const lines = [
    i18n("ok.stepResult", {
      id: m?.actorId ?? "",
      mode: displayModeFor(context),
      col: landing.hex.col,
      row: landing.hex.row,
      facing: F(landing.facing),
      posture: PRN(actor.prone),
      spent: postureCost + (last?.totalMp ?? 0),
      budget: fullBudgetFor(actor, context),
    }),
    stepResultFromLine(actor),
  ];
  const jumping = locomotion === "jump";
  let hex = { ...actor.position };
  let facing = actor.facing;
  for (const step of path) {
    const frag = step.fragment;
    if (frag === "R" || frag === "L") {
      facing = rotateFacing(facing, frag === "R" ? 1 : -1);
      if (!jumping) {
        lines.push(
          i18n("stepResult.turn", {
            dir: frag,
            facings: 1,
            mp: step.baseMp,
            perFacing: MP_PER_FACING_CHANGE,
          }),
        );
      }
      continue;
    }
    hex = neighbor(hex, frag === "B" ? oppositeFacing(facing) : facing);
    if (jumping) {
      lines.push(i18n("stepResult.jump", { col: hex.col, row: hex.row, mp: step.baseMp }));
    } else {
      lines.push(
        i18n("stepResult.enter", {
          type: locomotion === "walk" ? "walk" : "run",
          col: hex.col,
          row: hex.row,
          terrain: TRN(step.terrain),
          surcharge: step.terrainSurcharge,
          climb: step.climbCost,
          levels: step.climbLevels,
          mp: step.baseMp,
        }),
      );
    }
  }
  return lines;
}

export function stepResultChunk(s: Session, landing: RevealedLanding): Chunk {
  return buildLinesChunk(...stepResultLines(s, landing));
}

function queuedMoveLines(s: Session): string[] {
  const { battle, context } = requireBattleAndContext(s);
  const actor = requireUnit(battle, context.actorId);
  const landing = context.placedLanding ?? null;
  return landing === null
    ? [
        i18n("ok.modeDeclared", {
          id: actor.id,
          mode: displayModeFor(context),
          budget: budgetFor(actor, context),
        }),
        stepResultFromLine(actor),
      ]
    : stepResultLines(s, landing);
}

export function queuedMoveChunk(s: Session): Chunk {
  return buildLinesChunk(...queuedMoveLines(s));
}

export function moveStatusChunk(s: Session): Chunk {
  const lines: string[] = [];
  lines.push(...actorOrderLines(s), i18n("moveStatus.headLine"));
  const mode = s.move?.moveMode ?? null;
  if (mode === null || mode === "shutdown" || mode === "startup" || mode === "eject") {
    lines.push(i18n("moveStatus.noMode"));
  } else {
    lines.push(...queuedMoveLines(s).map((l) => `  ${l}`));
  }
  return buildLinesChunk(...lines);
}

export function reachableChunk(
  mapNameHolder: MapNameHolder,
  battle: BattleState,
  info: BoardRenderReachableInfo,
): Chunk {
  const map = mapDefFor(mapNameHolder);
  const battleUnits = battle.units;
  const units = Object.values(battleUnits)
    .filter((u) => !isUnitRemoved(u))
    .map((u) => createBoardRenderUnit(u));
  const ejectedUnits = createEjectedBoardRenderUnits(battleUnits, battle.wrecks);
  if (ejectedUnits.length > 0) units.push(...ejectedUnits);
  return buildBoardChunk({ map, units, reachable: info, clubHexes: clubHexKeys(battle) });
}

/** Display mode for previews: prone/standup carry their sub-mode arg. */
export function displayModeFor(m: MovementContext): string {
  if (m.moveMode === "standup") return `standup ${m.postureMove ?? "walk"}`;
  if (m.moveMode === "prone")
    return `prone ${m.postureMove === "standStill" ? "pronestill" : "turn"}`;
  return m.moveMode ?? "";
}

export function onEnterMovement(s: Session, sink: SessionGameEvent[]) {
  const { battle, context } = requireBattleAndContext(s);
  const actor = requireUnit(battle, context.actorId);
  const cell = cellAt(battle, actor.position);
  sink.push({
    kind: "sessionMoveActor",
    actorId: actor.id,
    position: actor.position,
    facing: actor.facing,
    prone: actor.prone,
    terrain: cell.terrain,
    elevation: cell.level,
    modes: modeSyntaxFor(actor),
  });
}
