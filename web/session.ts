import type {
  AmmoPolicy,
  Arc,
  AttackDecl,
  BattleState,
  CreateBattleOptions,
  Facing,
  FireSuggestion,
  GameEvent,
  HexCoord,
  MapDef,
  MapNameHolder,
  MoveMode,
  MoveStep,
  RevealedLanding,
  Rng,
  UnitInit,
  UnitState,
} from "btlib10x";
import {
  attemptStandUp,
  attemptVoluntaryStartup,
  createBattle,
  DEFAULT_GUNNERY,
  DEFAULT_PILOTING,
  DROP_MP_COST,
  declareAttacks,
  dropProne,
  effectiveMoveBudget,
  effectiveMovement,
  ejectPilot,
  executeMove,
  FACINGS,
  gameLoop,
  getMapDefFor,
  getMechDefFor,
  isShutdown,
  isUnitImmobile,
  isUnitRemoved,
  movementMpPenalty,
  neighbor,
  oppositeFacing,
  parseAmmoPolicy,
  passMovement,
  reachableLandings,
  requireUnit,
  rotateFacing,
  STAND_MP_COST,
  sameHex,
  validateAttacks,
  voluntaryShutdown,
  wreckAt,
} from "btlib10x";
import type { LocaleId } from "./i18n/index.js";
import { i18n } from "./i18n/index.js";
import { lookupMech } from "./lookup.js";
import type { BoardRenderReachableInfo } from "./render.js";
import { createRng } from "./rng.js";

export type AppState = "setup" | "battle" | "over";

export interface SetupContext extends MapNameHolder {
  seed: number;
  mapName: string | null;
  roster: UnitInit[];
}

/** Eagerly allocated by `drive()` on movement-phase entry, nulled when the
 *  phase exits or a new actor becomes current. Carries the pending move
 *  declaration: `moveMode`, `postureMove`, `moveSteps`, `moveFinalFacing`,
 *  `placedLanding`, plus `moveCandidate` (cached reachable map). Snapshotted
 *  whole by `commitAtomic` so failed commits can restore the declaration. */
