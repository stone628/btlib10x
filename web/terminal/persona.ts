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
  canUnitStandUp,
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
import { scoreAttacks } from "./persona.attack";
import {
  type DecisionTrace,
  enemiesOf,
  expectedDamageAt,
  heatCeilingFor,
  type Posture,
  type RangeProfile,
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
  /** The committed target's armor + structure left at the start of this turn. */
  targetAtTurnStart: { id: string; left: number } | null;
  /**
   * Stall count: +1 for each turn in which neither this unit nor its target
   * lost anything, halved by a turn with losses (one lucky hit does not end
   * the pressure of a long, idle duel).
   */
  quietTurns: number;
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
/** Quiet turns tolerated before the unit starts to press in. */
const STALL_GRACE = 2;
/** Cover and exposure weights shrink by this factor per pressing step... */
const STALL_WEIGHT_STEP = 0.8;
/** ...down to this floor. */
const STALL_WEIGHT_FLOOR = 0.3;
/** Most heat-ceiling points pressing adds. */
const STALL_HEAT_MAX = 3;
/** Highest to-hit number a 2D6 roll can make. */
const MAX_TN = 12;

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
    targetAtTurnStart: null,
    quietTurns: 0,
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
    // Quiet: no loss on either side of the duel since the previous turn.
    const was = mem.targetAtTurnStart;
    const held = was === null ? null : (enemies.find((e) => e.id === was.id) ?? null);
    const quiet =
      was !== null &&
      held !== null &&
      mem.lossLastTurn === 0 &&
      remainingFraction(held) >= was.left;
    mem.quietTurns = quiet ? mem.quietTurns + 1 : Math.floor(mem.quietTurns / 2);
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
  if (target === null) {
    mem.targetAtTurnStart = null;
    return;
  }
  if (newTurn || mem.targetAtTurnStart?.id !== target.id) {
    mem.targetAtTurnStart = { id: target.id, left: remainingFraction(target) };
  }
  const profile = rangeProfile(actor, "any");
  const inContact = hexDistance(actor.position, target.position) <= profile.maxLong;
  if (newTurn) mem.turnsInContact = inContact ? mem.turnsInContact + 1 : 0;
  mem.posture =
    persona.key === "hulldown" && hexDistance(actor.position, target.position) > profile.maxMedium
      ? "hold"
      : inContact
        ? "engage"
        : "approach";
  if (stallPressure(mem) > 0) mem.posture = "press";
}

/** Pressing steps after a run of quiet turns (0 = no pressure). */
function stallPressure(mem: StrategyMemory): number {
  return Math.max(0, mem.quietTurns - STALL_GRACE);
}

/**
 * A stalled duel pulls the unit in, one step per pressing turn: the preferred
 * distance drops a hex (not below the edge of its short bracket), the cover
 * and exposure weights shrink so a shot outweighs hiding, the ammo to-hit
 * limit rises and the heat ceiling rises up to {@link STALL_HEAT_MAX}.
 */
function pressed(
  base: Persona,
  profile: RangeProfile,
  mem: StrategyMemory,
  notes: TraceNote[],
): { persona: Persona; profile: RangeProfile } {
  const steps = stallPressure(mem);
  if (steps === 0) return { persona: base, profile };
  const preferred = Math.max(
    Math.min(profile.preferred, profile.maxShort),
    profile.preferred - steps,
  );
  const factor = Math.max(STALL_WEIGHT_FLOOR, STALL_WEIGHT_STEP ** steps);
  const heat = Math.min(steps, STALL_HEAT_MAX);
  const w = base.weights;
  const persona: Persona = {
    ...base,
    weights: { ...w, cover: w.cover * factor, exposed: w.exposed * factor },
    heatCeiling: base.heatCeiling + heat,
    heatCeilingEngaged: base.heatCeilingEngaged + heat,
    ammo: { ...base.ammo, maxTn: Math.min(MAX_TN, base.ammo.maxTn + steps) },
  };
  notes.push({
    key: "pp.note.pressing",
    params: {
      quiet: mem.quietTurns,
      distance: preferred,
      factor: factor.toFixed(2),
      tn: persona.ammo.maxTn,
      heat,
    },
  });
  return { persona, profile: { ...profile, preferred } };
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
      !canUnitStandUp(actor) ||
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
  const base = PERSONAS[dk];
  const actor = battle.units[actorId];
  if (actor === undefined || !isUnitAvailable(actor)) return null;

  const rng = createRng(0);
  rng.load(ctx.rng);
  const mem: StrategyMemory = structuredClone(ctx.memory[actorId] ?? freshMemory(actor));
  const notes: TraceNote[] = [];
  updateMemory(battle, actor, base, mem, notes);
  const { persona, profile } = pressed(base, rangeProfile(actor, base.range), mem, notes);
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
          profile,
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
    // Only active enemies: hulls are never fired on (salvage is not denied).
    candidates = rank(scored.candidates, () => rng.d6());
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
