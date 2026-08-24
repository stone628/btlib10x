import type { Facing, Hex, MoveMode, Rng, TerrainHexDef } from "../src/core/types.js";
import { FACINGS, rotateFacing } from "../src/core/types.js";
import { neighbor, sameHex } from "../src/core/hex.js";
import { costToEnter } from "../src/core/terrain.js";
import { MAP_DEFS, MECH_DEFS, getMapDef, toEngineTerrain } from "../src/data/index.js";
import type { AttackDecl, BattleState, CreateBattleOptions, MoveStep, UnitInit, UnitState, VictoryResult } from "../src/rules/game.js";
import {
  advancePhase,
  checkVictory,
  createBattle,
  declareAttacks,
  declareMove,
  executeMove,
  getUnit,
  nextActor,
  resolveDeclaredAttacks,
  rollInitiativePhase,
} from "../src/rules/game.js";
import * as mv from "../src/rules/movement.js";
import { createRng } from "./rng.js";
import { t } from "./i18n/index.js";
import type { LocaleId } from "./i18n/index.js";

export type AppState = "setup" | "battle" | "over";

export interface SetupUnit {
  readonly id: string;
  readonly model: string;
  readonly team: number;
  readonly gunnery: number;
  /** Engine coordinates (0-based). */
  readonly position: Hex;
  readonly facing: Facing;
}

export interface Session {
  app: AppState;
  /** Output language (UI preference; preserved across reset/rematch). */
  locale: LocaleId;
  seed: number;
  rng: Rng;
  mapName: string | null;
  terrainDefs: TerrainHexDef[];
  roster: SetupUnit[];
  battle: BattleState | null;
  victory: VictoryResult | null;
  actorId: string | null;
  moveMode: MoveMode | null;
  moveSteps: MoveStep[];
  fireDecls: AttackDecl[];
}

export function newSession(seed = 42): Session {
  return {
    app: "setup",
    locale: "en",
    seed,
    rng: createRng(seed),
    mapName: null,
    terrainDefs: [],
    roster: [],
    battle: null,
    victory: null,
    actorId: null,
    moveMode: null,
    moveSteps: [],
    fireDecls: [],
  };
}

function clearBuffers(s: Session): void {
  s.moveMode = null;
  s.moveSteps = [];
  s.fireDecls = [];
}

/** Advance the battle through transient phases until an actor must act or the game ends. */
function drive(s: Session): void {
  if (!s.battle) return;
  let st: BattleState = s.battle;
  for (let i = 0; i < 200; i++) {
    const v = checkVictory(st);
    if (v.winnerTeam !== null || v.draw) {
      s.battle = st;
      s.app = "over";
      s.victory = v;
      s.actorId = null;
      clearBuffers(s);
      return;
    }
    if (st.phase === "initiative") {
      st = rollInitiativePhase(st, s.rng);
      continue;
    }
    if (st.phase === "end") {
      st = advancePhase(st);
      continue;
    }
    const id = nextActor(st);
    if (id !== null) {
      s.battle = st;
      s.app = "battle";
      if (s.actorId !== id) {
        s.actorId = id;
        clearBuffers(s);
      }
      return;
    }
    st = advancePhase(st);
  }
  throw new Error(t(s.locale, "err.phaseDriver"));
}

export function currentActor(s: Session): UnitState | null {
  if (s.app !== "battle" || !s.battle || s.actorId === null) return null;
  return getUnit(s.battle, s.actorId);
}

/** Prompt body without the trailing ">". */
export function promptBody(s: Session): string {
  switch (s.app) {
    case "setup":
      return "setup";
    case "over":
      return "over";
    case "battle": {
      const st = s.battle!;
      const sub = st.phase === "movement" ? "move" : "attack";
      const actor = currentActor(s);
      return `turn(${st.turn}):${sub}(team ${actor?.team ?? "?"}, mech ${actor?.id ?? "?"})`;
    }
  }
}

// ---------------------------------------------------------------- setup ----

export function listMapNames(): string[] {
  return Object.keys(MAP_DEFS);
}