export interface MoveContext {
  actorId: string;
  /** Pending declaration for the acting unit: a movement mode (engine
   *  `MoveMode`), a posture-change `standup` / `prone` attempt, or
   *  the voluntary `"shutdown"` / `"startup"` / `"eject"` declaration,
   *  committed by the `done` command. `standup` / `prone` may carry a queued
   *  `place` landing in `placedLanding`; `postureMove` holds the locomotion
   *  mode the queued steps run under after the posture change succeeds. */
  moveMode:
    | MoveMode
    | "shutdown"
    | "startup"
    | "eject"
    | "standup"
    | "prone"
    | "turn"
    | "pronestill"
    | null;
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

/** Eagerly allocated by `drive()` on weapon-attack-phase entry, nulled when
 *  the phase exits or a new actor becomes current. Carries `fireDecls`,
 *  `torsoTwist` (UI declaration, resets to `"front"` on allocation),
 *  `fireHintShownFor`, `fireCandidate`. */
export interface AttackContext {
  actorId: string;
  fireDecls: AttackDecl[];
  /** Acting unit's torso twist (TW pp.105-106) for the current attack-phase
   *  declaration: starts at `"front"` on context allocation (new actor or
   *  phase entry). Locked once any fire command is queued (see
   *  {@link setTorsoTwist}). Session-owned because it is a UI declaration,
   *  not persistent battle state. */
  torsoTwist: Arc;
  /** Actor (turn-qualified) whose fire suggestion was last auto-shown. */
  fireHintShownFor: string | null;
  fireCandidate: FireSuggestion | null;
}

/** Set by `drive()` when `checkSessionVictory` reports a winner; cleared
 *  on `startBattle` / `rematch` so the next battle starts fresh. */
export interface OverContext {
  victory: SessionVictoryResult;
}

export type SessionPhase = "attackResolution";

export type SessionGameEvent =
  | GameEvent
  | {
      readonly kind: "sessionPhase";
      readonly phase: SessionPhase;
    }
  | {
      readonly kind: "sessionPhaseDone";
      readonly phase: SessionPhase;
    }
  | {
      readonly kind: "sessionMoveActor";
      readonly actorId: string;
    }
  | {
      readonly kind: "sessionMoveActorDone";
      readonly actorId: string;
    }
  | {
      readonly kind: "sessionAttackActor";
      readonly actorId: string;
    }
  | {
      readonly kind: "sessionAttackActorDone";
      readonly actorId: string;
      readonly pass: boolean;
    };

export interface Session {
  app: AppState;
  /** Output language (UI preference; preserved across reset/rematch). */
  locale: LocaleId;
  rng: Rng;
  /** Always present: setup roster preserved across rematch. */
  setup: SetupContext;
  /** Eagerly populated by `drive()` on battle entry, nulled on phase exit. */
  move: MoveContext | null;
  /** Eagerly populated by `drive()` on attack-phase entry, nulled on exit. */
  attack: AttackContext | null;
  /** Populated when `drive()` detects victory, cleared on next battle. */
  over: OverContext | null;
  battle: BattleState | null;
  /** Suppress critical hit resolution (mostly for deterministic testing). */
  critsDisabled: boolean;
}

export function newSession(seed: number): Session {
  return {
    app: "setup",
    locale: "en",
    rng: createRng(seed),
    setup: { mapName: null, seed: seed, roster: [] },
    move: null,
    attack: null,
    over: null,
    battle: null,
    critsDisabled: false,
  };
}

/** Allocate a fresh move context for `actorId`. Default declaration is
 *  empty (`moveMode: null`); mutators fill in. */
function newMoveContext(actorId: string): MoveContext {
  return {
    actorId,
    moveMode: null,
    postureMove: null,
    moveSteps: [],
    moveFinalFacing: null,
    placedLanding: null,
    moveCandidate: null,
  };
}

/** Allocate a fresh attack context for `actorId`. `torsoTwist` starts at
 *  `"front"`; fire declarations and suggestion cache empty. */
function newAttackContext(actorId: string): AttackContext {
  return {
    actorId,
    fireDecls: [],
    torsoTwist: "front",
    fireHintShownFor: null,
    fireCandidate: null,
  };
}

/** Drop both per-phase contexts. Used on actor change / phase boundary
 *  inside `drive()` and on lifecycle resets (start, rematch, reset). */
function clearContexts(s: Session): void {
  s.move = null;
  s.attack = null;
}

function ensureContextsCleared(s: Session): void {
  if (s.move !== null || s.attack !== null) {
    throw new Error("both context supposed to be cleared");
  }
}

export interface SessionVictoryResult {
  readonly winnerTeam: number | null;
  readonly draw: boolean;
}

export function checkSessionVictory(state: BattleState): SessionVictoryResult | null {
  const aliveTeams = new Set(
    Object.values(state.units)
      .filter((u) => !isUnitRemoved(u))
      .map((u) => u.team),
  );
  if (aliveTeams.size <= 1) {
    return { winnerTeam: aliveTeams.values().next().value ?? null, draw: aliveTeams.size === 0 };
  }
  return null;
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
  const mc = { team: requireMoveActor(s).team, revealed: [] };
  s.move!.moveCandidate = mc;
  return mc;
}

/**
 * Advance the battle through transient phases until an actor must act or the
 * game ends. Wraps {@link gameLoop} with session-side effects (app state,
 * per-phase context allocation) and returns the events generated during
 * this call.
 *
 * Per-phase contexts are eagerly (re)allocated whenever the current actor
 * changes or the phase changes mid-actor. The inactive side is always
 * nulled first, so `s.move` and `s.attack` are never simultaneously
 * populated. A fresh `AttackContext` starts with `torsoTwist: "front"`,
 * subsuming the prior "phase entry reset" step.
 */
function drive(s: Session): SessionGameEvent[] {
  const battle = s.battle;
  if (!battle) return [];
  const v: SessionVictoryResult[] = [];
  const collected: GameEvent[] = [];
  const wasInAttack = battle.phase === "weaponAttack";
  const r = gameLoop(
    battle,
    s.rng,
    (state) => {
      const victory = checkSessionVictory(state);
      if (victory !== null) {
        v.push(victory);
        return true;
      }
      return false;
    },
    collected,
  );
  if (v.length > 0) {
    const victory = v[0]!;
    s.app = "over";
    s.over = { victory };
    clearContexts(s);
    return collected;
  }
  const result: SessionGameEvent[] = [];
  if (wasInAttack && battle.phase !== "weaponAttack") {
    result.push({ kind: "sessionPhase", phase: "attackResolution" });
    for (const e of collected) {
      if (e.kind === "phase" && e.prevPhase === "weaponAttack") {
        result.push({ kind: "sessionPhaseDone", phase: "attackResolution" });
      }
      result.push(e);
    }
  }
  s.app = "battle";
  const id = r.actorId;
  const inMovement = battle.phase === "movement";
  if (id !== null) {
    if (inMovement && (s.move === null || s.move.actorId !== id)) {
      ensureContextsCleared(s);
      s.move = newMoveContext(id);
      s.attack = null;
      result.push({ kind: "sessionMoveActor", actorId: s.move.actorId });
    }
    if (!inMovement && (s.attack === null || s.attack.actorId !== id)) {
      ensureContextsCleared(s);
      s.attack = newAttackContext(id);
      s.move = null;
      result.push({ kind: "sessionAttackActor", actorId: s.attack.actorId });
    }
  }
  return result;
}

export function currentActor(s: Session): UnitState | null {
  if (s.app !== "battle" || !s.battle) return null;
  const id = s.move?.actorId ?? s.attack?.actorId ?? null;
  return id === null ? null : requireUnit(s.battle, id);
}

export function requireMoveActor(s: Session): UnitState {
  return requireUnit(requireBattle(s), s.move!.actorId);
}

/** Prompt body without the trailing ">". */
export function promptBody(s: Session): string {
  switch (s.app) {
    case "setup":
      return i18n(s.locale, "prompt.setup");
    case "over": {
      const victory = s.over?.victory;
      const winner = victory?.draw
        ? i18n(s.locale, "prompt.draw")
        : i18n(s.locale, "prompt.winnerTeam", { team: victory?.winnerTeam ?? "?" });
      return i18n(s.locale, "prompt.over", {
        winner,
        turn: s.battle?.turn ?? "?",
      });
    }
    case "battle": {
      const st = s.battle!;
      const phase =
        st.phase === "movement"
          ? i18n(s.locale, "prompt.subMove")
          : i18n(s.locale, "prompt.subAttack");
      const actor = currentActor(s);
      return i18n(s.locale, "prompt.turn", {
        turn: st.turn,
        phase,
        team: actor?.team ?? "?",
        id: actor?.id ?? "?",
      });
    }
  }
}

// ---------------------------------------------------------------- setup ----

export function setMap(s: Session, m: MapDef): void {
  if (s.setup.mapName !== null) {
    for (const u of s.setup.roster) {
      if (u.position.col > m.width) {
        throw new Error(
          i18n(s.locale, "err.unitOutOfBounds", {
            id: u.id,
            label: "col",
            value: u.position.col,
            max: m.width,
          }),
        );
      }
      if (u.position.row > m.height) {
        throw new Error(
          i18n(s.locale, "err.unitOutOfBounds", {
            id: u.id,
            label: "row",
            value: u.position.row,
            max: m.height,
          }),
        );
      }
    }
  }
  s.setup.mapName = m.name;
}

export function pickTeam(roster: UnitInit[]): number {
  if (roster.length === 0) return 0;
  const counts: [number, number] = [0, 0];
  for (const u of roster) {
    if (u.team === 0) counts[0]++;
    else if (u.team === 1) counts[1]++;
  }
  return counts[0] <= counts[1] ? 0 : 1;
}

export interface AddUnitResult {
  model: string;
  team: number;
}

export function addUnit(
  s: Session,
  id: string,
  model: string,
  position: HexCoord,
  facing: Facing,
): AddUnitResult {
  const m = lookupMech(model);
  if (m === undefined) throw new Error(i18n(s.locale, "err.unknownModel", { model }));
  if (s.setup.roster.some((u) => u.id === id))
    throw new Error(i18n(s.locale, "err.duplicateId", { id }));
  if (s.setup.roster.some((u) => sameHex(u.position, position))) {
    throw new Error(i18n(s.locale, "err.hexOccupied", { col: position.col, row: position.row }));
  }
  const map = s.setup.mapName != null ? getMapDefFor(s.setup) : undefined;
  if (map !== undefined) {
    if (position.col > map.width) {
      throw new Error(
        i18n(s.locale, "err.outOfBounds", { label: "col", value: position.col, max: map.width }),
      );
    }
    if (position.row > map.height) {
      throw new Error(
        i18n(s.locale, "err.outOfBounds", { label: "row", value: position.row, max: map.height }),
      );
    }
  }
  const team = pickTeam(s.setup.roster);
  s.setup.roster.push({
    id,
    model: m.model,
    team,
    gunnery: DEFAULT_GUNNERY,
    piloting: DEFAULT_PILOTING,
    position,
    facing,
  });
  return { model: m.model, team };
}

export type UnitProp = "model" | "team" | "col" | "row" | "facing" | "gunnery" | "piloting";

export const UNIT_PROPS: ReadonlyArray<UnitProp> = [
  "model",
  "team",
  "col",
  "row",
  "facing",
  "gunnery",
  "piloting",
];

export function parseUnitProp(locale: LocaleId, word: string): UnitProp {
  const lower = word.toLowerCase();
  if ((UNIT_PROPS as readonly string[]).includes(lower)) return lower as UnitProp;
  throw new Error(i18n(locale, "err.unknownProp", { name: word, list: UNIT_PROPS.join(", ") }));
}

export function setUnitProp(
  s: Session,
  id: string,
  prop: UnitProp,
  raw: string,
): { prop: UnitProp; value: string } {
  const unit = s.setup.roster.find((u) => u.id === id);
  if (unit === undefined) throw new Error(i18n(s.locale, "err.unknownUnitId", { id }));
  const locale = s.locale;
  switch (prop) {
    case "model": {
      const m = lookupMech(raw);
      if (m === undefined) throw new Error(i18n(locale, "err.unknownModel", { model: raw }));
      unit.model = m.model;
      return { prop, value: m.model };
    }
    case "team": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) throw new Error(i18n(locale, "err.badTeam"));
      unit.team = n;
      return { prop, value: String(n) };
    }
    case "col": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1)
        throw new Error(i18n(locale, "err.oneBased", { label: "col" }));
      const map = s.setup.mapName != null ? getMapDefFor(s.setup) : undefined;
      if (map !== undefined && n > map.width)
        throw new Error(
          i18n(locale, "err.outOfBounds", { label: "col", value: n, max: map.width }),
        );
      const newRow = unit.position.row;
      if (
        s.setup.roster.some((u) => u.id !== id && u.position.col === n && u.position.row === newRow)
      )
        throw new Error(i18n(locale, "err.hexOccupied", { col: n, row: newRow }));
      unit.position = { col: n, row: newRow };
      return { prop, value: String(n) };
    }
    case "row": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1)
        throw new Error(i18n(locale, "err.oneBased", { label: "row" }));
      const map = s.setup.mapName != null ? getMapDefFor(s.setup) : undefined;
      if (map !== undefined && n > map.height)
        throw new Error(
          i18n(locale, "err.outOfBounds", { label: "row", value: n, max: map.height }),
        );
      const newCol = unit.position.col;
      if (
        s.setup.roster.some((u) => u.id !== id && u.position.col === newCol && u.position.row === n)
      )
        throw new Error(i18n(locale, "err.hexOccupied", { col: newCol, row: n }));
      unit.position = { col: newCol, row: n };
      return { prop, value: String(n) };
    }
    case "facing": {
      const f = FACINGS.find((x) => x === raw.toLowerCase());
      if (!f) throw new Error(i18n(locale, "err.faceArg", { facings: FACINGS.join("/") }));
      unit.facing = f;
      return { prop, value: f };
    }
    case "gunnery": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 7) throw new Error(i18n(locale, "err.badGunnery"));
      unit.gunnery = n;
      return { prop, value: String(n) };
    }
    case "piloting": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 7) throw new Error(i18n(locale, "err.badPiloting"));
      unit.piloting = n;
      return { prop, value: String(n) };
    }
  }
}

