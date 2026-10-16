import {
  canAttemptStandUp,
  destroyedLegs,
  effectiveMoveBudget,
  effectiveMovement,
  isImmobile,
  isNominal,
  isPilotUnconscious,
  isTsmActive,
  isUnitAvailable,
  isUnitImmobile,
  isUnitRemoved,
  mechDefFor,
  STAND_MP_COST,
  suggestFireTargets,
  type UnitState,
} from "btlib10x";
import { isGyroDestroyed } from "./misc";
import { decide, promptPersona } from "./persona";
import type { PersonaKey } from "./persona.data";
import type { Session, SessionState } from "./session";

/** Delay between generated commands, in milliseconds. */
export const AUTOPLAY_INTERVAL_MS = 100;

/** Persona that picks movement and attacks for units without a `pp` assignment. */
export const AUTOPLAY_PERSONA: PersonaKey = "alpha";

/**
 * Turn cap: a persona bout can go on forever without a failing command (two
 * units that cannot hurt each other), so the demo stops after this turn.
 */
export const AUTOPLAY_MAX_TURNS = 100;

/**
 * Roster the demo builds after 'reset' (mirrors freshSetup() in
 * tests/webcli.test.ts): adjacent foes facing each other along the n/s axis.
 */
const SCRIPT_SETUP: ReadonlyArray<{ id: string; command: string }> = [
  { id: "AT", command: "add AT AS7-D 3 4 ne" },
  { id: "MD", command: "add MD MC-MKII-2 5 3 sw" },
  { id: "ENF", command: "add ENF ENF-4R 4 5 ne" },
  { id: "WVR", command: "add WVR WVR-6R 6 4 sw" },
];

/** Queued commands to issue before falling back to state-based logic. */
let nextCommandQueue: string[] = [];
let currApp: SessionState | null = null;
/** Turn whose unit sheets were shown. Keyed on the turn rather than on a phase
 *  change seen here: `pp`-assigned prompts are played inside the previous
 *  `done`, so autoplay may never see a whole phase. */
let sheetsShownTurn: number | null = null;
/** Turn whose attack phase was opened with `status`. */
let attackStatusTurn: number | null = null;
/** Setup is tried once per autoplay run; a failed `start` ends the demo. */
let setupAttempted = false;
let helpShown: Record<string, boolean> = {};
let noWeapon: Record<string, boolean> = {};
/** Immobile-prone actors: first turn emits `mode pronestill`, the next turn
 *  shuts the 'Mech down so its pilot can abandon it after that. */
let pronestillThenExit: Record<string, boolean> = {};
/** Stuck actors shut down to leave play: their next movement prompt is
 *  `mode abandon` (the pilot steps out unhurt, the hull stays). */
let abandonNext: Record<string, boolean> = {};

function queueNextCommand(cmd: string): void {
  nextCommandQueue.push(cmd);
}

function returnFirstQueuedCommand(): string {
  return nextCommandQueue.shift()!;
}

/**
 * Reset all transient autoplay memory. Called on every autoplay start: reset
 * and rematch mutate the same session object, so identity cannot signal a new
 * game, and the heuristics are recomputed from live state anyway.
 */
export function resetAutoplayState(s: Session): void {
  nextCommandQueue = [];
  currApp = s.state;
  sheetsShownTurn = null;
  attackStatusTurn = null;
  setupAttempted = false;

  helpShown = {};
  noWeapon = {};
  pronestillThenExit = {};
  abandonNext = {};
}

/** Post-heat walk budget for the actor; 0 when heat/structure deny walking. */
function walkBudgetFor(actor: UnitState): number {
  const def = mechDefFor(actor);
  const movement = effectiveMovement(
    def,
    actor.damage,
    actor.critSlotsDestroyed,
    isTsmActive(def, actor.heat),
  );
  return effectiveMoveBudget("walk", movement, actor.heat);
}

