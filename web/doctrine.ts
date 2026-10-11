/**
 * Doctrine player (GDD §9): a one-ply scoring player that types CLI commands
 * for units assigned a MechWarrior doctrine at setup.
 *
 * - Assignment lives here, never in `UnitInit` or the engine.
 * - Its context is plain serializable data on `Session.doctrine`: the
 *   assignments, its own RNG stream (seeded apart from the battle dice, used
 *   only to break ties, so deciding never moves `s.rng`), long-term
 *   {@link StrategyMemory} per unit, and the last {@link DecisionTrace} per unit.
 * - `decide()` is pure: it returns the commands, the trace and the next
 *   context. The driver (`web/doctrine.cli.ts`) installs the next context
 *   before typing the commands, so the prompt snapshots `rollback` takes
 *   already hold it.
 *
 * Yield (GDD §9.2 "yields at") ejects as a stand-in until the engine has a
 * yield helper (GDD R6). Crippling damage (TW p. 258) and a morale check
 * (TO:AR p. 180) are the rules a later version can gate it on.
 */
import {
  type BattleState,
  canAttemptStandUp,
  destroyedLegs,
  effectiveMoveBudget,
  effectiveMovement,
  hexDistance,
  isImmobile,
  isNominal,
  isTsmActive,
  isUnitAvailable,
  isUnitImmobile,
  mechDefFor,
  STAND_MP_COST,
  type UnitState,
} from "btlib10x";
import { scoreAttacks } from "./doctrine.attack";
import {
  type DecisionTrace,
  enemiesOf,
  expectedDamageAt,
  heatCeilingFor,
  type Posture,
  rangeProfile,
  remainingFraction,
  type TraceCandidate,
  type TraceNote,
  usableWeapons,
} from "./doctrine.common";
import { DOCTRINES, type Doctrine, type DoctrineKey } from "./doctrine.data";
import { scoreMoves } from "./doctrine.move";
import { isGyroDestroyed } from "./misc";
import { createRng } from "./rng";
import type { Session } from "./session";

export type TraceLevel = "off" | "brief" | "full";

/** Long-term strategy kept per unit across turns. */
export interface StrategyMemory {
  /** Committed target (one target per turn); kept until a clearly better one appears. */
  targetId: string | null;
  /** Turns the current target has been held. */
  targetHeld: number;
  /** Turn number of the last activation (to count turns, not activations). */
  lastTurn: number;
  posture: Posture;
  /** Consecutive turns with an enemy inside weapon range. */
  turnsInContact: number;
  /** Armor + structure left at the start of the previous turn, and the loss since. */
  remainingAtLastTurn: number;
  lossLastTurn: number;
  /** Enemy move modes seen, per enemy id: groundwork for the §9.4 learning tag. */
  enemyModes: Record<string, Record<string, number>>;
}

export interface DoctrineContext {
  /** Unit id → doctrine. Set in setup; kept across rematch. */
  assignments: Record<string, DoctrineKey>;
  /** Snapshot of the doctrine player's own RNG stream. */
  rng: string;
  memory: Record<string, StrategyMemory>;
  lastTrace: Record<string, DecisionTrace>;
  traceLevel: TraceLevel;
}

/** Keeps the doctrine stream apart from the battle dice seeded with the same number. */
const DOCTRINE_SEED_SALT = 0x9e3779b9;
/** A new target must score this much better before the committed one is dropped. */
const RETARGET_FACTOR = 1.5;
/** Dispossessed yields this much earlier while ahead on the judges' points. */
const AHEAD_YIELD_BONUS = 0.15;
/** Tie-break jitter scale: far below any displayed score difference. */
const JITTER = 0.001;

export function doctrineSeed(seed: number): string {
  return createRng((seed ^ DOCTRINE_SEED_SALT) >>> 0).snapshot();
}

export function newDoctrineContext(seed: number): DoctrineContext {
  return {
    assignments: {},
    rng: doctrineSeed(seed),
    memory: {},
    lastTrace: {},
    traceLevel: "brief",
  };
}

/** Fresh battle (start / rematch): reseed the stream, forget memory and traces. */
export function resetDoctrineBattle(
  ctx: DoctrineContext,
  seed: number,
  unitIds: readonly string[],
): void {
  ctx.rng = doctrineSeed(seed);
  ctx.memory = {};
  ctx.lastTrace = {};
  for (const id of Object.keys(ctx.assignments)) {
    if (!unitIds.includes(id)) delete ctx.assignments[id];
  }
}

export interface Decision {
  readonly commands: readonly string[];
  readonly trace: DecisionTrace;
  readonly next: DoctrineContext;
}

