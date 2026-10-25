import { D2D6_MAX, roll2D6, rollD6 } from "../../core/dice";
import { neighbor } from "../../core/hex";
import { cellAt, waterDepth } from "../../core/terrain";
import {
  type HexCoord,
  hexKey,
  type LimbLocation,
  oppositeFacing,
  type Rng,
} from "../../core/types";
import { mechDefFor } from "../../data/index";
import type { Arc } from "../arcs";
import { DEFAULT_BUILDING_LEVELS } from "../building";
import {
  type CriticalEffect,
  type CriticalResolution,
  cloneCritTable,
  critDamageDealt,
  isCockpitDestroyed,
  resolveCriticalHits,
} from "../critical";
import {
  applyDamage,
  type DamageApplication,
  dealtOf,
  isUnitImmobile,
  structureStruck,
} from "../damage";
import { hitLocationForArc, punchHitLocation } from "../hitlocation";
import { internalStructureForTonnage } from "../internalStructure";
import type { DamageGroup } from "../physical";
import { isPilotUnconscious } from "../pilot";
import {
  consciousnessTarget,
  ejectionDamage,
  ejectionModifier,
  facingAfterFall,
  fallingDamageGroups,
  fallingDamageTotal,
  type PilotingRollResult,
  preexistingDamageModifier,
  rollConsciousness,
  rollFallDirection,
  rollPilotingCheck,
} from "../piloting";
import { collapseDamageTotal, damageBuildingAt } from "./buildings";
import { enforceClubHands, recordCritSeveredLimbs, recordSeveredLimbs, releaseClub } from "./clubs";
import { awaitsDestroyedMark, destroyedReasonFor, isUnitWrecked } from "./condition";
import {
  BUILDING_UNIT_DAMAGE_DIVISOR,
  FALL_PILOT_HITS,
  HEAD_HIT_PILOT_HITS,
  SEATBELT_PRE_MOD,
  SHUTDOWN_PSR_MOD,
  WRECKAGE_TONNAGE_MIN,
} from "./constants";
import { creditDealt, killCredit } from "./ledger";
import {
  isHull,
  isShutdown,
  isUnitOnBoard,
  isUnitRemoved,
  requireUnit,
  unitTonnage,
} from "./queries";
import type {
  BattleState,
  BuildingDamageResult,
  ConsciousnessRoll,
  DestroyedReason,
  FallOptions,
  GameEvent,
  PilotHitReason,
  PilotingCheckReason,
  UnitState,
} from "./types";

/** Raise the pilot's hits to `to` at kill time (head loss, cockpit hit, CT
 *  blast) and emit the matching `pilotDamaged`. No consciousness roll: the
 *  pilot is dying, or the ejection roll decides. No-op when already there. */
export function raisePilotHits(
  unit: UnitState,
  to: number,
  reason: PilotHitReason,
  sink: GameEvent[],
): void {
  if (to <= unit.pilotHits) return;
  const hits = to - unit.pilotHits;
  unit.pilotHits = to;
  sink.push({
    kind: "pilotDamaged",
    unitId: unit.id,
    reason,
    hits,
    totalHits: unit.pilotHits,
    hpRemaining: Math.max(0, unit.pilotHitMax - unit.pilotHits),
  });
}

export function markUnitDestroyed(
  state: BattleState,
  unit: UnitState,
  reason: DestroyedReason,
  rng: Rng,
  sink: GameEvent[],
  pilotDies = false,
): void {
  if (isHull(unit)) {
    const standing = !unit.prone;
    unit.destroyed = reason;
    sink.push({
      kind: "unitRemoved",
      unitId: unit.id,
      reason: "destroyed",
      destroyReason: reason,
      credit: [],
    });
    leaveDestroyedRemains(state, unit, rng, sink, standing);
    return;
  }
  if (isUnitRemoved(unit)) return;
  // The pilot's fate reads the frame, not `reason` (DMG-08): a kill crit
  // resolved first (third engine slot) must not hide a lost head or cockpit.
  const cockpit = reason === "cockpitDestroyed" || isCockpitKilled(unit);
  const headLoss = !cockpit && unit.damage.internalStructure.head <= 0;
  // TO p.165: head destruction auto-ejects the pilot (cockpit crits still kill),
  // brought one hit short of death so the ejection roll decides survival.
  if (headLoss && unit.autoEject) {
    raisePilotHits(unit, unit.pilotHitMax - 1, "headLoss", sink);
    // Keep the cause of the loss: the ejection itself only marks `removed`.
    unit.destroyed = reason;
    resolveEjection(state, unit, rng, sink, "auto");
    return;
  }
  const standing = !unit.prone;
  releaseClub(state, unit, "removed", sink);
  unit.destroyed = reason;
  unit.removed = "destroyed";
  // TW p.128: the MechWarrior dies on loss of the head or cockpit (head loss
  // only reaches here with auto-eject off) or a CT lost to a blast without
  // auto-eject; any other destruction (engine, CT) leaves the pilot alive.
  if (cockpit || headLoss || pilotDies) {
    const why = cockpit ? "cockpitHit" : headLoss ? "headLoss" : "ctBlast";
    raisePilotHits(unit, unit.pilotHitMax, why, sink);
  }
  sink.push({
    kind: "unitRemoved",
    unitId: unit.id,
    reason: "destroyed",
    destroyReason: reason,
    credit: killCredit(state, unit),
  });
  leaveDestroyedRemains(state, unit, rng, sink, standing);
}