export function removeUnit(s: Session, id: string): void {
  if (!s.setup.roster.some((u) => u.id === id))
    throw new Error(i18n(s.locale, "err.noSuchUnit", { id }));
  s.setup.roster = s.setup.roster.filter((u) => u.id !== id);
}

/** Shared createBattle options: setup terrain plus the loaded map's size. */
function battleOptions(s: Session): CreateBattleOptions {
  return {
    critsDisabled: s.critsDisabled,
  };
}

export function startBattle(s: Session): SessionGameEvent[] {
  if (s.app !== "setup") throw new Error(i18n(s.locale, "err.alreadyStarted"));
  if (s.setup.roster.length < 2) throw new Error(i18n(s.locale, "err.needTwoUnits"));
  const teams = new Set(s.setup.roster.map((u) => u.team));
  if (teams.size < 2) throw new Error(i18n(s.locale, "err.needTwoTeams"));
  const map = getMapDefFor(s.setup);
  s.battle = createBattle(map, s.setup.roster, battleOptions(s));
  s.over = null;
  clearContexts(s);
  return drive(s);
}

// ------------------------------------------------------------- movement ----

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

export type DeclaredMode =
  | MoveMode
  | "shutdown"
  | "startup"
  | "eject"
  | "standup"
  | "prone"
  | "turn"
  | "pronestill";

