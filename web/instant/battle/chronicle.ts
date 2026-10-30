/**
 * The debrief's battle record: running fire statistics, damage per turn and
 * a short list of key moments, digested from each batch of game events as
 * the battle runs. The events themselves are not kept.
 */
import type { BattleState, DestroyedReason, GameEvent, RemovalReason } from "btlib10x";

/** One weapon (by name) of one unit: weapon attacks, or physical attacks by type. */
export interface WeaponStat {
  readonly name: string;
  /** True for a physical attack (punch, kick, club, charge, DFA). */
  readonly physical: boolean;
  shots: number;
  hits: number;
  damage: number;
  /** The single most damaging hit. */
  best: { turn: number; targetId: string; damage: number } | null;
}

export interface UnitRecord {
  shots: number;
  hits: number;
  /** Damage this unit's hits put on enemy units. */
  dealt: number;
  /** Highest heat the unit ended a heat phase on. */
  peakHeat: number;
  shutdowns: number;
  /** Units this one got the largest kill share of. */
  kills: string[];
  /** Units this one shared a kill on without the largest share. */
  assists: string[];
  weapons: WeaponStat[];
}

export type Moment =
  | { readonly kind: "firstBlood"; turn: number; unitId: string; targetId: string; damage: number }
  | { readonly kind: "fell"; turn: number; unitId: string }
  | { readonly kind: "shutdown"; turn: number; unitId: string; heat: number }
  | { readonly kind: "ammoBoom"; turn: number; unitId: string; weapon: string }
  | { readonly kind: "unconscious"; turn: number; unitId: string }
  | {
      readonly kind: "removed";
      turn: number;
      unitId: string;
      reason: RemovalReason;
      destroyReason: DestroyedReason | null;
      /** Largest kill share, null when no enemy dealt damage in the window. */
      by: string | null;
    };

export interface Chronicle {
  /** Turn the next event belongs to. */
  turn: number;
  /** Team → damage its units' hits dealt, by turn (index 0 = turn 1). */
  perTurn: Record<number, number[]>;
  units: Record<string, UnitRecord>;
  moments: Moment[];
}

export function newChronicle(state: BattleState): Chronicle {
  const units: Record<string, UnitRecord> = {};
  const perTurn: Record<number, number[]> = {};
  for (const u of Object.values(state.units)) {
    units[u.id] = {
      shots: 0,
      hits: 0,
      dealt: 0,
      peakHeat: 0,
      shutdowns: 0,
      kills: [],
      assists: [],
      weapons: [],
    };
    perTurn[u.team] = [];
  }
  return { turn: state.turn, perTurn, units, moments: [] };
}

function weaponStat(rec: UnitRecord, name: string, physical: boolean): WeaponStat {
  let w = rec.weapons.find((x) => x.name === name && x.physical === physical);
  if (!w) {
    w = { name, physical, shots: 0, hits: 0, damage: 0, best: null };
    rec.weapons.push(w);
  }
  return w;
}

function sum(groups: readonly { damage: number }[]): number {
  let n = 0;
  for (const g of groups) n += g.damage;
  return n;
}

function attack(
  c: Chronicle,
  state: BattleState,
  unitId: string,
  targetId: string,
  name: string,
  physical: boolean,
  hit: boolean,
  damage: number,
): void {
  const rec = c.units[unitId];
  if (!rec) return;
  const w = weaponStat(rec, name, physical);
  rec.shots += 1;
  w.shots += 1;
  if (!hit) return;
  rec.hits += 1;
  w.hits += 1;
  if (damage <= 0) return;
  w.damage += damage;
  if (!w.best || damage > w.best.damage) w.best = { turn: c.turn, targetId, damage };
  const attacker = state.units[unitId];
  const target = state.units[targetId];
  if (!attacker || !target || attacker.team === target.team) return;
  rec.dealt += damage;
  c.perTurn[attacker.team] ??= [];
  const row = c.perTurn[attacker.team]!;
  while (row.length < c.turn) row.push(0);
  row[c.turn - 1]! += damage;
  if (!c.moments.some((m) => m.kind === "firstBlood"))
    c.moments.push({ kind: "firstBlood", turn: c.turn, unitId, targetId, damage });
}

/** Fold one batch of events into the record. */
export function digest(c: Chronicle, events: readonly GameEvent[], state: BattleState): void {
  for (const e of events) {
    switch (e.kind) {
      case "phase":
        c.turn = e.turn;
        break;
      case "attackResolved": {
        const r = e.resolution;
        attack(c, state, e.unitId, e.targetId, r.weapon, false, r.hit, sum(r.groups));
        break;
      }
      case "physicalAttackResolved": {
        const r = e.resolution;
        attack(c, state, e.unitId, e.targetId, r.type, true, r.hit, sum(r.damageToTarget));
        break;
      }
      case "unitFell":
        // A unit already out of play falling (its salvage fall, TW p.128) is not news.
        if (
          e.cause.kind !== "voluntaryDrop" &&
          !e.hull &&
          !c.moments.some((m) => m.kind === "removed" && m.unitId === e.unitId)
        )
          c.moments.push({ kind: "fell", turn: c.turn, unitId: e.unitId });
        break;
      case "shutdownCheck":
        if (e.result === "shutdown") {
          const rec = c.units[e.unitId];
          if (rec) rec.shutdowns += 1;
          c.moments.push({ kind: "shutdown", turn: c.turn, unitId: e.unitId, heat: e.heat });
        }
        break;
      case "heatDissipated": {
        const rec = c.units[e.unitId];
        if (rec) rec.peakHeat = Math.max(rec.peakHeat, e.startHeat, e.endHeat);
        break;
      }
      case "ammoExplosionCheck":
        if (!e.avoided)
          c.moments.push({ kind: "ammoBoom", turn: c.turn, unitId: e.unitId, weapon: e.weapon });
        break;
      case "consciousnessCheck":
        if (!e.success && e.cause !== "recovery")
          c.moments.push({ kind: "unconscious", turn: c.turn, unitId: e.unitId });
        break;
      case "unitRemoved": {
        const [top, ...rest] = e.credit;
        if (top) c.units[top.unitId]?.kills.push(e.unitId);
        for (const k of rest) c.units[k.unitId]?.assists.push(e.unitId);
        c.moments.push({
          kind: "removed",
          turn: c.turn,
          unitId: e.unitId,
          reason: e.reason,
          destroyReason: e.destroyReason ?? null,
          by: top?.unitId ?? null,
        });
        break;
      }
      default:
        break;
    }
  }
}

/** Damage per turn for every team, padded to `turns` turns. */
export function damageByTurn(c: Chronicle, turns: number): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  for (const [team, row] of Object.entries(c.perTurn)) {
    out[Number(team)] = Array.from({ length: turns }, (_, i) => row[i] ?? 0);
  }
  return out;
}