export function setMap(s: Session, name: string): void {
  const map = MAP_DEFS[name];
  if (!map) throw new Error(t(s.locale, "err.unknownMap", { name, list: listMapNames().join(", ") }));
  s.mapName = name;
  s.terrainDefs = toEngineTerrain(map);
}

export function addUnit(
  s: Session,
  id: string,
  model: string,
  team: number,
  gunnery: number,
  position: Hex,
  facing: Facing,
): void {
  if (!MECH_DEFS[model]) throw new Error(t(s.locale, "err.unknownModel", { model }));
  if (s.roster.some((u) => u.id === id)) throw new Error(t(s.locale, "err.duplicateId", { id }));
  if (!Number.isInteger(team) || team < 0) throw new Error(t(s.locale, "err.badTeam"));
  if (!Number.isInteger(gunnery) || gunnery < 0 || gunnery > 7) {
    throw new Error(t(s.locale, "err.badGunnery"));
  }
  if (s.roster.some((u) => sameHex(u.position, position))) {
    // Display coordinates are 1-based; the session stores engine (0-based) hexes.
    throw new Error(t(s.locale, "err.hexOccupied", { col: position.col + 1, row: position.row + 1 }));
  }
  s.roster = [...s.roster, { id, model, team, gunnery, position, facing }];
}

export function removeUnit(s: Session, id: string): void {
  if (!s.roster.some((u) => u.id === id)) throw new Error(t(s.locale, "err.noSuchUnit", { id }));
  s.roster = s.roster.filter((u) => u.id !== id);
}

/** Shared createBattle options: setup terrain plus the loaded map's size. */
function battleOptions(s: Session): CreateBattleOptions {
  const map = s.mapName ? getMapDef(s.mapName) : undefined;
  return {
    terrain: s.terrainDefs,
    ...(map !== undefined ? { width: map.width, height: map.height } : {}),
  };
}

export function startBattle(s: Session): void {
  if (s.app !== "setup") throw new Error(t(s.locale, "err.alreadyStarted"));
  if (s.roster.length < 2) throw new Error(t(s.locale, "err.needTwoUnits"));
  const teams = new Set(s.roster.map((u) => u.team));
  if (teams.size < 2) throw new Error(t(s.locale, "err.needTwoTeams"));
  const inits: UnitInit[] = s.roster.map((u) => ({ ...u }));
  s.battle = createBattle(inits, battleOptions(s));
  s.victory = null;
  s.actorId = null;
  clearBuffers(s);
  drive(s);
}

// ------------------------------------------------------------- movement ----

const MOVE_MODES: Readonly<Record<string, MoveMode>> = {
  standstill: "standStill",
  walk: "walk",
  run: "run",
  jump: "jump",
};

export function parseMoveMode(locale: LocaleId, word: string): MoveMode {
  const mode = MOVE_MODES[word.toLowerCase()];
  if (!mode) throw new Error(t(locale, "err.badModeWord"));
  return mode;
}

function requireBattle(s: Session): BattleState {
  if (!s.battle) throw new Error(t(s.locale, "err.noBattle"));
  return s.battle;
}

function requireActor(s: Session, phase: "movement" | "weaponAttack"): UnitState {
  const unit = currentActor(s);
  if (!unit || !s.battle || s.battle.phase !== phase) {
    throw new Error(t(s.locale, "err.wrongPhase", { phase }));
  }
  return unit;
}

export function declareMode(s: Session, word: string): void {
  const unit = requireActor(s, "movement");
  const mode = parseMoveMode(s.locale, word);
  s.battle = declareMove(requireBattle(s), unit.id, mode);
  s.moveMode = mode;
  s.moveSteps = [];
}

interface MoveCursor {
  hex: Hex;
  facing: Facing;
  spent: number;
}

function replaySteps(s: Session): MoveCursor {
  const unit = currentActor(s)!;
  const cur: MoveCursor = { hex: { ...unit.position }, facing: unit.facing, spent: 0 };
  for (const step of s.moveSteps) {
    if (step.kind === "turn") {
      cur.facing = rotateFacing(cur.facing, step.facings);
      cur.spent += mv.facingChangeCost(Math.abs(step.facings));
    } else {
      cur.hex = { ...step.to };
      cur.spent += s.moveMode === "jump" ? 1 : costToEnter(mv.terrainAt(requireBattle(s).terrain, step.to));
    }
  }
  return cur;
}