export function parseMoveMode(locale: LocaleId, word: string): DeclaredMode {
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
  throw new Error(i18n(locale, "err.badModeWord", { modes: modeSyntaxFor(null) }));
}

/** Locale-neutral `mode` syntax legal for `unit` right now (null = unknown unit). */
export function modeSyntaxFor(unit: UnitState | null): string {
  if (unit === null)
    return "standstill|walk|run|jump|prone [turn|pronestill]|turn|pronestill|standup [walk|run|jump|standstill]|shutdown|startup|eject";
  if (isShutdown(unit)) return "startup|eject";
  if (isUnitImmobile(unit.damage))
    return unit.prone ? "pronestill|shutdown|eject" : "standstill|shutdown|eject";
  if (unit.prone) return "turn|pronestill|standup [walk|run|jump|standstill]|shutdown|eject";
  return "standstill|walk|run|jump|prone [turn|pronestill]|shutdown|eject";
}

/** One-line `modes: ...` hint shown above the movement prompt; null outside it. */
export function moveModesHint(s: Session): string | null {
  if (s.app !== "battle" || s.battle?.phase !== "movement") return null;
  const actor = currentActor(s);
  if (actor === null) return null;
  return i18n(s.locale, "mode.hint", { modes: modeSyntaxFor(actor) });
}

function requireBattle(s: Session): BattleState {
  if (!s.battle) throw new Error(i18n(s.locale, "err.noBattle"));
  return s.battle;
}

function requireActor(s: Session, phase: "movement" | "weaponAttack"): UnitState {
  const unit = currentActor(s);
  if (!unit || !s.battle || s.battle.phase !== phase) {
    throw new Error(i18n(s.locale, "err.wrongPhase", { phase }));
  }
  return unit;
}

/** Mutator-side accessor for the active move context. Throws if not in the
 *  movement phase (the engine never reaches a move-declaring code path
 *  outside movement). */
function requireMove(s: Session): MoveContext {
  if (!s.move || s.battle?.phase !== "movement") {
    throw new Error(i18n(s.locale, "err.wrongPhase", { phase: "movement" }));
  }
  return s.move;
}

/** Mutator-side accessor for the active attack context. Throws if not in
 *  the weapon-attack phase. */
