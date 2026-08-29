import { canFireFromLocation, isImmobile } from "btlib10x";
import type * as S from "./session.js";

/** Delay between generated commands, in milliseconds. */
export const AUTOPLAY_INTERVAL_MS = 200;

/**
 * Roster the demo builds after 'reset' (mirrors freshSetup() in
 * tests/webcli.test.ts): adjacent foes facing each other along the n/s axis.
 */
const SCRIPT_SETUP: ReadonlyArray<{ id: string; command: string }> = [
  { id: "AT", command: "add AT AS7-D 0 4 3 4 ne" },
  { id: "MD", command: "add MD MC-MKII-2 1 4 5 3 sw" },
];

/** Queued commands to issue before falling back to state-based logic. */
let nextCommandQueue: string[] = [];
let currApp: string | null = null;
let currBattlePhase: string | null = null;

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
  const st = s.battle;
  if (currApp !== "battle" || st === null) {
    currBattlePhase = null;
  } else {
    currBattlePhase = st.phase;
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
    if (s.mapName === null) queueNextCommand("map test");
    for (const u of SCRIPT_SETUP) {
      if (!s.roster.some((r) => r.id === u.id)) {
        queueNextCommand(u.command);
      }
    }
    queueNextCommand("start");
    return returnFirstQueuedCommand();
  }

  if (currApp === "over") {
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
    const enemy = Object.values(st.units).find((u) => !u.removed && u.id !== actor.id);
    if (enemy === undefined) return null;

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
      if (actor.moveMode === null) {
        queueNextCommand(isImmobile(actor.damage) ? "mode standstill" : "mode walk");
      }
      queueNextCommand("done");
      return returnFirstQueuedCommand();
    }

    if (st.phase === "weaponAttack") {
      const def = st.defs[actor.model];
      if (def === undefined) return null;
      const declared = new Set(s.fireDecls.map((d) => d.weaponIndex));
      for (let w = 0; w < def.weapons.length; w++) {
        if (declared.has(w)) continue;
        const mount = def.weapons[w]!;
        if (actor.jammedWeapons.includes(w)) continue;
        if (!canFireFromLocation(actor.phaseStartDamage, mount.location)) continue;
        if (actor.ammoLeft[w] !== undefined && (actor.ammoLeft[w] ?? 0) < 1) continue;
        queueNextCommand(`fire ${w + 1} ${enemy.id}`);
      }
      queueNextCommand("done");
      return returnFirstQueuedCommand();
    }

    return null;
  }

  return null;
}
