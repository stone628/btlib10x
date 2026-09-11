import {
  bearingExact,
  bestFireTarget,
  classifyArcWithBoundary,
  getMechDefFor,
  isNominal,
  isUnitImmobile,
  suggestFireTargets,
  weaponCanFireIntoArc,
} from "btlib10x";
import type { FireTarget } from "../src/index.js";
import type * as S from "./session.js";

/** Delay between generated commands, in milliseconds. */
export const AUTOPLAY_INTERVAL_MS = 100;

/**
 * Roster the demo builds after 'reset' (mirrors freshSetup() in
 * tests/webcli.test.ts): adjacent foes facing each other along the n/s axis.
 */
const SCRIPT_SETUP: ReadonlyArray<{ id: string; command: string }> = [
  { id: "AT", command: "add AT AS7-D 0 3 3 4 ne" },
  { id: "MD", command: "add MD MC-MKII-2 1 3 5 3 sw" },
  { id: "ENF", command: "add ENF ENF-4R 0 2 4 5 ne" },
  { id: "WVR", command: "add WVR WVR-6R 1 2 6 4 sw" },
];

/** Queued commands to issue before falling back to state-based logic. */
let currSession: S.Session | null = null;
let nextCommandQueue: string[] = [];
let currApp: S.AppState | null = null;
let currBattlePhase: string | null = null;
let helpShown: Record<string, boolean> = {};
let noWeapon: Record<string, boolean> = {};
let unitForwarded: Record<string, boolean> = {};
/** Actor id → enemy id whose out-of-arc weapons need facing next movement. */
let faceEnemy: Record<string, string> = {};

function queueNextCommand(cmd: string): void {
  nextCommandQueue.push(cmd);
}

function returnFirstQueuedCommand(): string {
  return nextCommandQueue.shift()!;
}