function requireAttack(s: Session): AttackContext {
  if (!s.attack || s.battle?.phase !== "weaponAttack") {
    throw new Error(i18n(s.locale, "err.wrongPhase", { phase: "weaponAttack" }));
  }
  return s.attack;
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
  const actor = requireMoveActor(s);
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
  const def = getMechDefFor(actor);
  const effMove = effectiveMovement(def, actor.critSlotsDestroyed);
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

export function declareMode(s: Session, word: string, locomotionWord?: string): void {
  const unit = requireActor(s, "movement");
  const mode = parseMoveMode(s.locale, word);
  const m = requireMove(s);
  if (mode === "shutdown") {
    if (isShutdown(unit)) throw new Error(i18n(s.locale, "err.mustBeOnlineForShutdown"));
    m.moveMode = "shutdown";
    m.postureMove = null;
    clearMoveQueue(m);
    return;
  }
  if (mode === "startup") {
    if (unit.shutdown === "not") throw new Error(i18n(s.locale, "err.mustBeDownForStartup"));
    if (unit.shutdown === "starting") throw new Error(i18n(s.locale, "err.alreadyStarting"));
    m.moveMode = "startup";
    m.postureMove = null;
    clearMoveQueue(m);
    return;
  }
  if (mode === "eject") {
    if (isUnitRemoved(unit)) throw new Error(i18n(s.locale, "err.alreadyEjected", { id: unit.id }));
    m.moveMode = "eject";
    m.postureMove = null;
    clearMoveQueue(m);
    return;
  }
  if (mode === "standup") {
    if (!unit.prone)
      throw new Error(
        i18n(s.locale, "err.standupRequiresProne", {
          id: unit.id,
          modes: modeSyntaxFor(unit),
        }),
      );
    if (isUnitImmobile(unit.damage))
      throw new Error(i18n(s.locale, "err.postureBudget", { id: unit.id }));
    const chosen = parseStandupLocomotion(s, locomotionWord);
    const def = getMechDefFor(unit);
    const movement = effectiveMovement(def, unit.critSlotsDestroyed);
    // Standing in place draws the stand cost from the walk pool.
    const budgetMode = chosen === "standStill" ? "walk" : chosen;
    if (effectiveMoveBudget(budgetMode, movement, unit.heat) < STAND_MP_COST) {
      throw new Error(i18n(s.locale, "err.postureBudget", { id: unit.id }));
    }
    // Engine declareMove deferred to commit: unit still prone, would throw.
    m.moveMode = "standup";
    m.postureMove = chosen;
    clearMoveQueue(m);
    return;
  }
  if (mode === "prone") {
    if (unit.prone)
      throw new Error(
        i18n(s.locale, "err.proneRequiresStanding", {
          id: unit.id,
          modes: modeSyntaxFor(unit),
        }),
      );
    if (isUnitImmobile(unit.damage))
      throw new Error(i18n(s.locale, "err.postureBudget", { id: unit.id }));
    const sub = parseProneLocomotion(s, locomotionWord);
    const def = getMechDefFor(unit);
    const movement = effectiveMovement(def, unit.critSlotsDestroyed);
    if (effectiveMoveBudget("walk", movement, unit.heat) < DROP_MP_COST) {
      throw new Error(i18n(s.locale, "err.postureBudget", { id: unit.id }));
    }
    // Drop deferred to commit; turn candidate assumes prone-after-drop.
    m.moveMode = "prone";
    m.postureMove = sub;
    clearMoveQueue(m);
    return;
  }
  if (mode === "turn") {
    if (!unit.prone)
      throw new Error(
        i18n(s.locale, "err.turnRequiresProne", { id: unit.id, modes: modeSyntaxFor(unit) }),
      );
    if (isUnitImmobile(unit.damage))
      throw new Error(i18n(s.locale, "err.postureBudget", { id: unit.id }));
    if (locomotionWord !== undefined)
      throw new Error(i18n(s.locale, "err.turnTakesNoArg", { modes: modeSyntaxFor(unit) }));
    const def = getMechDefFor(unit);
    const movement = effectiveMovement(def, unit.critSlotsDestroyed);
    if (effectiveMoveBudget("walk", movement, unit.heat) < 1) {
      throw new Error(i18n(s.locale, "err.postureBudget", { id: unit.id }));
    }
    // Engine declareMove deferred to commit: unit still prone, would throw.
    m.moveMode = "turn";
    m.postureMove = null;
    clearMoveQueue(m);
    return;
  }
  if (mode === "pronestill") {
    if (!unit.prone)
      throw new Error(
        i18n(s.locale, "err.pronestillRequiresProne", {
          id: unit.id,
          modes: modeSyntaxFor(unit),
        }),
      );
    if (locomotionWord !== undefined)
      throw new Error(i18n(s.locale, "err.pronestillTakesNoArg", { modes: modeSyntaxFor(unit) }));
    m.moveMode = "pronestill";
    m.postureMove = null;
    clearMoveQueue(m);
    return;
  }
  if (isShutdown(unit)) {
    throw new Error(
      i18n(s.locale, "err.shutdownNoMove", { id: unit.id, modes: modeSyntaxFor(unit) }),
    );
  }
  if (unit.prone) {
    throw new Error(
      i18n(s.locale, "err.proneMustDeclare", { id: unit.id, modes: modeSyntaxFor(unit) }),
    );
  }
  if (mode !== "standStill" && mode !== "walk" && mode !== "run" && mode !== "jump") {
    throw new Error(i18n(s.locale, "err.badModeWord", { modes: modeSyntaxFor(unit) }));
  }
  if (isUnitImmobile(unit.damage) && mode !== "standStill") {
    throw new Error(
      i18n(s.locale, "err.immobileStandstill", { id: unit.id, modes: modeSyntaxFor(unit) }),
    );
  }
  // Engine call is deferred to commit (mode walk/run/jump/standstill executeMove).
  m.moveMode = mode;
  m.postureMove = null;
  clearMoveQueue(m);
}

/** Locomotion arg for `mode prone [turn|pronestill]` (default turn). */
function parseProneLocomotion(s: Session, word: string | undefined): MoveMode {
  if (word === undefined) return "walk";
  const w = word.toLowerCase();
  if (w === "turn") return "walk";
  if (w === "pronestill") return "standStill";
  throw new Error(i18n(s.locale, "err.proneNeedsMode", { modes: modeSyntaxFor(currentActor(s)) }));
}
/** Locomotion arg for `mode standup [walk|run|jump|standstill]` (default standstill). */
function parseStandupLocomotion(s: Session, word: string | undefined): MoveMode {
  if (word === undefined) return "standStill";
  const w = word.toLowerCase();
  if (w === "walk" || w === "run" || w === "jump" || w === "standstill")
    return w === "standstill" ? "standStill" : w;
  throw new Error(i18n(s.locale, "err.standupNeedsMode"));
}

/** Clear queued movement: steps, buffered landing/turn, landing facing. */
function clearMoveQueue(m: MoveContext): void {
  m.moveSteps = [];
  m.placedLanding = null;
  m.moveFinalFacing = null;
}

/** Movement budget for the declared mode (stand-in modes map to standstill).
 *  Posture-change modes share one budget: drop 1 / stand 2 deducted. */
export function budgetFor(s: Session): number {
  const unit = currentActor(s)!;
  const def = getMechDefFor(unit);
  const movement = effectiveMovement(def, unit.critSlotsDestroyed);
  const declared = s.move?.moveMode ?? null;
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
    const loco = s.move?.postureMove ?? "walk";
    return Math.max(0, effectiveMoveBudget(loco, movement, unit.heat) - STAND_MP_COST);
  }
  const mode: MoveMode =
    declared === "shutdown" || declared === "startup" || declared === "eject" || declared === null
      ? "standStill"
      : declared;
  return effectiveMoveBudget(mode, movement, unit.heat);
}