function enusreHelpShown(key: string) {
  if (helpShown[key] === undefined) {
    helpShown[key] = true;
    queueNextCommand("help");
  }
}

export function flushAutoPlayCommand(): string[] {
  const flushing = nextCommandQueue;
  nextCommandQueue = [];
  return flushing;
}

/**
 * Queue the persona player's commands for the current prompt (movement or
 * attack), played as {@link AUTOPLAY_PERSONA}. The next persona context is
 * installed before the commands are typed, as `drivePersona` does, so the
 * rollback snapshot at the following prompt already holds it.
 */
function queuePersonaDecision(s: Session, fallback: readonly string[]): void {
  const decision = decide(s, AUTOPLAY_PERSONA, s.persona);
  if (decision === null) {
    for (const cmd of fallback) queueNextCommand(cmd);
    return;
  }
  s.persona = decision.next;
  for (const cmd of decision.commands) queueNextCommand(cmd);
}

/** True when no ranged weapon of the actor works against anyone (destroyed,
 *  jammed or out of ammo): the unit shuts down at its next movement phase
 *  and is abandoned the turn after. */
function hasNoFunctionalWeapon(s: Session, actorId: string): boolean {
  const st = s.battle;
  if (st === null) return false;
  let sugg: ReturnType<typeof suggestFireTargets>;
  try {
    sugg = suggestFireTargets(st, actorId);
  } catch {
    return false;
  }
  for (const t of sugg.targets) {
    if (t.weaponsIfPropLeft.length > 0 || t.weaponsIfPropRight.length > 0) return false;
    for (const b of t.blocked) {
      if (b.reason !== "destroyed" && b.reason !== "jammed" && b.reason !== "outOfAmmo") {
        return false;
      }
    }
  }
  return true;
}

/**
 * Next command a demonstrator would type for this session, derived purely
 * from session internals; null when there is nothing left to do (battle over,
 * or a state the script cannot drive). Feed each result through execute()
 * one AUTOPLAY_INTERVAL_MS at a time. Movement and attacks come from the
 * persona player (`web/persona.ts`); autoplay adds the narration (help,
 * board, sheets, status) and the posture and eject guards.
 */