function freshMemory(unit: UnitState): StrategyMemory {
  return {
    targetId: null,
    targetHeld: 0,
    lastTurn: 0,
    posture: "approach",
    turnsInContact: 0,
    remainingAtLastTurn: remainingFraction(unit),
    lossLastTurn: 0,
    enemyModes: {},
  };
}

/** Acting unit at the current prompt, or null outside a battle prompt. */
export function promptActorId(s: Session): string | null {
  if (s.state !== "battle" || s.battle === null) return null;
  if (s.battle.phase === "movement") return s.move?.actorId ?? null;
  if (s.battle.phase === "attack") return s.attack?.actorId ?? null;
  return null;
}

/** Doctrine controlling the current prompt, or null for a human prompt. */
export function promptDoctrine(s: Session): DoctrineKey | null {
  const id = promptActorId(s);
  return id === null ? null : (s.doctrine.assignments[id] ?? null);
}

/** Damage-weighted pick: expected damage now, scaled by how hurt the enemy is. */
function targetScore(actor: UnitState, enemy: UnitState): number {
  const d = Math.max(1, hexDistance(actor.position, enemy.position));
  const ev = expectedDamageAt(usableWeapons(actor), d, actor.gunnery + 2);
  // Closer and weaker enemies break ties when nothing is in range yet.
  return ev + 1 / d + (1 - remainingFraction(enemy));
}

/** Once-per-turn strategy update: target commitment, contact, losses, posture. */
function updateMemory(
  battle: BattleState,
  actor: UnitState,
  doctrine: Doctrine,
  mem: StrategyMemory,
  notes: TraceNote[],
): void {
  const enemies = enemiesOf(battle, actor);
  const newTurn = mem.lastTurn !== battle.turn;
  if (newTurn) {
    const now = remainingFraction(actor);
    mem.lossLastTurn = Math.max(0, mem.remainingAtLastTurn - now);
    mem.remainingAtLastTurn = now;
    mem.lastTurn = battle.turn;
    for (const e of enemies) {
      if (e.moveMode === null) continue;
      const tally = mem.enemyModes[e.id] ?? {};
      tally[e.moveMode] = (tally[e.moveMode] ?? 0) + 1;
      mem.enemyModes[e.id] = tally;
    }
  }

  const current = enemies.find((e) => e.id === mem.targetId) ?? null;
  const ranked = [...enemies].sort((a, b) => targetScore(actor, b) - targetScore(actor, a));
  const best = ranked[0] ?? null;
  if (current === null) {
    if (mem.targetId !== null)
      notes.push({ key: "dp.note.targetLost", params: { target: mem.targetId } });
    mem.targetId = best?.id ?? null;
    mem.targetHeld = 0;
    if (best !== null) notes.push({ key: "dp.note.targetPicked", params: { target: best.id } });
  } else if (
    best !== null &&
    best.id !== current.id &&
    targetScore(actor, best) > RETARGET_FACTOR * targetScore(actor, current)
  ) {
    notes.push({ key: "dp.note.targetSwitched", params: { from: current.id, to: best.id } });
    mem.targetId = best.id;
    mem.targetHeld = 0;
  } else if (newTurn) {
    mem.targetHeld++;
  }

  const target = enemies.find((e) => e.id === mem.targetId) ?? null;
  if (target === null) return;
  const profile = rangeProfile(actor, "any");
  const inContact = hexDistance(actor.position, target.position) <= profile.maxLong;
  if (newTurn) mem.turnsInContact = inContact ? mem.turnsInContact + 1 : 0;
  mem.posture =
    doctrine.key === "hulldown" && hexDistance(actor.position, target.position) > profile.maxMedium
      ? "hold"
      : inContact
        ? "engage"
        : "approach";
}

/** Judges' points lead (GDD §8.3 proxy): own share left minus the target's. */
function aheadOnPoints(actor: UnitState, target: UnitState | null): boolean {
  return (
    target !== null && remainingFraction(actor) - remainingFraction(target) > AHEAD_YIELD_BONUS
  );
}

function walkBudget(unit: UnitState): number {
  const def = mechDefFor(unit);
  const eff = effectiveMovement(
    def,
    unit.damage,
    unit.critSlotsDestroyed,
    isTsmActive(def, unit.heat),
  );
  return effectiveMoveBudget("walk", eff, unit.heat);
}

/** Scripted movement for prompts the scorer does not handle (mirrors `autoplay.ts`). */
function scriptedMovement(actor: UnitState, notes: TraceNote[]): string[] | null {
  if (!isNominal(actor)) {
    notes.push({ key: "dp.note.shutdown" });
    return ["done"];
  }
  if (actor.prone) {
    if (
      isImmobile(actor) ||
      !canAttemptStandUp(actor.damage) ||
      isGyroDestroyed(actor) ||
      (destroyedLegs(actor.damage) === 0 && walkBudget(actor) < STAND_MP_COST) ||
      walkBudget(actor) < 1
    ) {
      notes.push({ key: "dp.note.staysProne" });
      return ["mode pronestill", "done"];
    }
    notes.push({ key: "dp.note.standUp" });
    return ["mode standup walk", "done"];
  }
  if (isUnitImmobile(actor.damage) || walkBudget(actor) === 0) {
    notes.push({ key: "dp.note.immobile" });
    return ["mode standstill", "done"];
  }
  return null;
}