/**
 * What a destroyed frame leaves behind. The unit's record and damage stay in
 * `state.units` for salvage reading.
 *  - Salvage fall (TW p.128): a 'Mech that was standing when destroyed falls
 *    automatically; the falling damage (and its criticals) marks its record,
 *    and a MechWarrior still alive in the cockpit takes the fall's pilot
 *    hit and its consciousness roll. An ejected pilot (auto-eject at this destruction, or a hull's pilot
 *    who left earlier) is outside the 'Mech and takes none.
 *  - Wreckage (TO:AR p.155): a 'Mech of {@link WRECKAGE_TONNAGE_MIN} t or
 *    more turns its hex into Rough (`state.wreckage`); a hex already holding
 *    wreckage just records the extra id (no pile-up).
 * `standing` is the posture before the destruction.
 */
export function leaveDestroyedRemains(
  state: BattleState,
  unit: UnitState,
  rng: Rng,
  sink: GameEvent[],
  standing: boolean,
): void {
  if (standing) salvageFall(state, unit, rng, sink);
  if (unitTonnage(unit) >= WRECKAGE_TONNAGE_MIN) {
    const key = hexKey(unit.position);
    state.wreckage[key] = [...(state.wreckage[key] ?? []), { model: unit.model, unitId: unit.id }];
    sink.push({
      kind: "wreckageLeft",
      unitId: unit.id,
      col: unit.position.col,
      row: unit.position.row,
    });
  }
}

/** Salvage fall (TW p.128): normal falling damage on the destroyed record,
 *  with criticals for struck structure (their blasts only mark the record).
 *  Severed limbs drop in the hex. A pilot still in the cockpit (`removed`
 *  is `"destroyed"`), if alive, takes the fall's hit automatically (no
 *  seatbelt roll for a dead 'Mech) and, surviving it, a consciousness roll
 *  (TW p.41-42, SALV-09): the outcome only marks the pilot record, since
 *  the MechWarrior is out of the battle. A pilot who ejected or abandoned
 *  is outside the 'Mech and takes none, as in `applyFall`. */
