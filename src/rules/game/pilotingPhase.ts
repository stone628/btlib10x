import { cellAt } from "../../core/terrain";
import type { Rng } from "../../core/types";
import { mechDefFor } from "../../data/index";
import { countDestroyedGyro, destroyedStructures, HIP } from "../critical";
import { isPilotUnconscious } from "../pilot";
import {
  GYRO_DESTROYED_HITS,
  GYRO_HIT_MOD,
  HIP_MOD,
  LEG_ACTUATOR_MOD,
  LEG_ACTUATORS,
  PSR_DAMAGE_THRESHOLD,
  preexistingDamageModifier,
} from "../piloting";
import { legGone } from "./condition";
import { applyFall, pushPilotingCheck } from "./consequences";
import { PHASE_DAMAGE_PSR_MOD, SEATBELT_GYRO_DESTROYED } from "./constants";
import { damageTaken, newlyDestroyedStructures } from "./ledger";
import { isHull, isShutdown, isUnitOnBoard } from "./queries";
import type {
  BattleState,
  GameEvent,
  PhaseDealt,
  PilotingCheckReason,
  UnitFallCause,
} from "./types";

/**
 * End-of-phase piloting sweep (TW p.59-60): every standing unit that took
 * 20+ damage rolls a PSR (+1); every newly destroyed leg/foot actuator (+1),
 * hip (+2), and first gyro hit (+3) forces its own PSR; a destroyed second
 * gyro slot or a destroyed leg falls the 'Mech automatically. A shut-down or
 * unconscious unit that must roll falls automatically instead. Stops a unit's
 * queue at its first failed roll. Fall damage never re-triggers the sweep.
 * Measures the units in scope of `state.currentDealt` against its `before`
 * snapshot and 20-point totals; with no window, nothing rolls for damage.
 */
