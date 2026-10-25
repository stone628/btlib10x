import { D2D6_MAX, roll2D6 } from "../../core/dice";
import { cellAt, waterDepth } from "../../core/terrain";
import type { Rng } from "../../core/types";
import { mechDefFor } from "../../data/index";
import {
  applyAmmoExplosion,
  type CriticalResolution,
  cloneCritTable,
  countDestroyedEngine,
  countDestroyedLifeSupport,
  critDamageDealt,
  destroyAmmoBin,
  markLocationCatastrophicallyDestroyed,
  resolveCriticalHits,
} from "../critical";
import { dealtOf, structureStruck } from "../damage";
import {
  ammoExplosionAvoidWithThreshold,
  engineHitHeat,
  heatDissipation,
  heatDissipationMax,
  largestAmmoBin,
  outsideHeatApplied,
  shutdownAvoidWithThreshold,
  waterHeatBonus,
} from "../heat";
import { isPilotUnconscious } from "../pilot";
import { consciousnessTarget, rollConsciousness } from "../piloting";
import { enforceClubHandsAll, recordCritSeveredLimbs, recordSeveredLimbs } from "./clubs";
import { awaitsDestroyedMark, destroyedReasonFor, isUnitWrecked } from "./condition";
import {
  applyPilotHits,
  blastApplication,
  isCritBlastRow,
  markUnitDestroyed,
  resolveCenterTorsoBlast,
  shutdownFallCheck,
} from "./consequences";
import {
  AIR_SUPPLY_PILOT_HITS,
  AMMO_BLAST_PILOT_HITS,
  LIFE_SUPPORT_HEAT_1HIT,
  LIFE_SUPPORT_HEAT_2HITS,
} from "./constants";
import { creditDealt } from "./ledger";
import { resolvePhasePiloting } from "./pilotingPhase";
import { isNominal, isUnitRemoved } from "./queries";
import type { BattleState, GameEvent, PhaseSnapshots } from "./types";

/**
 * Life support also carries the internal air supply (TW p.127): a 'Mech with
 * destroyed life support that is submerged in the End Phase (depth 2+ water,
 * or prone in depth 1+) deals its MechWarrior 1 hit. Separate from the
 * heat-phase life-support hits. Runs on the final positions and postures of
 * the turn.
 */
export function resolveAirSupply(state: BattleState, rng: Rng, sink: GameEvent[]): void {
  for (const unit of Object.values(state.units)) {
    if (isUnitRemoved(unit)) continue;
    if (countDestroyedLifeSupport(mechDefFor(unit), unit.damage, unit.critSlotsDestroyed) === 0) {
      continue;
    }
    const depth = waterDepth(cellAt(state, unit.position).terrain);
    if (depth >= 2 || (depth >= 1 && unit.prone)) {
      applyPilotHits(state, unit, AIR_SUPPLY_PILOT_HITS, "lifeSupport", rng, sink);
    }
  }
}

/**
 * Run one turn's heat resolution as the weapon attack phase hands off to the
 * end phase. TW p.159 reads the heat scale update as a single step:
 * "add own heat + outside heat, subtract heat sink dissipation, apply the net
 * result to the Heat Scale." Movement, weapon, posture, and engine-crit heat
 * were all accumulated into `unit.heatPending` during their producing
 * phases; here we land them on the scale, subtract dissipation, then run the
 * shutdown/restart and ammo-explosion checks against `endHeat`
 * (the post-dissipation Heat Scale per TW p.159 net update). Peak
 * within the heat phase has no separate meaning; start-of-turn heat was
 * already checked last turn.
 *
 * Engine crit heat is skipped for any non-online unit (TW p.160: "even
 * engine criticals generate no extra heat while shut down"), bundled with
 * the rest of the deferred own-heat.
 *
 * Shutdown / restart uses `roll >= avoid` for success (matches the
 * voluntary startup and ammo-explosion checks; previously the involuntary
 * branch used `roll <= avoid = fail`, an off-by-one).
 */