export function salvageFall(
  state: BattleState,
  unit: UnitState,
  rng: Rng,
  sink: GameEvent[],
): void {
  const def = mechDefFor(unit);
  const dir = rollFallDirection(rng);
  unit.facing = facingAfterFall(unit.facing, dir.shift);
  unit.prone = true;
  const terrain = cellAt(state, unit.position).terrain;
  let total = fallingDamageTotal(def.tonnage, 0);
  if (terrain === "water2" || terrain === "water3") total = Math.floor(total / 2);
  const groups: DamageGroup[] = [];
  for (const amount of fallingDamageGroups(total)) {
    const roll = roll2D6(rng);
    groups.push({
      location: hitLocationForArc(dir.column, roll),
      damage: amount,
      ...(roll === 2 ? { tac: true as const } : {}),
    });
  }
  const arc: Arc = dir.column === "rear" ? "rear" : "front";
  const crits: CriticalResolution[] = [];
  const sheared: LimbLocation[] = [];
  // Phase-start crit table for transfer (TW p.125), as in `applyDamageGroups`.
  const baseCrit =
    state.currentDealt?.before.crit[unit.id] ?? cloneCritTable(unit.critSlotsDestroyed);
  for (const group of groups) {
    const app = applyDamage(unit.damage, group.location, group.damage, arc);
    unit.damage = app.after;
    sheared.push(...app.blownOffLimbs);
    if (state.critsDisabled) continue;
    const struck = structureStruck(app);
    const critRolls = struck.map((location) => ({ location, tac: false }));
    if (group.tac === true && group.damage >= 1) {
      critRolls.push({ location: group.location, tac: true });
    }
    for (const { location, tac } of critRolls) {
      const res = resolveCriticalHits({
        rng,
        model: unit.model,
        source: { location, damage: group.damage, struck: struck.includes(location), tac },
        baseCritSlotsDestroyed: baseCrit,
        critSlotsDestroyed: unit.critSlotsDestroyed,
        damage: unit.damage,
        ammoBins: unit.ammoBins,
      });
      unit.critSlotsDestroyed = res.critSlotsDestroyed;
      unit.ammoBins = res.ammoBins;
      unit.damage = res.damage;
      crits.push(res);
    }
  }
  recordCritSeveredLimbs(state, unit, crits);
  recordSeveredLimbs(state, unit, sheared);
  sink.push({
    kind: "unitFell",
    unitId: unit.id,
    cause: { kind: "salvageFall" },
    hex: unit.position,
    facingAfter: unit.facing,
    fallRoll: dir.roll,
    column: dir.column,
    levelsFallen: 0,
    groups,
    crits,
  });
  if (unit.removed === "destroyed" && unit.pilotHits < unit.pilotHitMax) {
    unit.pilotHits += FALL_PILOT_HITS;
    sink.push({
      kind: "pilotDamaged",
      unitId: unit.id,
      reason: "fall",
      hits: FALL_PILOT_HITS,
      totalHits: unit.pilotHits,
      hpRemaining: Math.max(0, unit.pilotHitMax - unit.pilotHits),
    });
    salvageFallConsciousness(state, unit, rng, sink);
  }
}

/** Consciousness roll for the salvage fall's pilot hit (TW p.41-42).
 *  `applyPilotHits` ends bookkeeping for a destroyed unit, so the roll is
 *  made here. A killing hit (`consciousnessTarget` null) or a pilot
 *  already out takes no roll. */
export function salvageFallConsciousness(
  state: BattleState,
  unit: UnitState,
  rng: Rng,
  sink: GameEvent[],
): void {
  if (isPilotUnconscious(unit)) return;
  const target = consciousnessTarget(unit.pilotHits, unit.pilotHitMax);
  if (target === null) return;
  const { roll, success } = rollConsciousness(rng, target);
  if (!success) unit.unconsciousSinceTurn = state.turn;
  sink.push({
    kind: "consciousnessCheck",
    unitId: unit.id,
    cause: "fall",
    rolls: [{ roll, target, hits: unit.pilotHits }],
    required: 1,
    failedAt: success ? null : 1,
    success,
    consciousBefore: true,
  });
}

/** Turn an active unit whose pilot is gone into a hull (`isHull`): it
 *  keeps its record, team, posture and hex, drops any club, and acts no
 *  more. Emits `unitRemoved` with `reason`, plus `destroyReason` when the
 *  frame is already destroyed (auto-eject from a destroyed 'Mech). */
export function leaveHull(
  state: BattleState,
  unit: UnitState,
  reason: "pilotEjected" | "pilotKilled" | "pilotAbandoned",
  sink: GameEvent[],
): void {
  releaseClub(state, unit, "removed", sink);
  unit.removed = reason;
  sink.push({
    kind: "unitRemoved",
    unitId: unit.id,
    reason,
    ...(unit.destroyed !== "not" ? { destroyReason: unit.destroyed } : {}),
    credit: killCredit(state, unit),
  });
}

/** A pilot killed by six accumulated pilot hits removes the unit from play
 *  without destroying the 'Mech (TW p.41-42: the pilot is dead): the frame
 *  stays as a hull. If damage in the same step also destroyed the frame, the
 *  destruction sweep then turns the hull into wreckage. Emits a single
 *  `unitRemoved` event with reason "pilotKilled". */
export function removePilotKilled(state: BattleState, unit: UnitState, sink: GameEvent[]): void {
  if (isUnitRemoved(unit)) return;
  leaveHull(state, unit, "pilotKilled", sink);
}

