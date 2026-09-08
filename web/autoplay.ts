import { isNominal, isUnitImmobile, suggestFireTargets } from "btlib10x";
import type * as S from "./session.js";

/** Delay between generated commands, in milliseconds. */
export const AUTOPLAY_INTERVAL_MS = 100;

/**
 * Roster the demo builds after 'reset' (mirrors freshSetup() in
 * tests/webcli.test.ts): adjacent foes facing each other along the n/s axis.
 */
const SCRIPT_SETUP: ReadonlyArray<{ id: string; command: string }> = [
  { id: "AT", command: "add AT AS7-D 0 4 3 4 ne" },
  { id: "MD", command: "add MD MC-MKII-2 1 4 5 3 sw" },
  { id: "ENF", command: "add ENF ENF-4R 0 3 5 5 n" },
  { id: "WVR", command: "add WVR WVR-6R 1 3 6 4 s" },
];

/** Queued commands to issue before falling back to state-based logic. */
let nextCommandQueue: string[] = [];
let currApp: S.AppState | null = null;
let currBattlePhase: string | null = null;
let helpShown: Record<string, boolean> = {};

// /** Push the rest onto the queue, return the first command. */
// function queueAndReturn(first: string, ...rest: string[]): string {
//   if (rest.length > 0) nextCommandQueue.push(...rest);
//   lastReturned = first;
//   return first;
// }

function queueNextCommand(cmd: string): void {
  nextCommandQueue.push(cmd);
}

function returnFirstQueuedCommand(): string {
  return nextCommandQueue.shift()!;
}

/** Reset transient autoplay memory; called when the user re-enters setup. */
export function resetAutoplayState(s: S.Session): void {
  nextCommandQueue = [];
  currApp = s.app;
  currBattlePhase = null;
  helpShown = {};
}

function enusreHelpShown(key: string) {
  if (helpShown[key] === undefined) {
    helpShown[key] = true;
    queueNextCommand("help");
  }
}

/**
 * Next command a demonstrator would type for this session, derived purely
 * from session internals; null when there is nothing left to do (battle over,
 * or a state the script cannot drive). Feed each result through execute()
 * one AUTOPLAY_INTERVAL_MS at a time.
 */
export function nextAutoPlayCommand(s: S.Session): string | null {
  if (nextCommandQueue.length > 0) {
    return nextCommandQueue.shift()!;
  }
  const prevApp = currApp;
  currApp = s.app;

  if (currApp === "setup") {
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

    if (st === null || s.actorId === null) return null;

    const actor = st.units[s.actorId];
    if (actor === undefined || actor.removed) return null;
    const enemy = Object.values(st.units).find(
      (u) => !u.removed && u.id !== actor.id && u.team !== actor.team,
    );
    if (enemy === undefined) return null;

    enusreHelpShown(`${currApp}${st.phase}`);
    if (prevApp === "setup") {
      queueNextCommand("board");
      return returnFirstQueuedCommand();
    }

    const lastBattlePhase = currBattlePhase;
    currBattlePhase = st.phase;

    if (currBattlePhase === "movement") {
      if (lastBattlePhase !== "movement") {
        for (const u of Object.values(st.units)) {
          if (!u.removed) queueNextCommand(`sheet ${u.id}`);
        }
      }
      // A shut-down unit just passes: no movement mode, stay off-line.
      if (actor.moveMode === null && isNominal(actor)) {
        queueNextCommand(isUnitImmobile(actor.damage) ? "mode standstill" : "mode walk");
      }
      queueNextCommand("done");
      return returnFirstQueuedCommand();
    }

    if (st.phase === "weaponAttack") {
      const sugg = suggestFireTargets(st, actor.id);
      const target = sugg.targets.find((t) => t.targetId === enemy.id);
      const available = (target?.weapons ?? [])
        .filter((w) => !s.fireDecls.some((d) => d.weaponIndex === w.weaponIndex))
        .map((w) => String(w.weaponIndex));
      if (available.length > 0) {
        queueNextCommand(`fire ${enemy.id} ${available.join(" ")}`);
      }
      queueNextCommand("done");
      return returnFirstQueuedCommand();
    }

    return null;
  }

  return null;
}
