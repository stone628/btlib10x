import type { BattleState } from "btlib10x";
import { i18n } from "./i18n";
import type { Session } from "./session";

/** Most prompt snapshots kept per session; the oldest is dropped first. */
export const MAX_SNAPSHOT_COUNT = 10;

/** Everything `rollback` restores, deep-copied at an actor prompt. `setup` is
 *  never mutated during a battle, so it is not captured. */
type Snapshot = Pick<
  Session,
  "state" | "battle" | "move" | "attack" | "over" | "replay" | "doctrine"
> & {
  readonly rng: string;
};

const stacks = new WeakMap<Session, Snapshot[]>();

function stackOf(s: Session): Snapshot[] {
  let stack = stacks.get(s);
  if (stack === undefined) {
    stack = [];
    stacks.set(s, stack);
  }
  return stack;
}

/** Actor-prompt identity, derived from the battle alone: it changes exactly
 *  once per completed activation (or phase/turn change). */
function promptKey(battle: BattleState): string {
  return `${battle.turn}:${battle.phase}:${battle.actedThisPhase.length}`;
}

/** Forget all snapshots (new battle, or back to setup). */
export function clearSnapshots(s: Session): void {
  stacks.delete(s);
}

/**
 * Called after every command. Takes a snapshot when a new actor prompt has
 * begun, i.e. after `start` / `rematch` and after each `done` that finished
 * processing. Declarations (`mode`, `place`, `fire`, ...) and failed commands
 * leave the prompt key unchanged and so add nothing.
 */
export function recordPromptSnapshot(s: Session): void {
  if (s.state === "setup") {
    clearSnapshots(s);
    return;
  }
  if (s.state !== "battle" || s.battle === null) return;
  const stack = stackOf(s);
  const top = stack[stack.length - 1];
  if (
    top?.battle !== null &&
    top?.battle !== undefined &&
    promptKey(top.battle) === promptKey(s.battle)
  ) {
    return;
  }
  stack.push(
    structuredClone({
      state: s.state,
      battle: s.battle,
      move: s.move,
      attack: s.attack,
      over: s.over,
      replay: s.replay,
      doctrine: s.doctrine,
      rng: s.rng.snapshot(),
    }),
  );
  if (stack.length > MAX_SNAPSHOT_COUNT) stack.shift();
}

/** Undo the last completed `done`; from the game-over prompt, re-enter the last battle prompt. */
export function rollbackSession(s: Session): void {
  const stack = stackOf(s);
  // In battle the top snapshot is the current prompt's start: drop it and go
  // to the one before. At game over nothing was taken for the over state, so
  // the top already is the last battle prompt.
  const target = s.state === "over" ? stack[stack.length - 1] : stack[stack.length - 2];
  if (target === undefined) throw new Error(i18n("err.nothingToRollback"));
  if (s.state !== "over") stack.pop();
  const snap = structuredClone(target);
  s.state = snap.state;
  s.battle = snap.battle;
  s.move = snap.move;
  s.attack = snap.attack;
  s.over = snap.over;
  s.replay = snap.replay;
  // Assignments and the trace level are settings, not battle state: keep the live ones.
  s.doctrine = {
    ...snap.doctrine,
    assignments: s.doctrine.assignments,
    traceLevel: s.doctrine.traceLevel,
  };
  s.rng.load(snap.rng);
}