/** True when a crit row detonated a blast: an ammo explosion, or a
 *  Gauss/HAG weapon-crit carrying `explosion` (TW p.135-136, handled like
 *  an ammo explosion). Pilot hits, damage replay, and cascade accounting
 *  all key off this predicate. */
export function isCritBlastRow(row: CriticalEffect): boolean {
  if (row.kind === "ammoExplosion") return true;
  return row.kind === "weaponDestroyed" && row.explosion !== undefined;
}

/** The damage application of a blast row (ammo explosion, or Gauss/HAG
 *  weapon-crit explosion), or undefined for any other row. */
export function blastApplication(row: CriticalEffect): DamageApplication | undefined {
  if (row.kind === "ammoExplosion") return row.application;
  if (row.kind === "weaponDestroyed") return row.explosion?.application;
  return undefined;
}

/** An ammo/weapon explosion (TW p. 98: weapon blasts are handled like ammo)
 *  that destroys the center torso, directly or via transfer. With auto-eject
 *  on (TO:AR p. 165) the pilot ejects before the damage resolves; the ejection
 *  PSR may still injure the pilot, and the blast's own pilot hits are applied
 *  by the caller afterwards. With auto-eject off the MechWarrior dies with the
 *  'Mech (TW p. 128). Any other destruction leaves the pilot inside the 'Mech. */
export function resolveCenterTorsoBlast(
  state: BattleState,
  unit: UnitState,
  applications: readonly (DamageApplication | undefined)[],
  rng: Rng,
  sink: GameEvent[],
): void {
  // A hull has nobody to eject: the destruction sweep records the loss.
  if (isUnitRemoved(unit)) return;
  if (!applications.some((a) => a?.newlyDestroyed.includes("centerTorso"))) return;
  // A destroyed cockpit kills even with auto-eject armed (TO:AR p.165).
  if (!unit.autoEject || isCockpitKilled(unit)) {
    markUnitDestroyed(state, unit, "centerTorsoDestroyed", rng, sink, true);
    return;
  }
  // The head lost in the same step: brought to one hit short of death
  // "regardless of prior condition" (TO:AR p.165), the blast's feedback
  // folded in (see `applyPilotHits`).
  if (unit.damage.internalStructure.head <= 0) {
    raisePilotHits(unit, unit.pilotHitMax - 1, "headLoss", sink);
  }
  unit.destroyed = "centerTorsoDestroyed";
  resolveEjection(state, unit, rng, sink, "auto");
}

/** A cockpit slot is destroyed: the MechWarrior dies, no ejection (TW p.125). */
export function isCockpitKilled(unit: UnitState): boolean {
  return isCockpitDestroyed(mechDefFor(unit), unit.critSlotsDestroyed);
}

/** Head lost with auto-eject armed and the cockpit intact: the destruction
 *  mark ejects the pilot at one hit short of death "regardless of prior
 *  condition" (TO:AR p.165), so the pilot hits of the same step fold into
 *  that total instead of landing first. */
export function headLossWillEject(unit: UnitState): boolean {
  return (
    !isUnitRemoved(unit) &&
    unit.autoEject &&
    unit.damage.internalStructure.head <= 0 &&
    !isCockpitKilled(unit)
  );
}

/**
 * Emit one `pilotingCheck` event carrying the PSR components. The UI
 * derives `modifier = triggerModifier + preexistingModifier` and
 * `target = basePiloting + modifier`; the roll outcome uses the same
 * values via `rollPilotingCheck`, so the log math always matches the
 * game logic.
 */
export function pushPilotingCheck(
  sink: GameEvent[],
  unit: UnitState,
  reason: PilotingCheckReason,
  triggerModifier: number,
  preexistingModifier: number,
  rng: Rng,
  hex?: HexCoord,
): PilotingRollResult {
  const r = rollPilotingCheck(rng, unit.piloting, triggerModifier + preexistingModifier);
  if (hex === undefined) {
    sink.push({
      kind: "pilotingCheck",
      unitId: unit.id,
      reason,
      basePiloting: unit.piloting,
      triggerModifier,
      preexistingModifier,
      roll: r.roll,
      success: r.success,
    });
  } else {
    sink.push({
      kind: "pilotingCheck",
      unitId: unit.id,
      reason,
      basePiloting: unit.piloting,
      triggerModifier,
      preexistingModifier,
      roll: r.roll,
      success: r.success,
      hex,
    });
  }
  return r;
}