export function resolveHeatPhase(state: BattleState, rng: Rng, sink: GameEvent[]): void {
  // Outside heat on units that left play goes nowhere.
  for (const unit of Object.values(state.units)) {
    if (isUnitRemoved(unit)) unit.heatExternalPending = 0;
  }
  const units = Object.values(state.units).filter((u) => !isUnitRemoved(u));
  // The heat phase is one damage window (heat ammo-explosion blasts, their
  // crit cascades, and shutdown falls); each unit enters its scope as it is
  // snapshotted below.
  const before: PhaseSnapshots = { damage: {}, crit: {} };
  state.currentDealt = { before, total: {}, byAttacker: {} };

  // Single pass: snapshot pre-heat-phase state, then for each unit apply
  // deferred own-heat, dissipate, run shutdown/restart, run ammo explosion,
  // apply life-support pilot damage, attempt consciousness wakeup. Per-unit
  // mutations are isolated; cross-iteration state is only `before`, captured
  // here and consumed by `resolvePhasePiloting` after the loop.
  for (const unit of units) {
    // Snapshot pre-heat-phase damage/crit for `resolvePhasePiloting` diff.
    before.damage[unit.id] = {
      armor: { ...unit.damage.armor },
      armorRear: { ...unit.damage.armorRear },
      internalStructure: { ...unit.damage.internalStructure },
    };
    before.crit[unit.id] = cloneCritTable(unit.critSlotsDestroyed);

    const def = mechDefFor(unit);
    const startHeat = unit.heat;
    const heatPending = unit.heatPending;

    // Apply deferred own-heat: movement + weapon + posture + engine crit
    // (engine crit only if online per TW p.160). Reset pending; the
    // post-own-heat read is the scale value dissipation will subtract from.
    const engineHeat = isNominal(unit)
      ? engineHitHeat(countDestroyedEngine(def, unit.damage, unit.critSlotsDestroyed))
      : 0;
    const totalGenerated = heatPending + engineHeat;
    if (totalGenerated > 0) {
      // TW p. 159: no upper clamp — heat above 30 tracks unbounded in the
      // overflow box and dissipates over later turns. Clamping here would
      // discard heat before the sinks below ever see it.
      unit.heat = unit.heat + totalGenerated;
      if (engineHeat > 0) {
        sink.push({
          kind: "heatEngineCrit",
          unitId: unit.id,
          heat: engineHeat,
          base: startHeat,
          totalGenerated,
        });
      }
    }
    unit.heatPending = 0;

    // Outside heat (TW p.159): tallied apart from own heat, capped at 15 per
    // turn, then added to the scale alongside it, shut down or not.
    const received = unit.heatExternalPending;
    const applied = outsideHeatApplied(received);
    if (received > 0) {
      unit.heat += applied;
      sink.push({
        kind: "heatExternal",
        unitId: unit.id,
        received,
        applied,
        wasted: received - applied,
      });
    }
    unit.heatExternalPending = 0;

    // Dissipate (TW p.159 net update; applies to all units including
    // shut-down — heat sinks keep working).
    const terrainHere = cellAt(state, unit.position).terrain;
    const capacity =
      heatDissipation(def, unit.damage, unit.critSlotsDestroyed) +
      waterHeatBonus(
        def,
        unit.damage,
        unit.critSlotsDestroyed,
        waterDepth(terrainHere),
        unit.prone,
      );
    const capacityMax = heatDissipationMax(def);
    const dissipated = Math.min(capacity, unit.heat);
    const endHeat = unit.heat - dissipated;
    unit.heat = endHeat;
    if (dissipated > 0 || totalGenerated > 0 || applied > 0) {
      sink.push({
        kind: "heatDissipated",
        unitId: unit.id,
        dissip: dissipated,
        startHeat,
        totalGenerated,
        external: applied,
        endHeat,
        netChange: endHeat - startHeat,
        capacity,
        capacityMax,
      });
    }

    // Shutdown / restart at `endHeat`. A voluntary "manual" shutdown skips
    // it (restart only through `attemptVoluntaryStartup`).
    if (unit.shutdown !== "manual") {
      const { avoid, threshold } = shutdownAvoidWithThreshold(endHeat);
      if (unit.shutdown === "heat") {
        // Already heat-shut-down: restart path.
        if (avoid === 0) {
          unit.shutdown = "not";
          sink.push({
            kind: "restartCheck",
            unitId: unit.id,
            result: "success",
            manual: false,
            roll: 0,
            heat: endHeat,
            avoid: 0,
            threshold,
          });
        } else if (avoid > D2D6_MAX) {
          // p.159-160: no restart at 30+ heat
          sink.push({
            kind: "restartCheck",
            unitId: unit.id,
            result: "heat",
            manual: false,
            roll: 0,
            heat: endHeat,
            avoid,
            threshold,
          });
        } else if (isPilotUnconscious(unit)) {
          // an unconscious pilot cannot attempt one (only the below-14 automatic restart works).
          sink.push({
            kind: "restartCheck",
            unitId: unit.id,
            result: "unconscious",
            manual: false,
            roll: 0,
            heat: endHeat,
            avoid,
            threshold,
          });
        } else {
          const roll = roll2D6(rng);
          if (roll >= avoid) {
            unit.shutdown = "not";
            sink.push({
              kind: "restartCheck",
              unitId: unit.id,
              result: "success",
              manual: false,
              roll,
              heat: endHeat,
              avoid,
              threshold,
            });
          } else {
            sink.push({
              kind: "restartCheck",
              unitId: unit.id,
              result: "fail",
              manual: false,
              roll,
              heat: endHeat,
              avoid,
              threshold,
            });
          }
        }
      } else if (avoid > 0) {
        // Online unit — initial check.
        if (avoid > D2D6_MAX) {
          // 30+ heat: auto-shutdown (TW p.160 "Shutdown cannot be avoided at 30+ heat")
          unit.shutdown = "heat";
          sink.push({
            kind: "shutdownCheck",
            unitId: unit.id,
            result: "heat",
            manual: false,
            roll: 0,
            heat: endHeat,
            avoid,
            threshold,
          });
          shutdownFallCheck(state, unit, rng, sink);
        } else if (isPilotUnconscious(unit)) {
          // an unconscious pilot cannot override it either.
          unit.shutdown = "heat";
          sink.push({
            kind: "shutdownCheck",
            unitId: unit.id,
            result: "unconscious",
            manual: false,
            roll: 0,
            heat: endHeat,
            avoid,
            threshold,
          });
          shutdownFallCheck(state, unit, rng, sink);
        } else {
          const roll = roll2D6(rng);
          if (roll >= avoid) {
            sink.push({
              kind: "shutdownCheck",
              unitId: unit.id,
              result: "avoid",
              manual: false,
              roll,
              heat: endHeat,
              avoid,
              threshold,
            });
          } else {
            unit.shutdown = "heat";
            sink.push({
              kind: "shutdownCheck",
              unitId: unit.id,
              result: "shutdown",
              manual: false,
              roll,
              heat: endHeat,
              avoid,
              threshold,
            });
            shutdownFallCheck(state, unit, rng, sink);
          }
        }
      }
    }

    // Heat ammo explosion at the same endHeat. Largest loaded explosive
    // bin; on avoidance fail it detonates against the bin's location with
    // CASE-aware damage transfer.
    if (!isUnitRemoved(unit)) {
      const { avoid, threshold } = ammoExplosionAvoidWithThreshold(endHeat)!;
      if (avoid > 0) {
        const bin = largestAmmoBin(def, unit, rng);
        if (bin !== null) {
          const roll = roll2D6(rng);
          if (roll >= avoid) {
            sink.push({
              kind: "ammoExplosionCheck",
              unitId: unit.id,
              weapon: bin.weapon,
              location: bin.location,
              slotIndex: bin.slotIndex,
              roll,
              heat: endHeat,
              avoid,
              threshold,
              shotsRemaining: bin.shotsRemaining,
              damage: bin.damage,
              damagePerShot: bin.damagePerShot,
              avoided: true,
            });
          } else {
            const application = applyAmmoExplosion(unit.damage, def, bin.location, bin.damage);
            unit.damage = application.after;
            creditDealt(state, unit, null, dealtOf(application));
            // A blast that shears off a limb leaves it in the hex (TW p.146).
            recordSeveredLimbs(state, unit, application.blownOffLimbs);
            // The blasted bin is destroyed first (slot flagged, emptied), as
            // a crit on it would, so the follow-up criticals cannot re-hit or
            // re-explode it.
            unit.critSlotsDestroyed = destroyAmmoBin(unit.critSlotsDestroyed, unit.ammoBins, {
              id: bin.binId,
              location: bin.location,
              slotIndex: bin.slotIndex,
            });
            // Like any ammo explosion, the blast damages internal structure,
            // so each struck location gets a critical roll (TW p.125).
            const heatCrits: CriticalResolution[] = [];
            if (!state.critsDisabled) {
              for (const critLoc of structureStruck(application)) {
                const res = resolveCriticalHits({
                  rng,
                  model: unit.model,
                  source: { location: critLoc, damage: bin.damage, struck: true },
                  critSlotsDestroyed: unit.critSlotsDestroyed,
                  damage: unit.damage,
                  ammoBins: unit.ammoBins,
                });
                unit.critSlotsDestroyed = res.critSlotsDestroyed;
                unit.ammoBins = res.ammoBins;
                unit.damage = res.damage;
                creditDealt(state, unit, null, critDamageDealt(res));
                heatCrits.push(res);
              }
              recordCritSeveredLimbs(state, unit, heatCrits);
            }
            // Mark every freshly-zeroed location as catastrophic so
            // counters (`countDestroyedEngine`, `heatSinksOperational`,
            // `effectiveMovement`) report truthful destruction state for
            // the rest of the phase. An arm blown off with its torso keeps
            // its slots (see `detonateCritBlast`).
            for (const lost of application.newlyDestroyed) {
              if (application.blownOffLimbs.some((arm) => arm === lost)) continue;
              markLocationCatastrophicallyDestroyed(
                def,
                unit.damage,
                unit.critSlotsDestroyed,
                lost,
              );
            }
            sink.push({
              kind: "ammoExplosionCheck",
              unitId: unit.id,
              weapon: bin.weapon,
              location: bin.location,
              slotIndex: bin.slotIndex,
              roll,
              heat: endHeat,
              avoid,
              threshold,
              shotsRemaining: bin.shotsRemaining,
              damage: bin.damage,
              damagePerShot: bin.damagePerShot,
              avoided: false,
              crits: heatCrits,
            });
            const chained = heatCrits.flatMap((c) => c.rows.filter(isCritBlastRow));
            resolveCenterTorsoBlast(
              state,
              unit,
              [application, ...chained.map(blastApplication)],
              rng,
              sink,
            );
            // TW p.160: ammo explosion auto-deals 2 pilot hits and a
            // Consciousness Roll per hit. Apply before the destroyed check
            // so a pilot killed by the explosion is removed as "pilotKilled";
            // the check below still records the explosion's structural kill
            // in `destroyed`.
            applyPilotHits(
              state,
              unit,
              AMMO_BLAST_PILOT_HITS * (1 + chained.length),
              "ammoExplosion",
              rng,
              sink,
            );
            if (
              awaitsDestroyedMark(unit) &&
              (isUnitWrecked(unit) || heatCrits.some((c) => c.killedReason !== null))
            ) {
              markUnitDestroyed(state, unit, destroyedReasonFor(unit.damage, heatCrits), rng, sink);
            }
          }
        }
      }
    }

    // Life-support pilot damage (TW p.41): 1 hit at end-of-phase heat 15+,
    // 2 hits at 26+. Skip if ammo explosion just removed the unit.
    if (!isUnitRemoved(unit)) {
      if (countDestroyedLifeSupport(def, unit.damage, unit.critSlotsDestroyed) > 0) {
        if (unit.heat >= LIFE_SUPPORT_HEAT_2HITS)
          applyPilotHits(state, unit, 2, "lifeSupport", rng, sink);
        else if (unit.heat >= LIFE_SUPPORT_HEAT_1HIT)
          applyPilotHits(state, unit, 1, "lifeSupport", rng, sink);
      }
    }

    // Consciousness wakeup (TW p.42): end phase of a turn after the
    // knockout turn. A passed roll clears `unconsciousSinceTurn`.
    if (
      !isUnitRemoved(unit) &&
      unit.unconsciousSinceTurn !== null &&
      unit.unconsciousSinceTurn < state.turn
    ) {
      const target = consciousnessTarget(unit.pilotHits, unit.pilotHitMax);
      if (target !== null) {
        const { roll, success } = rollConsciousness(rng, target);
        if (success) {
          unit.unconsciousSinceTurn = null;
        }
        sink.push({
          kind: "consciousnessCheck",
          unitId: unit.id,
          cause: "recovery",
          rolls: [{ roll, target, hits: unit.pilotHits }],
          required: 1,
          failedAt: success ? null : 1,
          success,
          consciousBefore: false,
        });
      }
    }
  }

  // End-of-heat-phase piloting: falls from heat-phase ammo-explosion damage.
  resolvePhasePiloting(state, rng, sink);
  enforceClubHandsAll(state, sink);
}
