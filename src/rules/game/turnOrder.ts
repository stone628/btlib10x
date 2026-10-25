import type { Rng } from "../../core/types";
import { isAmmoPolicy } from "../ammo";
import { isAmsPolicy } from "../ams";
import { rollInitiative } from "../initiative";
import { isPilotUnconscious } from "../pilot";
import { isNominal, isShutdown, isUnitRemoved, requirePhase, requireUnit } from "./queries";
import type {
  ActorPhase,
  ActorQueueActorView,
  ActorQueueView,
  BattleState,
  GameEvent,
  UnitPolicy,
  UnitState,
} from "./types";

/**
 * Enforce that `unitId` is the next pending actor for the given phase.
 * Drives off `pendingActors` so the same exclusions apply: removed, shut-down
 * (weapon phase), unconscious, and already-acted or passed units are not
 * eligible. Callers must pass the head-of-queue unit, otherwise the engine
 * rejects the action. Matches TW turn flow.
 */
export function requireCurrentActor(state: BattleState, unitId: string, phase: ActorPhase): void {
  if (state.initiativeWinnerTeam === null) {
    throw new Error(`${unitId} cannot act before initiative is set`);
  }
  if (state.phase !== phase) {
    throw new Error(`${unitId} is not acting in the ${phase} phase`);
  }
  const head = pendingActors(state)[0] ?? null;
  if (head !== unitId) {
    throw new Error(`${unitId} is not the current actor (expected ${head ?? "none"})`);
  }
}

export function rollInitiativePhase(state: BattleState, rng: Rng, sink: GameEvent[]): void {
  sink.push(...initiativePhaseGen(state, rng));
}

export function* initiativePhaseGen(state: BattleState, rng: Rng): Generator<GameEvent> {
  requirePhase(state, "initiative");
  const teams = [...new Set(Object.values(state.units).map((u) => u.team))];
  const result = rollInitiative(teams, rng);
  state.initiativeWinnerTeam = result.winnerTeam;
  state.actorQueue = null;
  yield { kind: "initiative", rolls: result.rolls, winnerTeam: result.winnerTeam };
  state.phase = "movement";
  yield {
    kind: "phase",
    prevTurn: state.turn,
    prevPhase: "initiative",
    turn: state.turn,
    phase: "movement",
  };
}

/** Close the End Phase: bump the turn, enter the initiative phase and clear
 *  per-turn unit state. `advancePhaseGen` calls it after the end-phase
 *  checks; `createBattle`'s turn-0 placeholder needs only this. */
export function startNextTurn(state: BattleState): void {
  state.turn += 1;
  state.initiativeWinnerTeam = null;
  state.phase = "initiative";
  state.actedThisPhase = [];
  for (const unit of Object.values(state.units)) {
    unit.moveMode = null;
    unit.hexesMovedThisTurn = 0;
    unit.jumpedThisTurn = false;
    unit.mpSpent = 0;
    unit.declaredWeaponAttacks = [];
    unit.passedAttacks = false;
    unit.declaredPickup = null;
  }
}

/** The unit's live policy (the `UnitState` copies of its `UnitPolicy`). */
export function unitPolicyOf(unit: UnitState): UnitPolicy {
  return {
    ammoPolicy: unit.ammoPolicy,
    autoEject: unit.autoEject,
    heatFlamer: unit.heatFlamer,
    amsPolicy: unit.amsPolicy,
  };
}

/** Change the current actor's policy before its activation commits, in the
 *  movement or attack phase. Draws no dice and records no event; the change
 *  applies from now on (ammo drawn at its `declareAttacks`, flamer mode and
 *  AMS choice at that phase's resolution, auto-eject at the next head /
 *  center torso loss).
 *  Limiting it to the current actor keeps already-declared shots of other
 *  units unchanged. Returns the resulting policy. */
export function setUnitPolicy(
  state: BattleState,
  unitId: string,
  patch: Partial<UnitPolicy>,
): UnitPolicy {
  if (state.phase !== "movement" && state.phase !== "attack") {
    throw new Error(`${unitId} cannot change policy in the ${state.phase} phase`);
  }
  requireCurrentActor(state, unitId, state.phase);
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (patch.ammoPolicy !== undefined && !isAmmoPolicy(patch.ammoPolicy)) {
    throw new Error(`bad ammo policy ${JSON.stringify(patch.ammoPolicy)}`);
  }
  if (patch.amsPolicy !== undefined && !isAmsPolicy(patch.amsPolicy)) {
    throw new Error(`bad AMS policy ${JSON.stringify(patch.amsPolicy)}`);
  }
  if (patch.ammoPolicy !== undefined) unit.ammoPolicy = patch.ammoPolicy;
  if (patch.autoEject !== undefined) unit.autoEject = patch.autoEject;
  if (patch.heatFlamer !== undefined) unit.heatFlamer = patch.heatFlamer;
  if (patch.amsPolicy !== undefined) unit.amsPolicy = patch.amsPolicy;
  return unitPolicyOf(unit);
}