/**
 * Deal `hits` pilot hits to `unit` (TW p.41-42): head hits, ammo explosions,
 * falls, and heat-soaked life support all land here. Every point forces a
 * consciousness roll (2D6 >= the table target) until one fails; once out,
 * no further rolls that turn. Six total hits kills the pilot and destroys
 * the unit. Emits one `pilotDamaged` for the whole call, then at most one
 * `consciousnessCheck` holding every roll made.
 */
export function applyPilotHits(
  state: BattleState,
  unit: UnitState,
  hits: number,
  reason: PilotHitReason,
  rng: Rng,
  sink: GameEvent[],
): void {
  // An ejected pilot still accrues hits from the ejection itself and, after
  // an auto-eject from a destroyed frame, the triggering blast; every other
  // removal ends pilot bookkeeping. A hull is empty: hits on it (head hits,
  // blasts, falls) reach no MechWarrior.
  if (isUnitRemoved(unit) && unit.removed !== "pilotEjected") return;
  if (isHull(unit) && reason !== "ejection") return;
  // Eject first (TO:AR p.165): an ejected pilot is no longer aboard, so hits
  // aboard (head hits, falls, life support) miss them; a head loss (about to
  // auto-eject or already ejected) folds the step's hits into its raised total.
  if (unit.removed === "pilotEjected" && reason !== "ejection") {
    // Blast feedback still reaches an ejected pilot, unless a head loss in
    // the same step already raised them to one short of death.
    if (reason !== "ammoExplosion" || unit.damage.internalStructure.head <= 0) return;
  }
  if (headLossWillEject(unit)) return;
  const wasConscious = !isPilotUnconscious(unit);
  const rolls: ConsciousnessRoll[] = [];
  let failedAt: number | null = null;
  let applied = 0;
  let killed = false;
  for (let i = 0; i < hits && unit.pilotHits < unit.pilotHitMax; i++) {
    unit.pilotHits += 1;
    applied += 1;
    const target = consciousnessTarget(unit.pilotHits, unit.pilotHitMax);
    if (target === null) {
      killed = true;
      break;
    }
    // No further consciousness rolls once out this turn (TW p.42).
    if (isPilotUnconscious(unit)) continue;
    const { roll, success } = rollConsciousness(rng, target);
    rolls.push({ roll, target, hits: unit.pilotHits });
    if (!success) {
      failedAt = rolls.length;
      unit.unconsciousSinceTurn = state.turn;
    }
  }
  if (applied === 0) return;
  sink.push({
    kind: "pilotDamaged",
    unitId: unit.id,
    reason,
    hits: applied,
    totalHits: unit.pilotHits,
    hpRemaining: Math.max(0, unit.pilotHitMax - unit.pilotHits),
  });
  if (rolls.length > 0) {
    sink.push({
      kind: "consciousnessCheck",
      unitId: unit.id,
      cause: reason,
      rolls,
      required: applied - (killed ? 1 : 0),
      failedAt,
      success: failedAt === null,
      consciousBefore: wasConscious,
    });
  }
  if (killed) removePilotKilled(state, unit, sink);
}

/**
 * Apply pre-rolled damage groupings (falling, building crashes) with the
 * normal crit cascade per stripping group; ammo explosions injure the pilot
 * (2 hits each) and every damaging head grouping injures the pilot (1 hit
 * each, TW p.41, whatever the source). Returns the determining resolutions
 * plus emitted events.
 */