/** Full locomotion budget without posture deduction (stepResult denominator). */
export function fullBudgetFor(s: Session): number {
  const unit = currentActor(s)!;
  const def = getMechDefFor(unit);
  const movement = effectiveMovement(def, unit.critSlotsDestroyed);
  const mode = s.move?.moveMode ?? null;
  if (mode === "prone") return effectiveMoveBudget("walk", movement, unit.heat);
  if (mode === "turn") return effectiveMoveBudget("walk", movement, unit.heat);
  if (mode === "pronestill") return 0;
  if (mode === "standup")
    return effectiveMoveBudget(s.move?.postureMove ?? "walk", movement, unit.heat);
  return budgetFor(s);
}

/** Posture MP already reserved by the declared mode (0 for plain moves). */
export function postureCostFor(s: Session): number {
  const mode = s.move?.moveMode ?? null;
  if (mode === "prone") return DROP_MP_COST;
  if (mode === "standup") return STAND_MP_COST;
  return 0;
}

/** Display mode for previews: prone/standup carry their sub-mode arg. */
export function displayModeFor(s: Session): string {
  const m = s.move;
  if (m?.moveMode === "standup") return `standup ${m.postureMove ?? "walk"}`;
  if (m?.moveMode === "prone")
    return `prone ${m.postureMove === "standStill" ? "pronestill" : "turn"}`;
  return m?.moveMode ?? "";
}