export function resolvePhasePiloting(
  state: BattleState,
  rng: Rng,
  sink: GameEvent[],
  extraTriggers?: Readonly<
    Record<string, ReadonlyArray<{ reason: PilotingCheckReason; modifier: number }>>
  >,
  /** Weapon-phase sweep: a DFA'er that fails (or would automatically fail)
   *  its roll does not fall; its DFA misses instead (TW p.149). */
  spareDfa = false,
): void {
  const before = state.currentDealt?.before ?? { damage: {}, crit: {} };
  // Read the window's totals as they stand now: fall damage taken during the
  // sweep never re-triggers it. Units missing from the totals fall back to
  // the `damageTaken` before/after diff, which also counts step-5 wiped armor.
  const dealt: PhaseDealt = { ...state.currentDealt?.total };
  for (const unit of Object.values(state.units)) {
    if (!isUnitOnBoard(unit) || unit.prone) continue;
    const sparedDfa = spareDfa && unit.meleeCharge?.kind === "dfa";
    const def = mechDefFor(unit);
    const dmgBefore = before.damage[unit.id] ?? unit.damage;
    const critBefore = before.crit[unit.id] ?? unit.critSlotsDestroyed;
    const pre = { ...preexistingDamageModifier(def, dmgBefore, critBefore) };
    // A hip destroyed this phase wipes that leg's earlier actuator modifiers
    // from the roll made in the same phase (TW pp.60,127).
    for (const hit of newlyDestroyedStructures(def, critBefore, unit.critSlotsDestroyed)) {
      if (hit.name !== HIP) continue;
      const earlier = destroyedStructures(def, dmgBefore, critBefore, hit.location);
      if (earlier.includes(HIP)) continue;
      for (const n of earlier) if (LEG_ACTUATORS.has(n)) pre.modifier -= LEG_ACTUATOR_MOD;
    }

    const triggers: Array<{ reason: PilotingCheckReason; modifier: number }> = [];
    const taken = dealt[unit.id] ?? damageTaken(dmgBefore, unit.damage);
    if (taken >= PSR_DAMAGE_THRESHOLD) {
      triggers.push({ reason: "damage20", modifier: PHASE_DAMAGE_PSR_MOD });
    }
    for (const hit of newlyDestroyedStructures(def, critBefore, unit.critSlotsDestroyed)) {
      if (hit.name === HIP) triggers.push({ reason: "hip", modifier: HIP_MOD });
      else if (LEG_ACTUATORS.has(hit.name))
        triggers.push({ reason: "legActuator", modifier: LEG_ACTUATOR_MOD });
    }
    const gyroBefore = countDestroyedGyro(def, dmgBefore, critBefore);
    const gyroNow = countDestroyedGyro(def, unit.damage, unit.critSlotsDestroyed);
    if (gyroNow < GYRO_DESTROYED_HITS && gyroBefore < 1 && gyroNow >= 1) {
      triggers.push({ reason: "gyro", modifier: GYRO_HIT_MOD });
    }
    for (const extra of extraTriggers?.[unit.id] ?? []) {
      triggers.push({ reason: extra.reason, modifier: extra.modifier });
    }
    let autoFall: { cause: UnitFallCause; seatbelt: number | null } | null = null;
    const legDestroyed =
      (legGone(unit.damage, "rightLeg") && !legGone(dmgBefore, "rightLeg")) ||
      (legGone(unit.damage, "leftLeg") && !legGone(dmgBefore, "leftLeg"));
    // The MechWarrior roll after an automatic fall carries every normal
    // modifier (TW p.69): preexisting damage (a destroyed leg replaces that
    // leg's other mods, +5), +1 for 20+ damage this phase, +6 for a destroyed
    // gyro (TW pp.60,122).
    const seatbeltNow = (): number =>
      preexistingDamageModifier(def, unit.damage, unit.critSlotsDestroyed).modifier +
      (taken >= PSR_DAMAGE_THRESHOLD ? PHASE_DAMAGE_PSR_MOD : 0) +
      (gyroNow >= GYRO_DESTROYED_HITS ? SEATBELT_GYRO_DESTROYED : 0);
    if (legDestroyed) autoFall = { cause: { kind: "legDestroyed" }, seatbelt: seatbeltNow() };
    else if (gyroNow >= GYRO_DESTROYED_HITS && gyroBefore < GYRO_DESTROYED_HITS)
      autoFall = { cause: { kind: "gyroDestroyed" }, seatbelt: seatbeltNow() };

    let fell = false;
    // TW p.59: every PSR triggered this phase carries the combined modifiers
    // of all the triggers, and an automatic fall (destroyed leg or gyro)
    // takes the place of the rolls altogether.
    const phaseModifier = triggers.reduce((sum, t) => sum + t.modifier, 0);
    for (const t of autoFall === null ? triggers : []) {
      const modifier = phaseModifier + pre.modifier;
      if (isHull(unit) || isShutdown(unit) || isPilotUnconscious(unit)) {
        // TW p.60: a PSR required of a shut-down 'Mech falls it automatically
        // (and the pilot takes the hit automatically). A hull never rolls:
        // it is permanently shut down.
        autoFall = { cause: { kind: "failedPsr", reason: t.reason }, seatbelt: null };
        break;
      }
      const r = pushPilotingCheck(sink, unit, t.reason, phaseModifier, pre.modifier, rng, {
        ...unit.position,
      });
      if (!r.success) {
        if (sparedDfa && unit.meleeCharge !== null) {
          unit.meleeCharge.missed = true;
          fell = true;
          break;
        }
        const terrain = cellAt(state, unit.position).terrain;
        const halved = terrain === "water2" || terrain === "water3";
        applyFall(
          state,
          unit,
          rng,
          {
            cause: { kind: "failedPsr", reason: t.reason },
            hex: unit.position,
            seatbeltModifier: modifier,
            halved,
          },
          sink,
        );
        fell = true;
        break;
      }
    }
    if (sparedDfa && !fell && autoFall !== null && unit.meleeCharge !== null) {
      unit.meleeCharge.missed = true;
      autoFall = null;
    }
    if (!fell && autoFall !== null) {
      const terrain = cellAt(state, unit.position).terrain;
      const halved = terrain === "water2" || terrain === "water3";
      applyFall(
        state,
        unit,
        rng,
        {
          cause: autoFall.cause,
          hex: unit.position,
          seatbeltModifier: autoFall.seatbelt,
          halved,
        },
        sink,
      );
    }
  }
}