export function applyDamageGroups(
  state: BattleState,
  unit: UnitState,
  rng: Rng,
  groups: readonly DamageGroup[],
  arc: Arc,
  sink: GameEvent[],
  attackerId: string | null = null,
): CriticalResolution[] {
  const crits: CriticalResolution[] = [];
  const sheared: LimbLocation[] = [];
  // Transfer is judged against the location as it stood at the start of the
  // phase (TW p.125), as on the weapon/physical paths: the open damage
  // window's snapshot, or the table on entry when the unit is not in scope.
  // Without it a later group sees a location emptied by an earlier group of
  // the same fall and moves its critical inward instead of losing it.
  const baseCrit =
    state.currentDealt?.before.crit[unit.id] ?? cloneCritTable(unit.critSlotsDestroyed);
  for (const group of groups) {
    const app = applyDamage(unit.damage, group.location, group.damage, arc);
    unit.damage = app.after;
    creditDealt(state, unit, attackerId, dealtOf(app));
    sheared.push(...app.blownOffLimbs);
    if (!state.critsDisabled) {
      // One roll per location whose structure the group damaged (TW p.124),
      // plus one additional roll when the hit-location roll was a 2
      // (through-armor critical, TW p.124) — the attack must still do at
      // least 1 point. Mirrors the weapon/physical paths.
      const struck = structureStruck(app);
      const critRolls = struck.map((location) => ({ location, tac: false }));
      if (group.tac === true && group.damage >= 1) {
        critRolls.push({ location: group.location, tac: true });
      }
      for (const { location: critLoc, tac: tagThroughArmor } of critRolls) {
        const res = resolveCriticalHits({
          rng,
          model: unit.model,
          source: {
            location: critLoc,
            damage: group.damage,
            struck: struck.includes(critLoc),
            tac: tagThroughArmor,
          },
          baseCritSlotsDestroyed: baseCrit,
          critSlotsDestroyed: unit.critSlotsDestroyed,
          damage: unit.damage,
          ammoBins: unit.ammoBins,
        });
        unit.critSlotsDestroyed = res.critSlotsDestroyed;
        unit.ammoBins = res.ammoBins;
        unit.damage = res.damage;
        creditDealt(state, unit, attackerId, critDamageDealt(res));
        resolveCenterTorsoBlast(state, unit, res.rows.map(blastApplication), rng, sink);
        for (const row of res.rows) {
          if (isCritBlastRow(row)) applyPilotHits(state, unit, 2, "ammoExplosion", rng, sink);
        }
        crits.push(res);
      }
    }
  }
  // TW p.41: every damaging head grouping injures the pilot, whatever the
  // source (falls, collapse, crashes, accidental falls). Same predicate as
  // the weapon/physical paths; runs before the destruction sweep, matching
  // the weapon path ordering (a head loss about to auto-eject folds it into
  // the raised total, see `applyPilotHits`).
  const headGroups = groups.filter((g) => g.location === "head" && g.damage >= 1).length;
  if (headGroups > 0) {
    applyPilotHits(state, unit, headGroups * HEAD_HIT_PILOT_HITS, "headHit", rng, sink);
  }
  // Severed limbs stay where they were lost (TW p.146): record blow-offs
  // from fall/crash/collapse crits and leave the matching ground tokens.
  recordCritSeveredLimbs(state, unit, crits);
  recordSeveredLimbs(state, unit, sheared);
  enforceClubHands(state, unit, sink);
  if (
    awaitsDestroyedMark(unit) &&
    (isUnitWrecked(unit) || crits.some((c) => c.killedReason !== null))
  ) {
    markUnitDestroyed(state, unit, destroyedReasonFor(unit.damage, crits), rng, sink);
  }
  return crits;
}

/**
 * Immediate PSR when a unit's reactor shuts down (TW p.60, +3): rolled with
 * preexisting-damage modifiers even though the 'Mech is now down (only
 * *other* PSRs required while shut down fail automatically). Failure drops
 * the 'Mech on the spot; the pilot then takes the hit automatically via the
 * shutdown path in `applyFall`. No-op for removed or already-prone units.
 */
export function shutdownFallCheck(
  state: BattleState,
  unit: UnitState,
  rng: Rng,
  sink: GameEvent[],
): void {
  if (isUnitRemoved(unit) || unit.prone) return;
  const def = mechDefFor(unit);
  const pre = preexistingDamageModifier(def, unit.damage, unit.critSlotsDestroyed);
  // An unconscious pilot cannot roll and fails automatically (TW p.40).
  const r = isPilotUnconscious(unit)
    ? { success: false }
    : pushPilotingCheck(sink, unit, "shutdown", SHUTDOWN_PSR_MOD, pre.modifier, rng, {
        ...unit.position,
      });
  if (!r.success) {
    applyFall(
      state,
      unit,
      rng,
      {
        cause: { kind: "shutdown" },
        hex: unit.position,
        seatbeltModifier: null,
        halved: waterDepth(cellAt(state, unit.position).terrain) >= 2,
      },
      sink,
    );
  }
}