/** Reset transient autoplay memory; called when the user re-enters setup. */
export function resetAutoplayState(s: S.Session): void {
  if (currSession !== s) {
    currSession = s;
    nextCommandQueue = [];
    currApp = s.app;
    currBattlePhase = null;

    helpShown = {};
    noWeapon = {};
    unitForwarded = {};
    faceEnemy = {};
  } else {
    if (currApp !== s.app) {
      currApp = s.app;
      currBattlePhase = null;
    }
  }
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

/** Pick the best 1-step landing (F toward enemy, B away) and queue a place command. */
function queueStepToward(s: S.Session, fragment: "F" | "B"): void {
  const candidate = s.moveCandidate;
  if (candidate === null) return;
  const oneStep = candidate.revealed.filter((l) => l.path.length === 1 && l.path[0] === fragment);
  if (oneStep.length === 0) return;
  const pick = oneStep.shift()!;
  queueNextCommand(`place ${pick.hex.col} ${pick.hex.row} ${pick.facing}`);
}

/**
 * Queue a `place` landing that turns the actor toward `targetId`, so weapons
 * currently blocked as out-of-arc can bear next turn. Scores every reachable
 * landing by how many of the actor's out-of-arc weapons would fire into the
 * landing's arc toward the target; prefers pure turns, then shortest path.
 * Returns true when a facing landing was queued.
 */
function queueFaceTarget(s: S.Session, actorId: string, targetId: string): boolean {
  const st = s.battle;
  const candidate = s.moveCandidate;
  if (st === null || candidate === null) return false;
  const actor = st.units[actorId];
  const target = st.units[targetId];
  if (actor === undefined || target === undefined || target.removed || target.destroyed) {
    return false;
  }
  let blocked: number[];
  try {
    const sugg = suggestFireTargets(st, actorId);
    blocked = (sugg.targets.find((t) => t.targetId === targetId)?.blocked ?? [])
      .filter((b) => b.reason === "outOfArc")
      .map((b) => b.weaponIndex);
  } catch {
    return false;
  }
  if (blocked.length === 0) return false;
  const def = getMechDefFor(actor);
  let best: { col: number; row: number; facing: string; score: number; pathLen: number } | null =
    null;
  for (const landing of candidate.revealed) {
    const b = bearingExact(landing.hex, target.position);
    if (b === null) continue;
    const cls = classifyArcWithBoundary(landing.facing, b);
    let score = 0;
    for (const weaponIndex of blocked) {
      const mount = def.weapons[weaponIndex];
      if (mount === undefined) continue;
      const rearFacing = mount.rearFacing === true;
      if (
        weaponCanFireIntoArc(mount.location, rearFacing, cls.arc) ||
        (cls.altArc !== null && weaponCanFireIntoArc(mount.location, rearFacing, cls.altArc))
      )
        score++;
    }
    if (score === 0) continue;
    const sameHex =
      landing.hex.col === actor.position.col && landing.hex.row === actor.position.row;
    if (
      best === null ||
      score > best.score ||
      (score === best.score &&
        (sameHex ||
          (!(best.col === actor.position.col && best.row === actor.position.row) &&
            landing.path.length < best.pathLen)))
    ) {
      best = {
        col: landing.hex.col,
        row: landing.hex.row,
        facing: landing.facing,
        score,
        pathLen: landing.path.length,
      };
    }
  }
  if (best === null) return false;
  queueNextCommand(`place ${best.col} ${best.row} ${best.facing}`);
  return true;
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
        queueNextCommand("status");
      }
      // movement mode not set yet
      if (actor.moveMode === null) {
        // A shut-down unit just passes: no movement mode, stay off-line.
        if (isNominal(actor)) {
          if (noWeapon[actor.id] === true) {
            queueNextCommand("mode eject");
            queueNextCommand("done");
          } else if (isUnitImmobile(actor.damage)) {
            queueNextCommand("mode standstill");
            queueNextCommand("done");
          } else {
            // s.moveCandidate wil be available only after "mode walk" command is processed.
            queueNextCommand("mode walk");
          }

          return returnFirstQueuedCommand();
        }

        queueNextCommand("done");
        return returnFirstQueuedCommand();
      }
      // A pending out-of-arc facing request beats the forward/backward pace:
      // turn toward the recorded enemy so blocked weapons can bear next turn.
      const faceTarget = faceEnemy[actor.id];
      if (faceTarget !== undefined) {
        delete faceEnemy[actor.id];
        if (queueFaceTarget(s, actor.id, faceTarget)) {
          queueNextCommand("done");
          return returnFirstQueuedCommand();
        }
      }
      // assume movement mode walk
      if (unitForwarded[actor.id] === true) {
        // one step backward
        queueStepToward(s, "B");
        unitForwarded[actor.id] = false;
      } else {
        // one step forward
        queueStepToward(s, "F");
        unitForwarded[actor.id] = true;
      }
      queueNextCommand("done");
      return returnFirstQueuedCommand();
    }

    if (st.phase === "weaponAttack") {
      if (lastBattlePhase !== "weaponAttack") {
        queueNextCommand("status");
      }
      const sugg = suggestFireTargets(st, actor.id);
      const declared = new Set(s.fireDecls.map((d) => d.weaponIndex));
      // Targets arrive best-first: first with an undeclared fireable weapon.
      const target =
        sugg.targets.find((t) => t.weapons.some((w) => !declared.has(w.weaponIndex))) ??
        bestFireTarget(sugg);
      const available = (target?.weapons ?? [])
        .filter((w) => !declared.has(w.weaponIndex))
        .map((w) => String(w.weaponIndex));
      if (target !== null && available.length > 0) {
        queueNextCommand(`fire ${target.targetId} ${available.join(" ")}`);
      } else {
        // count functional weapons
        let funcWeaponCount = 0;
        const outOfArcTargets: FireTarget[] = [];
        let foundNoLos = false;
        for (const t of sugg.targets) {
          let foundOutOfArc = false;
          for (const b of t.blocked) {
            if (b.reason === "destroyed" || b.reason === "jammed" || b.reason === "outOfAmmo") {
              continue;
            }
            if (b.reason === "outOfArc") foundOutOfArc = true;
            if (b.reason === "noLos") foundNoLos = true;
            funcWeaponCount++;
          }
          if (foundOutOfArc) outOfArcTargets.push(t);
        }
        if (funcWeaponCount === 0) {
          noWeapon[actor.id] = true;
        } else {
          // Remember an enemy holding out-of-arc weapons so the next
          // movement phase turns the actor toward it. Prefer best target
          // (targets sorted best-first) so facing fixes most firepower.
          if (outOfArcTargets.length > 0) {
            const outOfArcTarget =
              (target !== null
                ? outOfArcTargets.find((t) => t.targetId === target.targetId)
                : undefined) ?? outOfArcTargets[0]!;
            faceEnemy[actor.id] = outOfArcTarget.targetId;
          } else if (foundNoLos) {
            // make you go forward on next movement phase
            unitForwarded[actor.id] = false;
          }
        }
      }
      queueNextCommand("done");
      return returnFirstQueuedCommand();
    }

    return null;
  }

  return null;
}
