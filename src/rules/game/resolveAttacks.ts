import { bearingExact, sameHex } from "../../core/hex";
import { cellAt } from "../../core/terrain";
import { type HexCoord, hexKey, type LimbLocation, type Rng } from "../../core/types";
import { mechDefFor } from "../../data/index";
import { type Arc, classifyArcWithBoundary, defenderArcChoice } from "../arcs";
import {
  type CriticalResolution,
  type CritMask,
  cloneCritTable,
  critDamageDealt,
  resolveCriticalHits,
} from "../critical";
import {
  applyDamage,
  type DamageApplication,
  dealtOf,
  structureStruck,
  type UnitDamageState,
} from "../damage";
import {
  type DamageGroup,
  DFA_ATTACKER_PSR_MOD,
  DFA_MISS_LEVELS_FALLEN,
  isMeleeCharge,
  type PhysicalAttackDecl,
  type PhysicalResolution,
  resolvePhysicalAttack,
  validatePhysicalAttack,
} from "../physical";
import { isPilotUnconscious } from "../pilot";
import { preexistingDamageModifier } from "../piloting";
import { saveUnitState } from "../snapshot";
import { damageBuildingAt } from "./buildings";
import {
  enforceClubHandsAll,
  recordCritSeveredLimbs,
  recordSeveredLimbs,
  resolveClubPickup,
} from "./clubs";
import { awaitsDestroyedMark, destroyedReasonFor, isUnitWrecked } from "./condition";
import {
  applyFall,
  applyPilotHits,
  blastApplication,
  isCritBlastRow,
  markUnitDestroyed,
  resolveBuildingCollapse,
  resolveCenterTorsoBlast,
} from "./consequences";
import { AMMO_BLAST_PILOT_HITS, HEAD_HIT_PILOT_HITS } from "./constants";
import { creditDealt } from "./ledger";
import { prepareMissileDefense } from "./missileDefense";
import { resolvePhasePiloting } from "./pilotingPhase";
import {
  cloneDamage,
  isShutdown,
  isUnitOnBoard,
  isUnitRemoved,
  occupantAt,
  requirePhase,
  requireUnit,
} from "./queries";
import type {
  AttackPhaseContext,
  BattleState,
  BuildingDamageResult,
  GameEvent,
  PilotHitReason,
  PilotingCheckReason,
  RunningState,
  UnitAttackResult,
  UnitState,
} from "./types";
import { resolveUnitAttacks } from "./weaponFire";

/**
 * Phase-end sweep: resolve every unit's declared attacks simultaneously.
 * All declarations are collected first (during the weapon attack phase),
 * then damage is applied in two phases: collect all resolutions, then
 * apply damage/crits/heat simultaneously. TW resolves weapon attacks
 * simultaneously — a 'Mech killed during the weapon attack phase still
 * fires its declared shots.
 */
