import type {
  BattleState,
  Facing,
  GameEvent,
  HexCoord,
  Rng,
  TerrainType,
  UnitState,
} from "btlib10x";
import { gameLoop, isUnitRemoved } from "btlib10x";
import type { LocaleId } from "./i18n/index";
import { i18n, setI18nDefaultLocale } from "./i18n/index";
import { createRng } from "./rng";
import {
  type AttackContext,
  attackContextInvalid,
  initAttackContext,
  onEnterWeaponAttack,
  requireAttackActor,
} from "./session.attack";
import {
  initMovementContext,
  type MovementContext,
  movementContextInvalid,
  onEnterMovement,
  requireMovementActor,
} from "./session.move";
import type { OverContext, SessionVictoryResult } from "./session.over";
import type { SetupContext } from "./session.setup";

export * from "./session.attack";
/**
 * Public barrel for the session layer: everything below is implemented in
 * `session.common` / `session.move` / `session.over` / `session.setup` /
 * `session.weapon` and re-exported here, so callers outside `web/session.*`
 * import from this module only. The sub-modules deliberately import each
 * other (and this file) directly — going through the barrel would turn
 * already-existing intra-layer cycles into ones that reach module init.
 */
export * from "./session.common";
export * from "./session.move";
export * from "./session.over";
export * from "./session.setup";

export type SessionState = "setup" | "battle" | "over";

export interface Session {
  state: SessionState;
  rng: Rng;
  /** Always present: setup roster preserved across rematch. */
  setup: SetupContext;
  /** Eagerly populated by `drive()` on battle entry, nulled on phase exit. */
  move: MovementContext | null;
  /** Eagerly populated by `drive()` on attack-phase entry, nulled on exit. */
  attack: AttackContext | null;
  /** Populated when `drive()` detects victory, cleared on next battle. */
  over: OverContext | null;
  battle: BattleState | null;
}

export function newSession(seed: number): Session {
  return {
    state: "setup",
    rng: createRng(seed),
    setup: { mapName: null, seed: seed, roster: [] },
    move: null,
    attack: null,
    over: null,
    battle: null,
  };
}

export function promptHint(_s: Session): string {
  return "";
}

/** Prompt body without the trailing ">". */
export function promptBody(s: Session): string {
  switch (s.state) {
    case "setup":
      return i18n("prompt.setup");
    case "over": {
      const victory = s.over?.victory;
      const winner = victory?.draw
        ? i18n("prompt.draw")
        : i18n("prompt.winnerTeam", { team: victory?.winnerTeam ?? "?" });
      return i18n("prompt.over", {
        winner,
        turn: s.battle?.turn ?? "?",
      });
    }
    case "battle": {
      const st = requireBattle(s);
      let actor: UnitState | null = null;
      let phase = "?";

      switch (st.phase) {
        case "movement":
          actor = requireMovementActor(s);
          phase = i18n("prompt.subMove");
          break;
        case "attack":
          actor = requireAttackActor(s);
          phase = i18n("prompt.subAttack");
          break;
      }
      return i18n("prompt.turn", {
        turn: st.turn,
        phase,
        team: actor?.team ?? "?",
        id: actor?.id ?? "?",
      });
    }
  }
}

export function resetSession(s: Session): void {
  s.state = "setup";
  s.setup = { mapName: null, roster: [], seed: s.setup.seed };
  s.move = null;
  s.attack = null;
  s.over = null;
  s.battle = null;
}

export function requireBattle(s: Session): BattleState {
  if (!s.battle) throw new Error(i18n("err.noBattle"));
  return s.battle;
}

interface Config {
  locale: LocaleId;
}

const config: Config = {
  locale: "en",
};

export function configLocale() {
  return config.locale;
}

export function setConfigLocale(locale: LocaleId) {
  config.locale = locale;
  setI18nDefaultLocale(locale);
}

export function setSeed(s: Session, n: number): void {
  if (!Number.isInteger(n)) throw new Error(i18n("err.seedInteger"));
  s.setup.seed = n >>> 0;
  s.rng = createRng(s.setup.seed);
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
  app: SessionState;
  move: MovementContext | null;
  attack: AttackContext | null;
  over: OverContext | null;
}

function snapshotSessionCommit(s: Session): SessionCommitSnapshot {
  return {
    app: s.state,
    move: s.move === null ? null : structuredClone(s.move),
    attack: s.attack === null ? null : structuredClone(s.attack),
    over: s.over === null ? null : structuredClone(s.over),
  };
}

function restoreSessionCommit(s: Session, snap: SessionCommitSnapshot): void {
  s.state = snap.app;
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
export function commitAtomic(s: Session, fn: () => void): void {
  const battle = requireBattle(s);
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

export type SessionPhase = "weaponAttackResolution";

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
      readonly position: HexCoord;
      readonly facing: Facing;
      readonly prone: boolean;
      readonly terrain: TerrainType;
      readonly elevation: number;
      readonly modes: string;
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
    }
  | {
      readonly kind: "sessionOver";
    };

function checkSessionVictory(state: BattleState): SessionVictoryResult | null {
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

/** Drop both per-phase contexts. Used on actor change / phase boundary
 *  inside `drive()` and on lifecycle resets (start, rematch, reset). */
function clearBattleContexts(s: Session): void {
  s.move = null;
  s.attack = null;
}

function ensureBattleContextsCleared(s: Session): void {
  if (s.move !== null || s.attack !== null) {
    throw new Error("both context supposed to be cleared");
  }
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
export function drive(s: Session): SessionGameEvent[] {
  const battle = requireBattle(s);
  const v: SessionVictoryResult[] = [];
  const collected: GameEvent[] = [];
  const wasInWeaponAttack = battle.phase === "attack";
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
    s.state = "over";
    s.over = { victory };
    clearBattleContexts(s);
    return [...collected, { kind: "sessionOver" }];
  }
  s.state = "battle";
  const result: SessionGameEvent[] = [];
  const inMovement = battle.phase === "movement";
  const inWeaponAttack = battle.phase === "attack";
  if (wasInWeaponAttack && !inWeaponAttack) {
    result.push({ kind: "sessionPhase", phase: "weaponAttackResolution" });
    for (const e of collected) {
      if (e.kind === "phase" && e.prevPhase === "attack") {
        result.push({ kind: "sessionPhaseDone", phase: "weaponAttackResolution" });
      }
      result.push(e);
    }
  } else {
    result.push(...collected);
  }
  const id = r.actorId;
  if (id !== null) {
    if (inMovement && movementContextInvalid(s, id)) {
      ensureBattleContextsCleared(s);
      initMovementContext(s, id);
      onEnterMovement(s, result);
    }
    if (inWeaponAttack && attackContextInvalid(s, id)) {
      ensureBattleContextsCleared(s);
      initAttackContext(s, id);
      onEnterWeaponAttack(s, result);
    }
  }
  return result;
}