/** Resolve a `place` facing argument: an absolute facing word. */
export function resolveFacing(locale: LocaleId, arg: string): Facing {
  const facing = FACINGS.find((f) => f === arg.toLowerCase());
  if (!facing) throw new Error(i18n(locale, "err.faceArg", { facings: FACINGS.join("/") }));
  return facing;
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
  const unit = requireActor(s, "movement");
  const m = requireMove(s);
  if (m.moveMode === "shutdown" || m.moveMode === "startup" || m.moveMode === "eject") {
    throw new Error(i18n(s.locale, "err.noMoveInShutdownMode"));
  }
  if (!m.moveMode)
    throw new Error(
      i18n(s.locale, "err.declareModeFirst", { id: unit.id, modes: modeSyntaxFor(unit) }),
    );
  if (m.moveMode === "standStill" || m.moveMode === "pronestill")
    throw new Error(i18n(s.locale, "err.standStillNoEnter"));
  const locomotion =
    m.moveMode === "standup" || m.moveMode === "prone"
      ? (m.postureMove ?? "walk")
      : m.moveMode === "turn"
        ? "walk"
        : m.moveMode;
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
  if (m.moveMode === "standup" && isStandupFreePick(unit, landing)) {
    m.moveSteps = [];
    m.moveFinalFacing = landing.facing;
    m.placedLanding = landing;
    return;
  }
  m.moveSteps = steps;
  m.moveFinalFacing = jumping ? landing.facing : null;
  m.placedLanding = landing;
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

export function cancelMove(s: Session): void {
  const m = requireMove(s);
  m.moveMode = null;
  m.postureMove = null;
  clearMoveQueue(m);
}

export interface CommitResult {
  state: BattleState;
  events: SessionGameEvent[];
}

/**
 * Per-phase session contexts snapshotted beside battle + rng so failed
 * commits leave zero trace. Excludes `rng` (closures break structuredClone),
 * `battle` (snapshotted separately), `setup`/`locale`/`critsDisabled`
 * (never mutated inside commits). Snapshots are deep on whichever context
 * is active: setup/over commits skip move entirely, movement commits skip
 * attack (and its `fireCandidate` cache).
 */
interface SessionCommitSnapshot {
  app: AppState;
  move: MoveContext | null;
  attack: AttackContext | null;
  over: OverContext | null;
}

function snapshotSessionCommit(s: Session): SessionCommitSnapshot {
  return {
    app: s.app,
    move: s.move === null ? null : structuredClone(s.move),
    attack: s.attack === null ? null : structuredClone(s.attack),
    over: s.over === null ? null : structuredClone(s.over),
  };
}

function restoreSessionCommit(s: Session, snap: SessionCommitSnapshot): void {
  s.app = snap.app;
  s.move = snap.move;
  s.attack = snap.attack;
  s.over = snap.over;
}

/**
 * Apply a commit atomically: on any thrown error battle, rng, and session
 * buffers roll back to snapshots taken before commit, so failed validation
 * can never leave live game state partially mutated nor shift deterministic
 * seed sequence. Callers must re-read live battle from `s.battle` after
 * success; closures must resolve units from live battle by id, never hold
 * pre-commit object refs across rollback boundary.
 */
function commitAtomic(s: Session, fn: () => void): void {
  const battle = s.battle;
  if (!battle) return;
  const battleSnapshot = structuredClone(battle);
  const rngSnapshot = s.rng.snapshot();
  const sessionSnapshot = snapshotSessionCommit(s);
  try {
    fn();
  } catch (e) {
    s.battle = battleSnapshot;
    s.rng.load(rngSnapshot);
    restoreSessionCommit(s, sessionSnapshot);
    throw e;
  }
}

export function commitMove(s: Session): CommitResult {
  const actor = requireActor(s, "movement");
  const unitId = actor.id;
  const events: SessionGameEvent[] = [];
  commitAtomic(s, () => {
    // const collected: GameEvent[] = [];
    const battle = requireBattle(s);
    const unit = requireUnit(battle, unitId);
    const m = requireMove(s);
    const collected: GameEvent[] = [];
    if (m.moveMode === "shutdown") {
      voluntaryShutdown(battle, unitId, collected);
    } else if (m.moveMode === "startup") {
      attemptVoluntaryStartup(battle, unitId, collected, s.rng);
    } else if (m.moveMode === "eject") {
      ejectPilot(battle, unitId, collected);
    } else if (isShutdown(unit) || unit.unconscious) {
      // Down unit committing any other movement mode: hold position and
      // pass (startup/shutdown/eject handled above; nothing else is legal
      // while off-line or out cold). Without this the commit throws and the
      // activation never advances.
      passMovement(battle, unitId);
    } else if (m.moveMode === "standup") {
      const locomotion = m.postureMove ?? "walk";
      const steps = m.moveSteps;
      const finalFacing = m.moveFinalFacing;
      attemptStandUp(battle, unitId, collected, s.rng);
      const after = battle.units[unitId]!;
      if (!after.prone) {
        if (steps.length > 0 || finalFacing !== null) {
          const posture = STAND_MP_COST;
          executeMove(battle, unitId, locomotion, steps, collected, {
            ...(finalFacing === null ? { rng: s.rng } : { finalFacing, rng: s.rng }),
            spentMP: posture,
          });
        }
      }
    } else if (m.moveMode === "prone") {
      const steps = m.moveSteps;
      const finalFacing = m.moveFinalFacing;
      const locomotion = m.postureMove ?? "walk";
      dropProne(battle, unitId, collected, s.rng);
      if (steps.length > 0 || finalFacing !== null) {
        const posture = DROP_MP_COST;
        executeMove(battle, unitId, locomotion, steps, collected, {
          ...(finalFacing === null ? { rng: s.rng } : { finalFacing, rng: s.rng }),
          spentMP: posture,
        });
      }
    } else if (m.moveMode === "turn") {
      const steps = m.moveSteps;
      executeMove(battle, unitId, "walk", steps, collected, { rng: s.rng });
    } else if (m.moveMode === "pronestill") {
      executeMove(battle, unitId, "standStill", [], collected, { rng: s.rng });
    } else {
      // Past this branch m.moveMode is a real MoveMode (the special posture
      // strings above were the only alternatives).
      const mode = m.moveMode as MoveMode;
      executeMove(
        battle,
        unitId,
        mode,
        m.moveSteps,
        collected,
        m.moveFinalFacing === null
          ? { rng: s.rng }
          : { finalFacing: m.moveFinalFacing, rng: s.rng },
      );
    }
    clearContexts(s);
    events.push(...collected, { kind: "sessionMoveActorDone", actorId: unitId }, ...drive(s));
  });
  return { state: requireBattle(s), events };
}

// -------------------------------------------------------------- attacks ----

export function queueFire(s: Session, decl: AttackDecl): void {
  const unit = requireActor(s, "weaponAttack");
  const battle = requireBattle(s);
  const a = requireAttack(s);
  if (decl.targetId === unit.id) throw new Error(i18n(s.locale, "err.selfTarget"));
  const target = battle.units[decl.targetId];
  if (!target) throw new Error(i18n(s.locale, "err.unknownUnitId", { id: decl.targetId }));
  if (target.team === unit.team) throw new Error(i18n(s.locale, "err.selfTarget"));
  if (isUnitRemoved(target))
    throw new Error(i18n(s.locale, "err.targetRemoved", { id: target.id }));
  const pending = a.fireDecls[0]?.targetId;
  if (pending !== undefined && pending !== decl.targetId) {
    throw new Error(i18n(s.locale, "err.oneTarget", { target: pending }));
  }
  if (a.fireDecls.some((d) => d.weaponIndex === decl.weaponIndex)) {
    throw new Error(i18n(s.locale, "err.weaponRepeated", { weapon: decl.weaponIndex }));
  }
  validateAttacks(battle, unit.id, [...a.fireDecls, decl], { twist: a.torsoTwist });
  a.fireDecls.push(decl);
}

export function cancelFire(s: Session): void {
  const a = requireAttack(s);
  a.fireDecls = [];
}

export function commitFire(s: Session): CommitResult {
  const actor = requireActor(s, "weaponAttack");
  const unitId = actor.id;
  const battle = requireBattle(s);
  const live = requireAttack(s);
  const events: SessionGameEvent[] = [];
  if (live.fireDecls.length === 0) {
    commitAtomic(s, () => {
      requireUnit(battle, unitId).passedAttacks = true;
      clearContexts(s);
      events.push(
        {
          kind: "sessionAttackActorDone",
          actorId: unitId,
          pass: true,
        },
        ...drive(s),
      );
    });
  } else {
    commitAtomic(s, () => {
      const collected: GameEvent[] = [];
      declareAttacks(battle, unitId, live.fireDecls, collected, s.rng, {
        twist: live.torsoTwist,
      });
      clearContexts(s);
      events.push(
        ...collected,
        {
          kind: "sessionAttackActorDone",
          actorId: unitId,
          pass: false,
        },
        ...drive(s),
      );
    });
  }
  return { state: requireBattle(s), events };
}

/**
 * Set the acting unit's torso twist (TW pp.105-106) for its current attack-phase
 * declaration. Locked once any fire command is queued — the user must
 * `cancel` first — and resets to `"front"` on phase entry or new actor.
 */
export function setTorsoTwist(s: Session, direction: string): void {
  const a = requireAttack(s);
  const allowed: Readonly<Record<string, Arc>> = {
    front: "front",
    left: "leftSide",
    right: "rightSide",
  };
  const arc = allowed[direction.toLowerCase()];
  if (arc === undefined) {
    throw new Error(i18n(s.locale, "err.twist.badDirection"));
  }
  if (a.fireDecls.length > 0) {
    throw new Error(i18n(s.locale, "err.twist.locked"));
  }
  if (a.torsoTwist === arc) return;
  a.torsoTwist = arc;
  a.fireCandidate = null;
  a.fireHintShownFor = null;
}

/**
 * Set the acting unit's ammo-depletion policy. Affects the order its ammo
 * bins are drained by future shots (and which bin explodes on a crit).
 */
export function setAmmoPolicy(s: Session, word: string): void {
  const unit = requireActor(s, "weaponAttack");
  const policy: AmmoPolicy | null = parseAmmoPolicy(word);
  if (policy === null) throw new Error(i18n(s.locale, "err.badAmmoPolicy"));
  unit.ammoPolicy = policy;
}

// ------------------------------------------------------------ lifecycle ----

export function rematch(s: Session): SessionGameEvent[] {
  if (s.app !== "over") throw new Error(i18n(s.locale, "err.rematchOnlyOver"));
  s.rng = createRng(s.setup.seed);
  s.battle = createBattle(getMapDefFor(s.setup), s.setup.roster, battleOptions(s));
  s.over = null;
  clearContexts(s);
  return drive(s);
}

export function resetSession(s: Session): void {
  s.app = "setup";
  s.setup = { mapName: null, roster: [], seed: s.setup.seed };
  s.battle = null;
  s.over = null;
  clearContexts(s);
}

export function setSeed(s: Session, n: number): void {
  if (!Number.isInteger(n)) throw new Error(i18n(s.locale, "err.seedInteger"));
  s.setup.seed = n >>> 0;
  s.rng = createRng(s.setup.seed);
}