/**
 * Building collapse damage (TW pp. 176–177) for every occupant of a hex that
 * just collapsed: base damage (CF at the start of the phase / 10) plus base ×
 * levels above the unit, rounded up at the end. Split into 5-point groupings
 * plus a remainder, each to a different hit location: 'Mechs inside roll the
 * Front column of the Punch table. Units above Level 0 also take standard
 * falling damage. The engine tracks no multi-floor interiors, so every
 * occupant counts as ground-floor with DEFAULT_BUILDING_LEVELS above (TW
 * default Level 2, pp. 166–167). `preCf` (the CF before the collapsing
 * damage) stands in for the phase-start CF. A no-op for an outcome that did
 * not collapse.
 */
export function resolveBuildingCollapse(
  state: BattleState,
  outcome: BuildingDamageResult,
  rng: Rng,
  sink: GameEvent[],
): void {
  if (!outcome.collapsed) return;
  const total = collapseDamageTotal(outcome.preCf, DEFAULT_BUILDING_LEVELS);
  for (const unitId of outcome.occupants) {
    const unit = requireUnit(state, unitId);
    if (!isUnitOnBoard(unit)) continue;
    const groups: DamageGroup[] = [];
    for (const amount of fallingDamageGroups(total)) {
      groups.push({ location: punchHitLocation(rollD6(rng)), damage: amount });
    }
    applyDamageGroups(state, unit, rng, groups, "front", sink);
    for (const group of groups) {
      sink.push({
        kind: "collapseDamage",
        unitId,
        col: outcome.col,
        row: outcome.row,
        location: group.location,
        damage: group.damage,
      });
    }
    // TW p. 177: any unit above Level 0 (including the roof) also takes
    // standard falling damage on top of the collapse damage.
    const groundLevel = cellAt(state, { col: outcome.col, row: outcome.row }).level;
    if (groundLevel > 0 && isUnitOnBoard(unit)) {
      applyFall(
        state,
        unit,
        rng,
        {
          cause: { kind: "buildingCollapse" },
          hex: { col: outcome.col, row: outcome.row },
          seatbeltModifier: preexistingDamageModifier(
            mechDefFor(unit),
            unit.damage,
            unit.critSlotsDestroyed,
          ).modifier,
          halved: false,
          levelsFallen: groundLevel,
        },
        sink,
      );
    }
  }
}

/**
 * A 'Mech entering a building hex, or falling inside one, damages it by
 * ceil(tonnage / 10) (TW p.167). Damage from movement collapses the hex at
 * once (TW pp.167, 176), so collapse damage to every occupant resolves here.
 * During a move only the mover is in the window's scope, so other occupants
 * get no piloting sweep for damage taken during someone else's move (see
 * `creditDealt`). No-op when the hex holds no building.
 */
export function damageBuildingByUnit(
  state: BattleState,
  unit: UnitState,
  hex: HexCoord,
  rng: Rng,
  sink: GameEvent[],
): void {
  if (state.buildings[hexKey(hex)] === undefined) return;
  const damage = Math.ceil(unitTonnage(unit) / BUILDING_UNIT_DAMAGE_DIVISOR);
  const outcome = damageBuildingAt(state, hex, damage, sink);
  if (outcome === null) return;
  resolveBuildingCollapse(state, outcome, rng, sink);
}

/**
 * Drop `unit` to the ground (TW p.68): facing rotates per the Facing After
 * Fall roll, `ceil(tonnage / 10) x (levels fallen + 1)` damage lands in
 * 5-point clusters on the fall column (with crit rolls like any damage;
 * halved rounding down underwater), and the pilot makes a seatbelt PSR or
 * takes 1 hit. A no-op on an already-prone unit unless `allowProne` is set
 * (a failed stand-up crashes back down).
 */