function budgetFor(s: Session): number {
  const unit = currentActor(s)!;
  const def = requireBattle(s).defs[unit.model]!;
  return mv.maxMovePoints(s.moveMode ?? "standStill", def.walking, def.running, def.jumping);
}

function isAdjacent(to: Hex, hex: Hex): boolean {
  return FACINGS.some((f) => sameHex(neighbor(hex, f), to));
}

export function queueEnter(s: Session, to: Hex): void {
  const unit = requireActor(s, "movement");
  if (!s.moveMode) throw new Error(t(s.locale, "err.declareModeFirst", { id: unit.id }));
  if (sameHex(unit.position, to)) throw new Error(t(s.locale, "err.sameHexMove"));
  const cur = replaySteps(s);
  if (sameHex(cur.hex, to)) throw new Error(t(s.locale, "err.alreadyThere"));
  if (s.moveMode === "standStill") throw new Error(t(s.locale, "err.standStillNoEnter"));
  let cost: number;
  if (s.moveMode === "jump") {
    if (!isAdjacent(to, cur.hex)) throw new Error(t(s.locale, "err.jumpNotAdjacent"));
    cost = 1;
  } else {
    const forward = mv.isForwardStep(cur.hex, to, cur.facing);
    const backward = !forward && mv.isBackwardStep(cur.hex, to, cur.facing);
    if (!forward && !backward) {
      throw new Error(t(s.locale, "err.groundStraightOnly"));
    }
    cost = costToEnter(mv.terrainAt(requireBattle(s).terrain, to));
  }
  const spent = cur.spent + cost;
  const budget = budgetFor(s);
  if (spent > budget) {
    throw new Error(t(s.locale, "err.mpExceeded", { spent, mode: s.moveMode, budget }));
  }
  s.moveSteps = [...s.moveSteps, { kind: "enter", to }];
}

export function queueTurn(s: Session, facings: number): void {
  const unit = requireActor(s, "movement");
  if (!s.moveMode) throw new Error(t(s.locale, "err.declareModeFirst", { id: unit.id }));
  if (s.moveMode === "standStill") throw new Error(t(s.locale, "err.standStillNoFace"));
  if (s.moveMode === "jump") throw new Error(t(s.locale, "err.jumpFreeFacing"));
  if (!Number.isInteger(facings) || facings === 0 || Math.abs(facings) > 5) {
    throw new Error(t(s.locale, "err.badFacings"));
  }
  const cur = replaySteps(s);
  const spent = cur.spent + mv.facingChangeCost(Math.abs(facings));
  const budget = budgetFor(s);
  if (spent > budget) {
    throw new Error(t(s.locale, "err.mpExceeded", { spent, mode: s.moveMode, budget }));
  }
  s.moveSteps = [...s.moveSteps, { kind: "turn", facings }];
}

/** Resolve a `face` argument: absolute facing name or signed step count. */
export function faceSteps(locale: LocaleId, current: Facing, arg: string): number {
  if (/^[+-]?\d+$/.test(arg)) {
    const n = Number(arg);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 5) {
      throw new Error(t(locale, "err.badFacings"));
    }
    return n;
  }
  const target = FACINGS.find((f) => f === arg.toLowerCase());
  if (!target) throw new Error(t(locale, "err.faceArg", { facings: FACINGS.join("/") }));
  const delta0 = FACINGS.indexOf(target) - FACINGS.indexOf(current);
  let delta = delta0 > 3 ? delta0 - 6 : delta0 < -3 ? delta0 + 6 : delta0;
  if (delta === 0) throw new Error(t(locale, "err.faceCurrent", { facing: current }));
  return delta;
}

export function cancelMove(s: Session): void {
  requireActor(s, "movement");
  s.moveMode = null;
  s.moveSteps = [];
}

export interface CommitResult {
  state: BattleState;
  newEvents: BattleState["events"];
}

