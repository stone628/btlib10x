/**
 * Persona player (GDD §9): a one-ply scoring player that types CLI commands
 * for units assigned a MechWarrior persona at setup.
 *
 * - Assignment lives here, never in `UnitInit` or the engine.
 * - Its context is plain serializable data on `Session.persona`: the
 *   assignments, its own RNG stream (seeded apart from the battle dice, used
 *   only to break ties, so deciding never moves `s.rng`), long-term
 *   {@link StrategyMemory} per unit, and the last {@link DecisionTrace} per unit.
 * - `decide()` is pure: it returns the commands, the trace and the next
 *   context. The driver (`web/persona.cli.ts`) installs the next context
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
import { isGyroDestroyed } from "./misc";
import { scoreAttacks } from "./persona.attack";
import {
  type DecisionTrace,
  enemiesOf,
  enemyHullsOf,
  expectedDamageAt,
  heatCeilingFor,
  type Posture,
  rangeProfile,
  remainingFraction,
  type TraceCandidate,
  type TraceNote,
  usableWeapons,
} from "./persona.common";
import { PERSONAS, type Persona, type PersonaKey } from "./persona.data";
import { scoreMoves } from "./persona.move";
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

export interface PersonaContext {
  /** Unit id → persona. Set in setup; kept across rematch. */
  assignments: Record<string, PersonaKey>;
  /** Snapshot of the persona player's own RNG stream. */
  rng: string;
  memory: Record<string, StrategyMemory>;
  lastTrace: Record<string, DecisionTrace>;
  traceLevel: TraceLevel;
}

/** Keeps the persona stream apart from the battle dice seeded with the same number. */
const PERSONA_SEED_SALT = 0x9e3779b9;
/** A new target must score this much better before the committed one is dropped. */
const RETARGET_FACTOR = 1.5;
/** Dispossessed yields this much earlier while ahead on the judges' points. */
const AHEAD_YIELD_BONUS = 0.15;
/** Tie-break jitter scale: far below any displayed score difference. */
const JITTER = 0.001;

export function personaSeed(seed: number): string {
  return createRng((seed ^ PERSONA_SEED_SALT) >>> 0).snapshot();
}

export function newPersonaContext(seed: number): PersonaContext {
  return {
    assignments: {},
    rng: personaSeed(seed),
    memory: {},
    lastTrace: {},
    traceLevel: "brief",
  };
}

/** Fresh battle (start / rematch): reseed the stream, forget memory and traces. */
export function resetPersonaBattle(
  ctx: PersonaContext,
  seed: number,
  unitIds: readonly string[],
): void {
  ctx.rng = personaSeed(seed);
  ctx.memory = {};
  ctx.lastTrace = {};
  for (const id of Object.keys(ctx.assignments)) {
    if (!unitIds.includes(id)) delete ctx.assignments[id];
  }
}

export interface Decision {
  readonly commands: readonly string[];
  readonly trace: DecisionTrace;
  readonly next: PersonaContext;
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

/** Persona controlling the current prompt, or null for a human prompt. */
export function promptPersona(s: Session): PersonaKey | null {
  const id = promptActorId(s);
  return id === null ? null : (s.persona.assignments[id] ?? null);
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
  persona: Persona,
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
      notes.push({ key: "pp.note.targetLost", params: { target: mem.targetId } });
    mem.targetId = best?.id ?? null;
    mem.targetHeld = 0;
    if (best !== null) notes.push({ key: "pp.note.targetPicked", params: { target: best.id } });
  } else if (
    best !== null &&
    best.id !== current.id &&
    targetScore(actor, best) > RETARGET_FACTOR * targetScore(actor, current)
  ) {
    notes.push({ key: "pp.note.targetSwitched", params: { from: current.id, to: best.id } });
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
    persona.key === "hulldown" && hexDistance(actor.position, target.position) > profile.maxMedium
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
    notes.push({ key: "pp.note.shutdown" });
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
      notes.push({ key: "pp.note.staysProne" });
      return ["mode pronestill", "done"];
    }
    notes.push({ key: "pp.note.standUp" });
    return ["mode standup walk", "done"];
  }
  if (isUnitImmobile(actor.damage) || walkBudget(actor) === 0) {
    notes.push({ key: "pp.note.immobile" });
    return ["mode standstill", "done"];
  }
  return null;
}