/** Jitter-sorted copy: score first, then the doctrine stream breaks exact ties. */
function rank(candidates: readonly TraceCandidate[], d6: () => number): TraceCandidate[] {
  return candidates
    .map((c) => ({ c, j: (d6() - 3.5) * JITTER }))
    .sort((a, b) => b.c.score + b.j - (a.c.score + a.j))
    .map((x) => x.c);
}

/**
 * Decide the current prompt with doctrine `dk` from context `ctx`, whoever
 * owns the prompt (callers pick the doctrine: the unit's assignment, or the
 * autoplay demo's default); null when there is no battle prompt.
 */
export function decide(s: Session, dk: DoctrineKey, ctx: DoctrineContext): Decision | null {
  const actorId = promptActorId(s);
  const battle = s.battle;
  if (actorId === null || battle === null) return null;
  const doctrine = DOCTRINES[dk];
  const actor = battle.units[actorId];
  if (actor === undefined || !isUnitAvailable(actor)) return null;

  const rng = createRng(0);
  rng.load(ctx.rng);
  const mem: StrategyMemory = structuredClone(ctx.memory[actorId] ?? freshMemory(actor));
  const notes: TraceNote[] = [];
  updateMemory(battle, actor, doctrine, mem, notes);
  const target = mem.targetId !== null ? (battle.units[mem.targetId] ?? null) : null;
  const heatCeiling = heatCeilingFor(doctrine, actor, target);
  const phase = battle.phase === "attack" ? "attack" : "movement";

  let candidates: TraceCandidate[] = [];
  let commands: string[];
  // A half-typed human declaration is cleared first.
  const pending =
    phase === "movement"
      ? (s.move?.moveMode ?? null) !== null
      : (s.attack?.weaponDecls.length ?? 0) > 0 || (s.attack?.physicalDecls.length ?? 0) > 0;
  const prefix = pending ? ["cancel"] : [];

  if (phase === "movement") {
    const scripted = scriptedMovement(actor, notes);
    const left = remainingFraction(actor);
    const yieldAt =
      doctrine.yieldAt +
      (doctrine.yieldWhenAhead && aheadOnPoints(actor, target) ? AHEAD_YIELD_BONUS : 0);
    const noWeapons = usableWeapons(actor).length === 0 && doctrine.melee === "never";
    if (doctrine.yieldAt > 0 && (left <= yieldAt || noWeapons)) {
      mem.posture = "yield";
      notes.push(
        noWeapons
          ? { key: "dp.note.yieldWeapons" }
          : {
              key: "dp.note.yield",
              params: { left: Math.round(left * 100), at: Math.round(yieldAt * 100) },
            },
      );
      commands = ["mode eject", "done"];
    } else if (scripted !== null) {
      mem.posture = "recover";
      commands = scripted;
    } else if (target === null) {
      notes.push({ key: "dp.note.noTarget" });
      commands = ["mode standstill", "done"];
    } else {
      candidates = rank(
        scoreMoves({
          battle,
          actor,
          target,
          doctrine,
          profile: rangeProfile(actor, doctrine.range),
          heatCeiling,
        }),
        () => rng.d6(),
      );
      commands = [...(candidates[0]?.commands ?? ["mode standstill", "done"])];
    }
  } else if (target === null) {
    notes.push({ key: "dp.note.noTarget" });
    commands = ["done"];
  } else {
    const scored = scoreAttacks({ battle, actor, targetId: target.id, doctrine, heatCeiling });
    notes.push(...scored.notes);
    candidates = rank(scored.candidates, () => rng.d6());
    commands = [...(candidates[0]?.commands ?? ["done"])];
  }
  commands = [...prefix, ...commands];

  const trace: DecisionTrace = {
    turn: battle.turn,
    phase,
    actorId,
    targetId: mem.targetId,
    doctrine: dk,
    posture: mem.posture,
    targetHeld: mem.targetHeld,
    heat: actor.heat + actor.heatPending,
    heatCeiling,
    candidates,
    notes,
    commands,
  };
  const next: DoctrineContext = {
    ...ctx,
    rng: rng.snapshot(),
    memory: { ...ctx.memory, [actorId]: mem },
    lastTrace: { ...ctx.lastTrace, [actorId]: trace },
  };
  return { commands, trace, next };
}