export function applyFall(
  state: BattleState,
  unit: UnitState,
  rng: Rng,
  opts: FallOptions,
  sink: GameEvent[],
): void {
  if (!isUnitOnBoard(unit)) return;
  if (unit.prone && opts.allowProne !== true) return;
  const hull = isHull(unit);
  const def = mechDefFor(unit);
  const dir = rollFallDirection(rng);
  unit.facing = facingAfterFall(unit.facing, dir.shift);
  unit.prone = true;
  releaseClub(state, unit, "fall", sink);

  const levels = opts.levelsFallen ?? 0;
  let total = fallingDamageTotal(def.tonnage, levels);
  if (opts.bottomDepth !== undefined && opts.bottomDepth > 0) {
    total =
      Math.floor(total / 2) + Math.floor(fallingDamageTotal(def.tonnage, opts.bottomDepth) / 2);
  } else if (opts.halved) {
    total = Math.floor(total / 2);
  }
  const column = opts.rearHits === true ? "rear" : dir.column;
  const groups: DamageGroup[] = [];
  for (const amount of fallingDamageGroups(total)) {
    const roll = roll2D6(rng);
    groups.push({
      location: hitLocationForArc(column, roll),
      damage: amount,
      ...(roll === 2 ? { tac: true as const } : {}),
    });
  }
  const crits = applyDamageGroups(
    state,
    unit,
    rng,
    groups,
    column === "rear" ? "rear" : "front",
    sink,
  );
  sink.push({
    kind: "unitFell",
    unitId: unit.id,
    cause: opts.cause,
    ...(opts.hex === undefined ? {} : { hex: opts.hex }),
    facingAfter: unit.facing,
    fallRoll: dir.roll,
    column,
    levelsFallen: levels,
    groups,
    crits,
    ...(hull ? { hull: true as const } : {}),
  });

  // A 'Mech that falls inside a building hex damages it as though it had
  // entered the hex (TW p.167). A collapse fall lands in fresh rubble.
  if (opts.cause.kind !== "buildingCollapse") {
    damageBuildingByUnit(state, unit, opts.hex ?? unit.position, rng, sink);
  }

  // A pilot who ejected during the fall's damage (head destroyed) is no
  // longer aboard and takes no fall damage (TO:AR p.165); a hull has none.
  if (isUnitRemoved(unit)) return;

  // Seatbelt check (TW p.68): same modifiers as the failed roll, or automatic
  // pilot damage when the 'Mech is immobile or the TN exceeds 12.
  const down = isShutdown(unit) || isPilotUnconscious(unit) || isUnitImmobile(unit.damage);
  const modifier = opts.seatbeltModifier;
  if (modifier === null || down || unit.piloting + modifier > D2D6_MAX) {
    applyPilotHits(
      state,
      unit,
      FALL_PILOT_HITS,
      modifier === null ? "shutdownFall" : "fall",
      rng,
      sink,
    );
  } else {
    const r = pushPilotingCheck(sink, unit, "seatbelt", modifier, SEATBELT_PRE_MOD, rng, opts.hex);
    if (!r.success) applyPilotHits(state, unit, FALL_PILOT_HITS, "fall", rng, sink);
  }
  if (awaitsDestroyedMark(unit) && isUnitWrecked(unit)) {
    markUnitDestroyed(state, unit, destroyedReasonFor(unit.damage), rng, sink);
  }
}

/** Tactical Operations ejection: the pilot rolls a Piloting Skill Roll
 *  (Ejection Modifiers Table via `ejectionModifier`).
 *  A failure deals floor(margin of failure / 2) pilot hits with the usual
 *  consciousness rolls. Either way the pilot leaves the 'Mech (`removed =
 *  "pilotEjected"`, even if the failure damage reaches `pilotHitMax`; the sheet
 *  then shows HP 0). An intact frame stays as a hull in the posture it was
 *  left in; a frame the auto-eject fled (`destroyed` already set) leaves its
 *  destroyed remains. `pilotHits` is retained. */
export function resolveEjection(
  state: BattleState,
  unit: UnitState,
  rng: Rng,
  sink: GameEvent[],
  cause: "manual" | "auto",
): void {
  if (isUnitRemoved(unit)) return;
  const landing = cellAt(state, neighbor(unit.position, oppositeFacing(unit.facing)));
  const modifier = ejectionModifier({
    landingTerrain: landing.terrain,
    landingLevel: landing.level,
    prone: unit.prone,
    unconscious: isPilotUnconscious(unit),
    headStructureDamage:
      internalStructureForTonnage(unitTonnage(unit)).head - unit.damage.internalStructure.head,
    auto: cause === "auto",
  });
  const r = pushPilotingCheck(sink, unit, "ejection", modifier, 0, rng);
  const standing = !unit.prone;
  leaveHull(state, unit, "pilotEjected", sink);
  if (!r.success) {
    const damage = ejectionDamage(r);
    if (damage > 0) applyPilotHits(state, unit, damage, "ejection", rng, sink);
  }
  if (unit.destroyed !== "not") leaveDestroyedRemains(state, unit, rng, sink, standing);
  if (cause === "manual") state.actedThisPhase.push(unit.id);
}