export function commitMove(s: Session): CommitResult {
  const unit = requireActor(s, "movement");
  const before = requireBattle(s);
  const next = executeMove(before, unit.id, s.moveSteps);
  const newEvents = next.events.slice(before.events.length);
  s.battle = next;
  s.actorId = null;
  clearBuffers(s);
  drive(s);
  return { state: next, newEvents };
}

export interface MoveStepInfo {
  readonly label: string;
  readonly mpCost: number;
  readonly mpAfter: number;
}

/** Queued movement steps with running MP totals, for `status`. */
export function moveStepsInfo(s: Session): { mode: MoveMode | null; steps: MoveStepInfo[]; budget: number } {
  const unit = currentActor(s);
  if (!unit || !s.battle) throw new Error(t(s.locale, "err.needsActor"));
  const terrain = s.battle.terrain;
  const steps: MoveStepInfo[] = [];
  let hex: Hex = { ...unit.position };
  let facing: Facing = unit.facing;
  let spent = 0;
  s.moveSteps.forEach((step, i) => {
    let label: string;
    let cost: number;
    if (step.kind === "turn") {
      const nextFacing = rotateFacing(facing, step.facings);
      label = t(s.locale, "moveStatus.stepTurn", {
        i: i + 1,
        steps: signed(step.facings),
        from: facing,
        to: nextFacing,
      });
      facing = nextFacing;
      cost = mv.facingChangeCost(Math.abs(step.facings));
    } else {
      label = t(s.locale, "moveStatus.stepEnter", {
        i: i + 1,
        col: step.to.col + 1,
        row: step.to.row + 1,
      });
      hex = { ...step.to };
      cost = s.moveMode === "jump" ? 1 : costToEnter(mv.terrainAt(terrain, step.to));
    }
    spent += cost;
    steps.push({ label, mpCost: cost, mpAfter: spent });
  });
  return { mode: s.moveMode, steps, budget: budgetFor(s) };
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

// -------------------------------------------------------------- attacks ----

export function cancelFire(s: Session): void {
  requireActor(s, "weaponAttack");
  s.fireDecls = [];
}

export function queueFire(s: Session, decl: AttackDecl): void {
  const unit = requireActor(s, "weaponAttack");
  if (decl.targetId === unit.id) throw new Error(t(s.locale, "err.selfTarget"));
  const target = requireBattle(s).units[decl.targetId];
  if (!target) throw new Error(t(s.locale, "err.unknownUnitId", { id: decl.targetId }));
  if (target.team === unit.team) throw new Error(t(s.locale, "err.selfTarget"));
  if (target.removed) throw new Error(t(s.locale, "err.targetRemoved", { id: target.id }));
  const pending = s.fireDecls[0]?.targetId;
  if (pending !== undefined && pending !== decl.targetId) {
    throw new Error(t(s.locale, "err.oneTarget", { target: pending }));
  }
  s.fireDecls = [...s.fireDecls, decl];
}

export function commitFire(s: Session): CommitResult {
  const unit = requireActor(s, "weaponAttack");
  const before = requireBattle(s);
  const declared = declareAttacks(before, unit.id, s.fireDecls);
  const resolved = resolveDeclaredAttacks(declared, unit.id, s.rng);
  const newEvents = resolved.events.slice(before.events.length);
  s.battle = resolved;
  s.actorId = null;
  clearBuffers(s);
  drive(s);
  return { state: resolved, newEvents };
}

// ------------------------------------------------------------ lifecycle ----

export function rematch(s: Session): void {
  if (s.app !== "over") throw new Error(t(s.locale, "err.rematchOnlyOver"));
  s.rng = createRng(s.seed);
  s.battle = createBattle(
    s.roster.map((u) => ({ ...u })),
    battleOptions(s),
  );
  s.victory = null;
  s.actorId = null;
  clearBuffers(s);
  drive(s);
}

export function resetSession(s: Session): void {
  s.app = "setup";
  s.mapName = null;
  s.terrainDefs = [];
  s.roster = [];
  s.battle = null;
  s.victory = null;
  s.actorId = null;
  clearBuffers(s);
}

export function setSeed(s: Session, n: number): void {
  if (!Number.isInteger(n)) throw new Error(t(s.locale, "err.seedInteger"));
  s.seed = n >>> 0;
  s.rng = createRng(s.seed);
}