export function nextAutoPlayCommand(s: Session): string | null {
  if (nextCommandQueue.length > 0) {
    return nextCommandQueue.shift()!;
  }
  const prevApp = currApp;
  currApp = s.state;

  if (currApp === "setup") {
    if (setupAttempted) return null;
    setupAttempted = true;
    enusreHelpShown(currApp);
    if (s.setup.mapName === null) queueNextCommand("map test");
    for (const u of SCRIPT_SETUP) {
      if (!s.setup.roster.some((r) => r.id === u.id)) {
        queueNextCommand(u.command);
      }
    }
    queueNextCommand("start");
    return returnFirstQueuedCommand();
  }

  if (currApp === "over") {
    enusreHelpShown(currApp);
    const st = s.battle;
    if (st !== null && prevApp === "battle") {
      queueNextCommand("status");
      queueNextCommand("board");
      for (const u of Object.values(st.units)) queueNextCommand(`sheet ${u.id}`);
      return returnFirstQueuedCommand();
    }
    return null;
  }

  if (currApp === "battle") {
    const st = s.battle;

    const actorId = s.move?.actorId ?? s.attack?.actorId ?? null;
    if (st === null || actorId === null) return null;
    if (st.turn > AUTOPLAY_MAX_TURNS) return null;

    const actor = st.units[actorId];
    if (actor === undefined || isUnitRemoved(actor)) return null;
    const enemy = Object.values(st.units).find(
      (u) => isUnitAvailable(u) && u.id !== actor.id && u.team !== actor.team,
    );
    if (enemy === undefined) return null;

    enusreHelpShown(`${currApp}${st.phase}`);
    if (prevApp === "setup") {
      queueNextCommand("board");
      return returnFirstQueuedCommand();
    }

    // Start of a turn: every unit's sheet, then the status board.
    if (sheetsShownTurn !== st.turn) {
      sheetsShownTurn = st.turn;
      for (const u of Object.values(st.units)) {
        if (isUnitAvailable(u)) queueNextCommand(`sheet ${u.id}`);
      }
      queueNextCommand("status");
      if (st.phase === "attack") attackStatusTurn = st.turn;
    }

    // A `pp`-assigned unit waiting at its prompt (after a rollback): let its
    // own persona play it.
    if (promptPersona(s) !== null) {
      queueNextCommand("pp go");
      return returnFirstQueuedCommand();
    }

    if (st.phase === "movement") {
      // movement mode not set yet
      if ((s.move?.moveMode ?? null) === null) {
        // A shut-down unit just passes: no movement mode, stay off-line.
        if (isNominal(actor)) {
          if (noWeapon[actor.id] === true) {
            // Nothing left to fight with: shut down now, abandon next turn.
            abandonNext[actor.id] = true;
            queueNextCommand("mode shutdown");
            queueNextCommand("done");
          } else if (actor.prone) {
            if (isImmobile(actor)) {
              // Leg destroyed + prone: stay still this turn, shut down next,
              // abandon after that.
              if (pronestillThenExit[actor.id] === true) {
                abandonNext[actor.id] = true;
                queueNextCommand("mode shutdown");
              } else {
                pronestillThenExit[actor.id] = true;
                queueNextCommand("mode pronestill");
              }
              queueNextCommand("done");
            } else if (!canAttemptStandUp(actor.damage) || isGyroDestroyed(actor)) {
              // Both legs gone (or one leg + both arms, or a destroyed gyro):
              // cannot stand, stay prone.
              queueNextCommand("mode pronestill");
              queueNextCommand("done");
            } else if (destroyedLegs(actor.damage) === 1 && walkBudgetFor(actor) >= 1) {
              // TW p.50: a one-leg 'Mech with 1 MP walk budget may still
              // stand; the stand costs the actual budget (≤ STAND_MP_COST).
              queueNextCommand("mode standup walk");
              queueNextCommand("done");
            } else if (walkBudgetFor(actor) < STAND_MP_COST) {
              // Heat or hip damage collapse walk MP below the 2-MP stand cost.
              queueNextCommand("mode pronestill");
              queueNextCommand("done");
            } else {
              queueNextCommand("mode standup walk");
              queueNextCommand("done");
            }
          } else if (isUnitImmobile(actor.damage) || walkBudgetFor(actor) === 0) {
            queueNextCommand("mode standstill");
            queueNextCommand("done");
          } else if (destroyedLegs(actor.damage) >= 1) {
            // One-leg standing 'Mech: walk 1 MP, jump allowed, no run.
            queueNextCommand("mode walk");
            queueNextCommand("done");
          } else {
            // The persona scores every reachable landing over every mode.
            queuePersonaDecision(s, ["mode standstill", "done"]);
          }

          return returnFirstQueuedCommand();
        }

        // A unit shut down to leave play: its pilot steps out now.
        if (abandonNext[actor.id] === true && !isPilotUnconscious(actor)) {
          queueNextCommand("mode abandon");
        }
        queueNextCommand("done");
        return returnFirstQueuedCommand();
      }
      // A mode left half-typed (a failed command): the persona cancels it
      // and plays the prompt again.
      queuePersonaDecision(s, ["done"]);
      return returnFirstQueuedCommand();
    }

    if (st.phase === "attack") {
      if (attackStatusTurn !== st.turn) {
        attackStatusTurn = st.turn;
        queueNextCommand("status");
      }
      // Nothing left to fire: leave play from the next movement phase.
      if (hasNoFunctionalWeapon(s, actor.id)) noWeapon[actor.id] = true;
      queuePersonaDecision(s, ["done"]);
      return returnFirstQueuedCommand();
    }

    return null;
  }

  return null;
}