/** Suggest which unit must act next (initiative loser alternates first). */
export function nextActor(state: BattleState): string | null {
  if (state.phase !== "movement" && state.phase !== "attack") return null;
  if (state.initiativeWinnerTeam === null) return null;
  return pendingActors(state)[0] ?? null;
}

export function actorToQueueView(actor: UnitState, forcePriority?: boolean): ActorQueueActorView {
  return {
    id: actor.id,
    team: actor.team,
    hasPriority: forcePriority ?? isShutdown(actor),
  };
}

/** Who already acted this phase, and the ordered queue of who must still act. */
export function actorQueue(state: BattleState): ActorQueueView {
  if (
    (state.phase !== "movement" && state.phase !== "attack") ||
    state.initiativeWinnerTeam === null
  ) {
    return { initiative: state.initiativeWinnerTeam, acted: [], pending: [], removed: [] };
  }
  const alive = new Map<string, UnitState>();
  const removed: ActorQueueActorView[] = [];
  for (const u of Object.values(state.units)) {
    if (isUnitRemoved(u)) {
      removed.push(actorToQueueView(u, false));
      continue;
    }
    alive.set(u.id, u);
  }
  // const acted = state.actedThisPhase.filter((id) => alive.has(id));
  return {
    initiative: state.initiativeWinnerTeam,
    acted: state.actedThisPhase
      .map((id) => {
        const actor = alive.get(id);
        return actor !== undefined ? actorToQueueView(actor) : null;
      })
      .filter((av) => av !== null),
    pending: pendingActors(state).map((id) => actorToQueueView(state.units[id]!)),
    removed,
  };
}

/** Units still to act this phase, in activation order (cached per phase). */
export function pendingActors(state: BattleState): string[] {
  if (state.actorQueue === null) state.actorQueue = buildActorQueue(state);
  const nominalOnly = state.phase === "attack";
  return state.actorQueue.filter((id) => {
    const unit = state.units[id];
    if (!unit || isUnitRemoved(unit)) return false;
    if (state.actedThisPhase.includes(id)) return false;
    if (unit.passedAttacks) return false;
    // An unconscious pilot cannot move, fire, or act (TW p.42).
    if (isPilotUnconscious(unit)) return false;
    if (nominalOnly && !isNominal(unit)) return false;
    return true;
  });
}

/** Full activation order for the current phase: movement phases front-load
 *  shut-down units (they can only attempt startup or pass); both phases then
 *  alternate initiative-loser-first. Before every step the ratio is
 *  recounted from the units each team still has to place: each team places
 *  ⌊left/minLeft⌋ units (TW p.39 unequal-force activation, e.g. 8 v 5 →
 *  1/1, 1/1, 1/2, 1/2, 1/2). In the attack phase only units that can
 *  declare are counted (GAME-02). */
export function buildActorQueue(state: BattleState): string[] {
  const alive = Object.values(state.units).filter((u) => !isUnitRemoved(u));
  const teams = [...new Set(alive.map((u) => u.team))];
  if (teams.length === 0 || state.initiativeWinnerTeam === null) return [];
  const winner = state.initiativeWinnerTeam;
  const loser = teams.find((t) => t !== winner) ?? winner;
  const order = loser === winner ? teams : [loser, ...teams.filter((t) => t !== loser)];

  const downIds = new Set<string>();
  if (state.phase === "movement") {
    for (const u of alive) if (isShutdown(u)) downIds.add(u.id);
  }

  // Shut-down units are front-loaded and stay outside the alternation.
  const queue: string[] = alive.filter((u) => downIds.has(u.id)).map((u) => u.id);

  // In the attack phase shut-down units and unconscious pilots cannot declare,
  // so they stay out of the ratio (TW p.39 counts units "still to declare for").
  const canDeclare = (u: UnitState): boolean =>
    state.phase !== "attack" || (isNominal(u) && !isPilotUnconscious(u));
  const nominal = alive.filter((u) => !downIds.has(u.id) && canDeclare(u));
  const nextIndex = new Map<number, number>();
  for (const t of teams) nextIndex.set(t, 0);
  const left = (team: number): number =>
    nominal.filter((u) => u.team === team).length - (nextIndex.get(team) ?? 0);

  while (queue.length < alive.length) {
    const live = order.filter((team) => left(team) > 0);
    if (live.length === 0) break;
    const minLeft = Math.min(...live.map(left));
    for (const team of live) {
      const count = Math.max(1, Math.floor(left(team) / minLeft));
      for (let n = 0; n < count; n++) {
        const idx = nextIndex.get(team) ?? 0;
        const unit = nominal.filter((u) => u.team === team)[idx];
        if (!unit) break;
        queue.push(unit.id);
        nextIndex.set(team, idx + 1);
      }
    }
  }
  return queue;
}