/** Jitter-sorted copy: score first, then the persona stream breaks exact ties. */
function rank(candidates: readonly TraceCandidate[], d6: () => number): TraceCandidate[] {
  return candidates
    .map((c) => ({ c, j: (d6() - 3.5) * JITTER }))
    .sort((a, b) => b.c.score + b.j - (a.c.score + a.j))
    .map((x) => x.c);
}

/**
 * Decide the current prompt with persona `dk` from context `ctx`, whoever
 * owns the prompt (callers pick the persona: the unit's assignment, or the
 * autoplay demo's default); null when there is no battle prompt.
 */
export function decide(s: Session, dk: PersonaKey, ctx: PersonaContext): Decision | null {
  const actorId = promptActorId(s);
  const battle = s.battle;
  if (actorId === null || battle === null) return null;
  const persona = PERSONAS[dk];
  const actor = battle.units[actorId];
  if (actor === undefined || !isUnitAvailable(actor)) return null;

  const rng = createRng(0);
  rng.load(ctx.rng);
  const mem: StrategyMemory = structuredClone(ctx.memory[actorId] ?? freshMemory(actor));
  const notes: TraceNote[] = [];
  updateMemory(battle, actor, persona, mem, notes);
  const target = mem.targetId !== null ? (battle.units[mem.targetId] ?? null) : null;
  const heatCeiling = heatCeilingFor(persona, actor, target);
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
      persona.yieldAt +
      (persona.yieldWhenAhead && aheadOnPoints(actor, target) ? AHEAD_YIELD_BONUS : 0);
    const noWeapons = usableWeapons(actor).length === 0 && persona.melee === "never";
    if (persona.yieldAt > 0 && (left <= yieldAt || noWeapons)) {
      mem.posture = "yield";
      notes.push(
        noWeapons
          ? { key: "pp.note.yieldWeapons" }
          : {
              key: "pp.note.yield",
              params: { left: Math.round(left * 100), at: Math.round(yieldAt * 100) },
            },
      );
      commands = ["mode eject", "done"];
    } else if (scripted !== null) {
      mem.posture = "recover";
      commands = scripted;
    } else if (target === null) {
      notes.push({ key: "pp.note.noTarget" });
      commands = ["mode standstill", "done"];
    } else {
      candidates = rank(
        scoreMoves({
          battle,
          actor,
          target,
          persona,
          profile: rangeProfile(actor, persona.range),
          heatCeiling,
        }),
        () => rng.d6(),
      );
      commands = [...(candidates[0]?.commands ?? ["mode standstill", "done"])];
    }
  } else if (target === null) {
    notes.push({ key: "pp.note.noTarget" });
    commands = ["done"];
  } else {
    const scored = scoreAttacks({ battle, actor, targetId: target.id, persona, heatCeiling });
    notes.push(...scored.notes);
    let pool = scored.candidates;
    // Nothing live in reach: spend the fire on enemy hulls to deny salvage.
    if (!pool.some((c) => c.score > 0)) {
      for (const hull of enemyHullsOf(battle, actor)) {
        const h = scoreAttacks({ battle, actor, targetId: hull.id, persona, heatCeiling });
        const worth = h.candidates.filter((c) => c.score > 0);
        if (worth.length === 0) continue;
        notes.push({ key: "pp.note.hullTarget", params: { target: hull.id } });
        pool = [...pool, ...worth];
      }
    }
    candidates = rank(pool, () => rng.d6());
    commands = [...(candidates[0]?.commands ?? ["done"])];
  }
  commands = [...prefix, ...commands];

  const trace: DecisionTrace = {
    turn: battle.turn,
    phase,
    actorId,
    targetId: mem.targetId,
    persona: dk,
    posture: mem.posture,
    targetHeld: mem.targetHeld,
    heat: actor.heat + actor.heatPending,
    heatCeiling,
    candidates,
    notes,
    commands,
  };
  const next: PersonaContext = {
    ...ctx,
    rng: rng.snapshot(),
    memory: { ...ctx.memory, [actorId]: mem },
    lastTrace: { ...ctx.lastTrace, [actorId]: trace },
  };
  return { commands, trace, next };
}