export function resolveAllAttacks(state: BattleState, rng: Rng, sink: GameEvent[]): void {
  requirePhase(state, "attack");
  sink.push({ kind: "attackPhaseStage", stage: "begin", turn: state.turn });

  // Phase 1: collect resolutions for ALL units with declared attacks
  // (ignore `removed` flag — TW simultaneity means even destroyed units fire)
  const baseDamage: Record<string, UnitDamageState> = {};
  const baseCrit: Record<string, CritMask> = {};
  for (const unit of Object.values(state.units)) {
    baseCrit[unit.id] = cloneCritTable(unit.critSlotsDestroyed);
    baseDamage[unit.id] = {
      armor: { ...unit.damage.armor },
      armorRear: { ...unit.damage.armorRear },
      internalStructure: { ...unit.damage.internalStructure },
    };
  }
  // The weapon sub-pass window: weapon groups, crit-blast replays and the
  // building-collapse damage below, but not the pre-volley computation
  // applications, whose states are discarded.
  state.currentDealt = {
    before: { damage: baseDamage, crit: baseCrit },
    total: {},
    byAttacker: {},
  };

  const results: UnitAttackResult[] = [];
  // TW p. 171: the absorb toll keys off the CF at the beginning of the phase,
  // and p. 171 mandates CF reduction only after all weapons fire completes.
  const phaseStartCf: Record<string, number> = {};
  for (const [key, building] of Object.entries(state.buildings)) {
    phaseStartCf[key] = building.cf;
  }
  const running: Record<string, RunningState> = {};
  const ctx: AttackPhaseContext = { running, phaseStartCf, own: {}, ams: {}, nextKey: 0 };
  prepareMissileDefense(state, ctx);
  for (const unit of Object.values(state.units)) {
    if (unit.declaredWeaponAttacks.length === 0) continue;
    results.push(resolveUnitAttacks(state, unit, rng, ctx));
  }

  // Phase 2: apply all damage, crits, building damage, and heat simultaneously
  // Track damage per target
  const targetDamageMap: Record<string, UnitDamageState> = {};
  const buildingOutcomes: BuildingDamageResult[] = [];
  /** Deferred per-hex CF tolls (TW p. 171: CF reduction only after all
   *  weapons fire is complete). Applied after the damage write-back. */
  const buildingDamageByHex: Record<string, { hex: HexCoord; damage: number }> = {};
  /** `targetId:limb` pairs already reported as blown off this phase. */
  // Plan A (sequential emit): one pass over resolutions in declaration
  // order. Each weapon's groups AND its own crit blasts fold into
  // `targetDamageMap` together before its `attackResolved` emits, so a
  // later resolution's `before` already includes earlier explosions.
  /** Per-target crit-slot accumulators (OR-merged across the volley). */
  const targetCritSlotsMap: Record<string, CritMask> = {};
  /** Original crit resolutions per target, in order (severed-limb tokens
   *  and the kill reason). */
  const targetCrits: Record<string, CriticalResolution[]> = {};

  for (const result of results) {
    for (const {
      targetId,
      secondaryMod,
      resolution,
      buildingDamage,
      coverBuilding,
      ams,
    } of result.resolutions) {
      const target = requireUnit(state, targetId);
      let reported = resolution;

      // Initialize target accumulators from current state (not baseDamage —
      // we want sequential application within the same target)
      if (!targetDamageMap[targetId]) {
        targetDamageMap[targetId] = {
          armor: { ...target.damage.armor },
          armorRear: { ...target.damage.armorRear },
          internalStructure: { ...target.damage.internalStructure },
        };
        // Copy so the OR-merge below mutates a fresh table, not the unit's.
        targetCritSlotsMap[targetId] = cloneCritTable(target.critSlotsDestroyed);
        targetCrits[targetId] = [];
      }
      // Authoritative sequential state from Phase 1 (TW pp.122-123): each
      // resolution's groups were already applied group-by-group with each
      // group's crits interleaved (attack.ts). Adopt it directly; never
      // re-apply groups-then-blasts here — that reordering destroys
      // locations the real sequence only damages, and the catastrophic
      // wipe (destroyAllSlots/zeroBins) then poisons the persistent crit
      // table (phantom engine kill).
      if (resolution.applications.length > 0) {
        for (const app of resolution.applications) {
          creditDealt(state, target, result.unitId, dealtOf(app));
          recordSeveredLimbs(state, target, app.blownOffLimbs);
        }
        targetDamageMap[targetId] = cloneDamage(resolution.targetDamageAfter);
        reported = resolution;
      }

      // Fold THIS resolution's crits immediately (not in a later sweep),
      // so the next resolution's `before` already includes this blast's
      // damage. Each `crit` carries the cumulative Phase-1 chain
      // (run.crit via resolveUnitAttacks), so the last one is the
      // authoritative accumulator — assign, never OR-merge a replay.
      const lastCrit = resolution.crits[resolution.crits.length - 1];
      if (lastCrit !== undefined) {
        targetCritSlotsMap[targetId] = cloneCritTable(lastCrit.critSlotsDestroyed);
        for (const crit of resolution.crits) {
          creditDealt(state, target, result.unitId, critDamageDealt(crit));
        }
      }
      if (resolution.crits.length > 0) {
        targetCrits[targetId]!.push(...resolution.crits);
        reported = { ...reported, crits: resolution.crits };
      }

      // A leg hit stopped by building cover damages that building (TW p.102).
      if (coverBuilding !== undefined) {
        const key = hexKey(coverBuilding.hex);
        const entry = buildingDamageByHex[key];
        buildingDamageByHex[key] = {
          hex: coverBuilding.hex,
          damage: (entry?.damage ?? 0) + coverBuilding.damage,
        };
      }

      // Defer building damage: accumulate the toll per hex, applied after
      // all weapons fire completes (TW p. 171).
      if (buildingDamage > 0) {
        const key = hexKey(target.position);
        const entry = buildingDamageByHex[key];
        if (entry === undefined) {
          buildingDamageByHex[key] = {
            hex: target.position,
            damage: buildingDamage,
          };
        } else {
          buildingDamageByHex[key] = {
            hex: entry.hex,
            damage: entry.damage + buildingDamage,
          };
        }
      }

      // Emit attackResolved event
      sink.push({
        kind: "attackResolved",
        unitId: result.unitId,
        targetId,
        secondaryMod,
        resolution: reported,
      });

      // AMS heat is the defender's own heat this turn (TW p.129).
      if (ams !== undefined && resolution.missileDefense !== undefined) {
        const defender = requireUnit(state, ams.defenderId);
        defender.heatPending += ams.heat;
        sink.push({
          kind: "amsEngaged",
          unitId: defender.id,
          weaponIndex: ams.use.weaponIndex,
          weapon: ams.use.weapon,
          attackerId: result.unitId,
          attackWeapon: resolution.weapon,
          hitsWithout: resolution.missileDefense.hitsWithout,
          hitsWith: resolution.missileDefense.hitsWith,
          heat: ams.heat,
          base: defender.heat,
          totalGenerated: defender.heatPending,
          shotsLeft: ams.shotsLeft,
        });
      }

      // Heat-causing hit (TW p.113): tallied as outside heat, landing in
      // the target's Heat Phase (TW p.159).
      const inflicted = resolution.inflictedHeat;
      if (inflicted !== undefined && inflicted.heat > 0) {
        target.heatExternalPending += inflicted.heat;
        sink.push({
          kind: "heatInflicted",
          unitId: result.unitId,
          targetId,
          weapon: resolution.weapon,
          heat: inflicted.heat,
          source: inflicted.source,
          totalReceived: target.heatExternalPending,
        });
      }
    }

    const attacker = requireUnit(state, result.unitId);
    for (const wi of result.jammedWeapons) {
      if (!attacker.jammedWeapons.includes(wi)) {
        attacker.jammedWeapons.push(wi);
      }
    }

    // Apply attacker's weapon heat (deferred).
    const totalWeaponHeat = result.resolutions.reduce((sum, r) => sum + r.weaponHeat, 0);
    if (totalWeaponHeat > 0) {
      attacker.heatPending += totalWeaponHeat;
      sink.push({
        kind: "heatWeapon",
        unitId: attacker.id,
        heat: totalWeaponHeat,
        base: attacker.heat,
        totalGenerated: attacker.heatPending,
      });
    }
  }

  // Crit damage, slot flags, bins, and kill reasons were already folded
  // per-resolution in the pass above, so here only persist the
  // accumulators to the units and record severed-limb tokens.
  for (const targetId of Object.keys(targetDamageMap)) {
    const target = requireUnit(state, targetId);
    const slots = targetCritSlotsMap[targetId];
    if (slots !== undefined) target.critSlotsDestroyed = slots;
    // Crit blow-offs leave their limbs in the target's hex (TW p.146).
    const limbCrits = targetCrits[targetId] ?? [];
    if (limbCrits.length > 0) recordCritSeveredLimbs(state, target, limbCrits);
  }

  // Write back final damage to all targets
  for (const [targetId, damage] of Object.entries(targetDamageMap)) {
    requireUnit(state, targetId).damage = damage;
  }
  // Each unit's running ledger holds its final bins: its own Streak spending
  // and every crit it took, in resolution order (one writer, no merge).
  for (const [unitId, run] of Object.entries(running)) {
    requireUnit(state, unitId).ammoBins = run.ammoBins;
  }

  // TW p. 171: CF reduction only after all weapons fire is complete, so the
  // toll stays frozen at the phase-start CF for every attack this phase.
  for (const { hex, damage } of Object.values(buildingDamageByHex)) {
    const outcome = damageBuildingAt(state, hex, damage, sink);
    if (outcome !== null) buildingOutcomes.push(outcome);
  }

  // Collapse damage lands after the write-back so folded attack damage
  // lands first; new `collapseDamage` events stay inside the
  // attack-resolution block.
  for (const outcome of buildingOutcomes) {
    resolveBuildingCollapse(state, outcome, rng, sink);
  }

  // A blast that destroyed the center torso: auto-eject (TO) ejects the pilot
  // before the unit is marked destroyed, so the 'Mech leaves play as ejected;
  // with auto-eject off the MechWarrior dies with it (TW p. 128).
  for (const result of results) {
    for (const { targetId, resolution } of result.resolutions) {
      if (!resolution.hit) continue;
      const target = requireUnit(state, targetId);
      resolveCenterTorsoBlast(
        state,
        target,
        resolution.crits.flatMap((c) => c.rows.map(blastApplication)),
        rng,
        sink,
      );
    }
  }

  // Pilot damage (TW p.41): a head hit lands 1 point per damaging grouping,
  // an ammo/weapon explosion 2 points. Consciousness rolls run per point at once,
  // before any Piloting Skill Rolls (TW p.42 errata).
  for (const result of results) {
    for (const { targetId, resolution } of result.resolutions) {
      if (!resolution.hit) continue;
      const target = requireUnit(state, targetId);
      if (isUnitRemoved(target) && target.removed !== "pilotEjected") continue;
      const headGroups = resolution.groups.filter(
        (g) => g.location === "head" && g.damage >= 1,
      ).length;
      if (headGroups > 0)
        applyPilotHits(state, target, headGroups * HEAD_HIT_PILOT_HITS, "headHit", rng, sink);
      let ammoBlasts = 0;
      for (const crit of resolution.crits) {
        for (const row of crit.rows) {
          if (isCritBlastRow(row)) ammoBlasts += 1;
        }
      }
      if (ammoBlasts > 0)
        applyPilotHits(
          state,
          target,
          ammoBlasts * AMMO_BLAST_PILOT_HITS,
          "ammoExplosion",
          rng,
          sink,
        );
    }
  }
  // Units destroyed this sub-pass are marked after their pilot damage, so a
  // blast that destroys the 'Mech still injures the MechWarrior (TW pp.41,125).
  for (const unit of Object.values(state.units)) {
    const crits = targetCrits[unit.id] ?? [];
    if (
      awaitsDestroyedMark(unit) &&
      (isUnitWrecked(unit) || crits.some((c) => c.killedReason !== null))
    ) {
      markUnitDestroyed(state, unit, destroyedReasonFor(unit.damage, crits), rng, sink);
    }
  }

  // End-of-weapon sub-pass piloting (TW pp.59,61): weapon-caused rolls land
  // before any melee resolves, so a weapon-phase fall starts the melee prone
  // and a weapon-phase kill never swings a declared melee blow. Declarations
  // stay merged for playability (one attack activation per unit per turn);
  // only the resolution is split into weapon-then-physical sub-passes.
  resolvePhasePiloting(state, rng, sink, undefined, true);
  for (const unit of Object.values(state.units)) {
    if (awaitsDestroyedMark(unit) && isUnitWrecked(unit)) {
      markUnitDestroyed(state, unit, destroyedReasonFor(unit.damage), rng, sink);
    }
  }

  // Post-weapon snapshot: the physical 20-point trigger measures only
  // physical-sub-pass damage (TW p.60 "in one phase" per phase), and weapon
  // fall damage never re-triggers the sweep.
  // One detached copy of each unit, so every field read from it (damage,
  // crit flags, ammo, severed limbs, club, pilot hits) is from the same moment.
  const postWeapon: Record<string, UnitState> = {};
  const postWeaponDamage: Record<string, UnitDamageState> = {};
  const postWeaponCrit: Record<string, CritMask> = {};
  for (const unit of Object.values(state.units)) {
    const snap = saveUnitState(unit);
    postWeapon[unit.id] = snap;
    postWeaponDamage[unit.id] = snap.damage;
    postWeaponCrit[unit.id] = snap.critSlotsDestroyed;
  }

  sink.push({ kind: "attackPhaseStage", stage: "weaponDone", turn: state.turn });
  // The physical sub-pass is a window of its own, measured from the
  // post-weapon snapshot: physical groups, their crit blasts, and DFA-miss
  // falls, so weapon and physical damage never pool into one roll.
  state.currentDealt = {
    before: { damage: postWeaponDamage, crit: postWeaponCrit },
    total: {},
    byAttacker: {},
  };

  // Sub-pass 2: Physical attacks (TW p. 37: physical attacks resolve after weapon attacks)
  // Collect physical attack crits per target for destruction sweep
  const pendingPilotHits: { unit: UnitState; hits: number; reason: PilotHitReason }[] = [];
  // Physical attacks are declared against the state at phase start (TW p.38:
  // damage and consciousness rolls take effect at the end of the phase), so
  // legality and to-hit read the attacker as it stood after the weapon
  // sub-pass. Only where it stands stays live: an earlier melee this phase
  // can already have moved it (charge advance, displacement) or dropped it.
  const phaseStartView = (attackerId: string): BattleState => {
    const u = requireUnit(state, attackerId);
    const start = postWeapon[attackerId];
    if (start === undefined) return state;
    return {
      ...state,
      units: {
        ...state.units,
        [attackerId]: { ...start, position: u.position, facing: u.facing, prone: u.prone },
      },
    };
  };
  const physicalAttackCrits: Record<string, CriticalResolution[]> = {};
  // Kick PSRs deferred here for the end-of-physical sweep (TW pp.59,147).
  const kickExtras: Record<string, Array<{ reason: PilotingCheckReason; modifier: number }>> = {};
  const queuePhysicalPsr = (unitId: string, reason: PilotingCheckReason, modifier = 0): void => {
    const list = kickExtras[unitId];
    if (list === undefined) kickExtras[unitId] = [{ reason, modifier }];
    else list.push({ reason, modifier });
  };
  // Applies physical damage groups to one side, merging per-group
  // applications and rolling criticals (TW pp.123-124). `origin` is the hex
  // the blow came from (null: the recipient's own front, e.g. recoil).
  const applyPhysicalGroups = (
    recipient: UnitState,
    groups: readonly DamageGroup[],
    origin: HexCoord | null,
    resolutionTac: boolean,
    attackerId: string | null,
  ): { applications: DamageApplication[]; crits: CriticalResolution[] } => {
    const sheared: LimbLocation[] = [];
    const crits: CriticalResolution[] = [];
    const applications: DamageApplication[] = [];
    for (const group of groups) {
      // A group that carries its arc (charge / DFA) strikes that side's armor,
      // so a DFA on a prone 'Mech hits rear armor like its Rear-column
      // location (TW p.150).
      let attackDirection: Arc = group.arc ?? "front";
      if (group.arc === undefined && origin !== null) {
        const back = bearingExact(recipient.position, origin)!;
        const dir = classifyArcWithBoundary(recipient.facing, back);
        attackDirection = defenderArcChoice(dir.arc, dir.altArc);
      }
      const app = applyDamage(recipient.damage, group.location, group.damage, attackDirection);
      recipient.damage = app.after;
      creditDealt(state, recipient, attackerId, dealtOf(app));
      applications.push(app);
      sheared.push(...app.blownOffLimbs);

      if (!state.critsDisabled) {
        // Critical hit resolution (TW p.123-124):
        // - One determining roll per location that loses internal structure
        // - One additional determining roll if hit-location roll was 2 (through-armor critical)
        // - One roll for every location the group damaged (TW p.124)
        const struck = structureStruck(app);
        const critRolls = struck.map((location) => ({ location, tac: false }));
        if (group.tac === true || resolutionTac) {
          critRolls.push({ location: group.location, tac: true });
        }
        for (const { location: critLoc, tac: tagThroughArmor } of critRolls) {
          const startCrit = postWeaponCrit[recipient.id];
          const res = resolveCriticalHits({
            rng,
            model: recipient.model,
            source: {
              location: critLoc,
              damage: group.damage,
              struck: struck.includes(critLoc),
              tac: tagThroughArmor,
            },
            ...(startCrit !== undefined ? { baseCritSlotsDestroyed: startCrit } : {}),
            critSlotsDestroyed: recipient.critSlotsDestroyed,
            damage: recipient.damage,
            ammoBins: recipient.ammoBins,
          });
          recipient.critSlotsDestroyed = res.critSlotsDestroyed;
          recipient.ammoBins = res.ammoBins;
          recipient.damage = res.damage;
          creditDealt(state, recipient, attackerId, critDamageDealt(res));
          crits.push(res);
        }
      }
    }
    // Accumulate crits for this unit (multiple attacks possible)
    if (crits.length > 0) {
      physicalAttackCrits[recipient.id] = [...(physicalAttackCrits[recipient.id] ?? []), ...crits];
    }
    // Severed limbs stay where they were lost (TW p.146).
    recordSeveredLimbs(state, recipient, sheared);
    recordCritSeveredLimbs(state, recipient, crits);
    return { applications, crits };
  };
  // A failed DFA drops the attacker as from a 2-level fall onto its rear
  // (TW p.150); nothing else moves.
  const dfaMissFall = (attacker: UnitState): void => {
    if (isUnitRemoved(attacker) || attacker.prone) return;
    const pre = preexistingDamageModifier(
      mechDefFor(attacker),
      attacker.damage,
      attacker.critSlotsDestroyed,
    ).modifier;
    const terrain = cellAt(state, attacker.position).terrain;
    applyFall(
      state,
      attacker,
      rng,
      {
        cause: { kind: "dfaMiss" },
        hex: attacker.position,
        seatbeltModifier: pre + DFA_ATTACKER_PSR_MOD,
        halved: terrain === "water2" || terrain === "water3",
        levelsFallen: DFA_MISS_LEVELS_FALLEN,
        rearHits: true,
      },
      sink,
    );
  };
  const missResolution = (
    type: PhysicalAttackDecl["type"],
    attackerId: string,
    targetId: string,
    missReason: string,
    note: string,
    fallsOnMiss = false,
    advancedTo?: HexCoord,
  ): PhysicalResolution => ({
    type,
    attackerId,
    targetId,
    ...(fallsOnMiss ? { dfaMissFall: true } : {}),
    ...(advancedTo !== undefined ? { advancedTo } : {}),
    toHit: 13,
    roll: null,
    hit: false,
    autoHit: false,
    autoMiss: true,
    damageToTarget: [],
    damageToAttacker: [],
    applications: [],
    attackerApplications: [],
    crits: [],
    notes: [note],
    throughArmorCrit: false,
    missReason,
  });
  // The lower-initiative (losing) team's melee resolves first (TW p.144);
  // same-team order follows declaration order (stable sort). Matters for
  // club pickups racing for the same ground token.
  const physicalOrder = Object.values(state.units)
    .filter((u) => u.declaredPhysicalAttacks.length > 0 || u.declaredPickup !== null)
    .sort((a, b) => {
      const aWinner = state.initiativeWinnerTeam !== null && a.team === state.initiativeWinnerTeam;
      const bWinner = state.initiativeWinnerTeam !== null && b.team === state.initiativeWinnerTeam;
      return Number(aWinner) - Number(bWinner);
    });

  for (const unit of physicalOrder) {
    // Pickup declarations resolve here, in initiative order with the melee
    // (TW p.146): the declaration-time environment is re-checked against
    // the unit's current hex inside `resolveClubPickup`.
    if (unit.declaredPickup !== null) {
      resolveClubPickup(state, requireUnit(state, unit.id), unit.declaredPickup, rng, sink);
      continue;
    }
    for (const decl of unit.declaredPhysicalAttacks) {
      const attacker = requireUnit(state, unit.id);
      const target = state.units[decl.targetId];
      if (isUnitRemoved(attacker) || isPilotUnconscious(attacker) || isShutdown(attacker)) {
        const resolution = missResolution(
          decl.type,
          attacker.id,
          decl.targetId,
          "attackerDown",
          `attacker unable to attack (destroyed/unconscious/shut down) — auto-miss`,
          decl.type === "dfa",
        );
        sink.push({
          kind: "physicalAttackResolved",
          unitId: attacker.id,
          targetId: decl.targetId,
          resolution,
        });
        if (decl.type === "dfa") dfaMissFall(attacker);
        continue;
      }
      // Charge / DFA: the target may have left its hex since the declaration.
      // The attacker, having paid for the move, then advances into the
      // vacated hex (only another unit or a hull can stop it).
      const charge = attacker.meleeCharge;
      if (isMeleeCharge(decl.type) && charge !== null) {
        const targetHere =
          target !== undefined && isUnitOnBoard(target) && sameHex(target.position, charge.hex);
        if (!targetHere) {
          const holder = occupantAt(state, charge.hex, attacker.id);
          let resolution: PhysicalResolution;
          if (attacker.prone) {
            resolution = missResolution(
              decl.type,
              attacker.id,
              decl.targetId,
              "voided:attackerDown",
              `attacker is down — no attack`,
            );
          } else if (holder === undefined) {
            attacker.position = charge.hex;
            resolution = missResolution(
              decl.type,
              attacker.id,
              decl.targetId,
              "advanced",
              `target left its hex — the attacker advances into it`,
              false,
              charge.hex,
            );
          } else {
            resolution = missResolution(
              decl.type,
              attacker.id,
              decl.targetId,
              "voided:hexTaken",
              `target left its hex and it is blocked — no attack`,
            );
          }
          sink.push({
            kind: "physicalAttackResolved",
            unitId: attacker.id,
            targetId: decl.targetId,
            resolution,
          });
          continue;
        }
        // A DFA'er whose weapon-phase piloting roll failed does not fall
        // then: the DFA misses and it falls now (TW p.149).
        if (decl.type === "dfa" && charge.missed) {
          const resolution = missResolution(
            decl.type,
            attacker.id,
            decl.targetId,
            "dfaAborted",
            `piloting roll failed in the weapon phase — the DFA misses`,
            true,
          );
          sink.push({
            kind: "physicalAttackResolved",
            unitId: attacker.id,
            targetId: decl.targetId,
            resolution,
          });
          dfaMissFall(attacker);
          continue;
        }
      }
      if (target === undefined || !isUnitOnBoard(target)) {
        const resolution = missResolution(
          decl.type,
          attacker.id,
          decl.targetId,
          "targetDown",
          `target destroyed or removed before the melee — auto-miss`,
        );
        sink.push({
          kind: "physicalAttackResolved",
          unitId: attacker.id,
          targetId: decl.targetId,
          resolution,
        });
        continue;
      }
      // Re-validate against post-weapon state: a weapon-phase fall leaves
      // the attacker prone (validate rejects prone attackers) and falls may
      // have broken arcs (TW pp.144,151).
      const view = phaseStartView(attacker.id);
      const check = validatePhysicalAttack(
        view,
        attacker.id,
        decl,
        decl.twist ?? "front",
        false,
        baseDamage[attacker.id],
      );
      if (!check.ok) {
        const resolution = missResolution(
          decl.type,
          attacker.id,
          decl.targetId,
          `invalid:${check.reason ?? "illegal"}`,
          `no longer legal (${check.reason ?? "illegal"}) — auto-miss`,
        );
        sink.push({
          kind: "physicalAttackResolved",
          unitId: attacker.id,
          targetId: decl.targetId,
          resolution,
        });
        continue;
      }
      let resolution = resolvePhysicalAttack(view, attacker.id, decl, rng);
      // Apply damage to both sides, merging per-group applications like the
      // weapon path (attack.ts) so the emitted resolution carries the
      // armor-change detail and crits. A DFA reads its direction from the
      // hex it jumped from (TW p.150).
      const hitTarget =
        resolution.hit && resolution.damageToTarget.length > 0
          ? requireUnit(state, decl.targetId)
          : null;
      const origin =
        decl.type === "dfa" && attacker.meleeCharge !== null
          ? attacker.meleeCharge.from
          : attacker.position;
      const targetOutcome = hitTarget
        ? applyPhysicalGroups(
            hitTarget,
            resolution.damageToTarget,
            origin,
            resolution.throughArmorCrit,
            attacker.id,
          )
        : null;
      const attackerOutcome =
        resolution.damageToAttacker.length > 0
          ? applyPhysicalGroups(attacker, resolution.damageToAttacker, null, false, null)
          : null;
      const targetApplications = targetOutcome?.applications ?? [];
      const attackerApplications = attackerOutcome?.applications ?? [];
      const targetCrits = targetOutcome?.crits ?? [];

      // Emit the event after damage resolution so the log can render the
      // armor-change detail and crits, like weapon `attackResolved`.
      resolution = {
        ...resolution,
        applications: targetApplications,
        attackerApplications,
        crits: targetCrits,
      };
      sink.push({
        kind: "physicalAttackResolved",
        unitId: attacker.id,
        targetId: decl.targetId,
        resolution,
      });

      const fallTarget = requireUnit(state, decl.targetId);
      // Kick PSRs defer to the end-of-physical sweep (TW pp.59,147).
      if (resolution.kickTargetPsrPending && isUnitOnBoard(fallTarget)) {
        queuePhysicalPsr(fallTarget.id, "kick");
      }
      if (resolution.kickAttackerPsrPending && !isUnitRemoved(attacker)) {
        queuePhysicalPsr(attacker.id, "kickMiss");
      }
      // Charge / DFA PSRs, with the Piloting Skill Roll Table modifiers
      // (TW p.60), resolve in the same end-of-physical sweep.
      if (resolution.targetPsrMod !== undefined && isUnitOnBoard(fallTarget)) {
        queuePhysicalPsr(fallTarget.id, "chargeTarget", resolution.targetPsrMod);
      }
      if (resolution.attackerPsrMod !== undefined && !isUnitRemoved(attacker)) {
        queuePhysicalPsr(
          attacker.id,
          decl.type === "dfa" ? "dfaMade" : "chargeMade",
          resolution.attackerPsrMod,
        );
      }
      if (resolution.dfaMissFall === true) dfaMissFall(attacker);

      // Pilot damage (TW p.41): head hits land 1 point per damaging
      // grouping. Physical attacks now roll crits per TW p.123-124.
      if (resolution.hit && hitTarget && !isUnitRemoved(hitTarget)) {
        const headGroups = resolution.damageToTarget.filter(
          (g) => g.location === "head" && g.damage >= 1,
        ).length;
        // A destroyed head is resolved by the destruction sweep below (auto-eject
        // or cockpit kill), not by an extra head-hit tally.
        if (headGroups > 0) {
          pendingPilotHits.push({
            unit: hitTarget,
            hits: headGroups * HEAD_HIT_PILOT_HITS,
            reason: "headHit",
          });
        }
      }

      // Recoil that hit the attacker's head injures its pilot too.
      if (!isUnitRemoved(attacker)) {
        const recoilHeads = resolution.damageToAttacker.filter(
          (g) => g.location === "head" && g.damage >= 1,
        ).length;
        if (recoilHeads > 0) {
          pendingPilotHits.push({
            unit: attacker,
            hits: recoilHeads * HEAD_HIT_PILOT_HITS,
            reason: "headHit",
          });
        }
      }

      // Uprooted trees are good for one successful club attack only (TW
      // p.146); limb and girder clubs persist.
      if (resolution.hit && decl.type === "club" && attacker.club?.kind === "tree") {
        attacker.club = null;
        sink.push({ kind: "clubConsumed", unitId: attacker.id, clubKind: "tree" });
      }
    }
  }

  // Destruction from physical-attack damage and pilot
  // hits above lands before the end-of-phase piloting sweep.
  // Ammo blasts from physical crits eject on a CT blast and hurt the pilot
  // like the weapon path (PHY-08); pilot hits land with the phase's damage.
  for (const unit of Object.values(state.units)) {
    const crits = physicalAttackCrits[unit.id] ?? [];
    resolveCenterTorsoBlast(
      state,
      unit,
      crits.flatMap((c) => c.rows.map(blastApplication)),
      rng,
      sink,
    );
    const blasts = crits.reduce((n, c) => n + c.rows.filter(isCritBlastRow).length, 0);
    if (blasts > 0) {
      pendingPilotHits.push({
        unit,
        hits: blasts * AMMO_BLAST_PILOT_HITS,
        reason: "ammoExplosion",
      });
    }
  }
  // Pilot hits and their consciousness rolls take effect at the end of the
  // phase, after every declared physical attack has resolved (TW p.38) and
  // before units are marked destroyed (a blast that destroys the 'Mech still
  // injures the MechWarrior, TW p.125).
  for (const { unit, hits, reason } of pendingPilotHits) {
    if (isUnitRemoved(unit) && unit.removed !== "pilotEjected") continue;
    applyPilotHits(state, unit, hits, reason, rng, sink);
  }
  for (const unit of Object.values(state.units)) {
    const physCrits = physicalAttackCrits[unit.id];
    if (
      awaitsDestroyedMark(unit) &&
      (isUnitWrecked(unit) || (physCrits ?? []).some((c) => c.killedReason !== null))
    ) {
      markUnitDestroyed(state, unit, destroyedReasonFor(unit.damage, physCrits), rng, sink);
    }
  }
  sink.push({ kind: "attackPhaseStage", stage: "physicalDone", turn: state.turn });

  // End-of-physical sweep: physical-sub-pass damage/crits plus deferred kick
  // PSRs (TW pp.59-60,147).
  resolvePhasePiloting(state, rng, sink, kickExtras);
  // Attacks resolve simultaneously; hands lost during them drop the club now.
  enforceClubHandsAll(state, sink);

  // Clear declared attacks for all units
  for (const unit of Object.values(state.units)) {
    unit.declaredWeaponAttacks = [];
    unit.declaredPhysicalAttacks = [];
    unit.declaredPickup = null;
    unit.meleeCharge = null;
  }
}
