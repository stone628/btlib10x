/**
 * Pilot record: derived survival status and the record-sheet view of a
 * pilot (hit track, consciousness targets). Pure functions over the pilot
 * fields on `UnitState`; nothing here is stored, so snapshots cannot drift.
 */

import type { UnitState } from "./game";
import { consciousnessTarget } from "./piloting";

/** The pilot's relation to the 'Mech.
 *  - `active`: seated and awake.
 *  - `unconscious`: seated, out cold (wake rolls in the end phase).
 *  - `ejected`: left the 'Mech, even if the ejection damage reached the hit
 *    max (inspect `hp` for that).
 *  - `dead`: died inside the 'Mech without ejecting. */
export type PilotStatus = "active" | "unconscious" | "ejected" | "dead";

export interface PilotRecord {
  readonly gunnery: number;
  readonly piloting: number;
  /** Hits taken. */
  readonly hits: number;
  /** Hit capacity; the pilot dies when hits reach it. */
  readonly hitMax: number;
  /** Remaining HP: hitMax - hits, floored at 0. */
  readonly hp: number;
  /** Consciousness target for the next hit; null when that hit (or the last) kills. */
  readonly nextTarget: number | null;
  readonly status: PilotStatus;
}

/** The pilot is out cold: knocked out (`unconsciousSinceTurn`) and not yet awake. */
export function isPilotUnconscious(unit: UnitState): boolean {
  return unit.unconsciousSinceTurn !== null;
}

export function pilotStatus(unit: UnitState): PilotStatus {
  // A pilot killed by the ejection landing is dead, not "ejected".
  if (unit.pilotHits >= unit.pilotHitMax) return "dead";
  if (unit.removed === "pilotEjected") return "ejected";
  return isPilotUnconscious(unit) ? "unconscious" : "active";
}

export function pilotRecord(unit: UnitState): PilotRecord {
  const nextHit = unit.pilotHits + 1;
  return {
    gunnery: unit.gunnery,
    piloting: unit.piloting,
    hits: unit.pilotHits,
    hitMax: unit.pilotHitMax,
    hp: Math.max(0, unit.pilotHitMax - unit.pilotHits),
    nextTarget: nextHit > unit.pilotHitMax ? null : consciousnessTarget(nextHit, unit.pilotHitMax),
    status: pilotStatus(unit),
  };
}
