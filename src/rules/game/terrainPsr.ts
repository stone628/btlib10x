import { roll2D6, rollD6 } from "../../core/dice";
import { cellAt, groundLevel, terrainTargetMod, waterDepth } from "../../core/terrain";
import { type HexCoord, hexKey, type Rng, type TerrainType } from "../../core/types";
import { mechDefFor } from "../../data/index";
import type { Arc } from "../arcs";
import { countDestroyedGyro } from "../critical";
import { hitLocationForArc, punchHitLocation } from "../hitlocation";
import * as mv from "../movement";
import type { DamageGroup } from "../physical";
import { isPilotUnconscious } from "../pilot";
import {
  buildingEntryModifier,
  buildingMovementModifier,
  fallingDamageGroups,
  GYRO_DESTROYED_HITS,
  waterEntryModifier,
} from "../piloting";
import { legGone } from "./condition";
import {
  applyDamageGroups,
  applyFall,
  damageBuildingByUnit,
  pushPilotingCheck,
} from "./consequences";
import {
  ACCIDENTAL_FALL_BASE_TN,
  BUILDING_CRASH_DIVISOR,
  SEATBELT_GYRO_DESTROYED,
  SEATBELT_LEG_DESTROYED,
} from "./constants";
import { isShutdown, isUnitOnBoard, isUnitRemoved, occupantAt, unitTonnage } from "./queries";
import type {
  BattleState,
  GameEvent,
  PilotingCheckReason,
  UnitFallCause,
  UnitState,
} from "./types";

/** Falls underwater halve damage: any depth 2+, plus a jump landing that
 *  tumbles to the bottom of depth 1 water (TW p.53). */
export function waterHalvesFall(terrain: TerrainType, ground: boolean): boolean {
  const depth = waterDepth(terrain);
  return depth >= 2 || (!ground && depth >= 1);
}

/**
 * Movement terrain PSRs for one entered hex (TW p.60, p.167): entering water
 * (depth 1: -1, depth 2: +0, depth 3+: +1), rubble (+0), or a building hex
 * (light +0 / medium +1 / heavy +2 / hardened +5, plus the Building
 * Movement modifier for `hexesMoved` this turn on a ground entry). Exiting a
 * building hex does NOT trigger a PSR (TW p.170). Failed water/rubble rolls
 * drop the 'Mech in the hex; a failed building roll crashes it (ceil(CF /
 * 10) damage on the front column, or the rear column when `forward` is
 * false; no fall) instead. Pass or fail, a ground entry then deals
 * ceil(tonnage / 10) to the hex (TW p.167), collapsing it at once if that
 * empties its CF. A fall across levels drops into
 * the lower of the two hexes (TW p.68) with levels fallen feeding damage
 * and the seatbelt check (+1 per level above 1); jump landings stay
 * 0-level falls per errata. Returns the hex the move stops in when it
 * must stop here (fell, crashed, or shut down mid-path), or null to
 * continue.
 */
export function movementTerrainPsr(
  state: BattleState,
  unit: UnitState,
  rng: Rng,
  from: HexCoord,
  to: HexCoord,
  ground: boolean,
  preModifier: number,
  sink: GameEvent[],
  /** Hexes entered this turn so far, including `to` (TW p.167). */
  hexesMoved = 1,
  /** Entered moving forward; false when backing in (TW p.167). */
  forward = true,
): HexCoord | null {
  const stop = (): boolean =>
    unit.prone || isUnitRemoved(unit) || isShutdown(unit) || isPilotUnconscious(unit);
  /** Lower hex of the step plus levels fallen into it (jump: landing, 0). */
  const lowerLanding = (hex: HexCoord): { lower: HexCoord; levels: number } => {
    // Jump landing: 0 levels per errata, except tumbling to the bottom of
    // water, which falls `depth` levels (TW p.53).
    if (!ground) return { lower: hex, levels: waterDepth(cellAt(state, hex).terrain) };
    const fromLevel = cellAt(state, from).level;
    const toLevel = cellAt(state, to).level;
    const lower = toLevel <= fromLevel ? to : from;
    return { lower, levels: Math.max(0, fromLevel - cellAt(state, lower).level) };
  };
  /** A faller that lands on another unit cannot share its hex: it stays in
   *  the hex it came from (`moveUnit` steps it further back when that hex
   *  is held too). Accidental Falls From Above (TW p.152): two or more
   *  levels down onto the occupant; a hit damages it like a DFA, and the
   *  faller still ends in the hex it fell from unless the occupant is gone.
   *  Returns the hex the faller ends in. */
  const settleFall = (lower: HexCoord): HexCoord => {
    if (isUnitRemoved(unit)) return lower;
    const occupant = occupantAt(state, lower, unit.id);
    if (occupant === undefined) return lower;
    const drop = ground ? groundLevel(state, from) - groundLevel(state, lower) : 0;
    if (drop >= 2) {
      const tn =
        ACCIDENTAL_FALL_BASE_TN +
        mv.targetMovementModifier(occupant.hexesMovedThisTurn, occupant.jumpedThisTurn, undefined) +
        terrainTargetMod(cellAt(state, lower).terrain);
      const roll = roll2D6(rng);
      const hit = roll >= tn;
      const total = Math.ceil(unitTonnage(unit) / 10) * drop;
      sink.push({
        kind: "accidentalFall",
        unitId: unit.id,
        targetId: occupant.id,
        toHit: tn,
        roll,
        hit,
        damage: hit ? total : 0,
      });
      if (hit) {
        const groups: DamageGroup[] = fallingDamageGroups(total).map((amount) => ({
          location: punchHitLocation(rollD6(rng)),
          damage: amount,
        }));
        // The occupant is outside the move's window scope, so it gets no
        // piloting sweep for damage taken during another unit's move; the
        // falling unit still earns kill credit.
        applyDamageGroups(state, occupant, rng, groups, "front", sink, unit.id);
        if (!isUnitOnBoard(occupant)) return lower;
      }
    }
    unit.position = from;
    return from;
  };
  const rollFall = (
    reason: PilotingCheckReason,
    trigger: number,
    cause: UnitFallCause,
    hex: HexCoord,
  ): HexCoord | null => {
    const modifier = trigger + preModifier;
    const { lower, levels } = lowerLanding(hex);
    // Walking in from above the surface (TW p.57): surface + bottom packets.
    const bottom =
      ground &&
      cause.kind === "terrain" &&
      cause.terrain === "water" &&
      waterDepth(cellAt(state, from).terrain) < 2
        ? waterDepth(cellAt(state, to).terrain)
        : 0;
    const bottomOpt = bottom > 0 ? { bottomDepth: bottom } : {};
    if (isShutdown(unit) || isPilotUnconscious(unit)) {
      // The fall (and anything it leaves behind) happens where the 'Mech lands.
      unit.position = { ...lower };
      const terrain = cellAt(state, lower).terrain;
      applyFall(
        state,
        unit,
        rng,
        {
          cause,
          hex: { ...lower },
          seatbeltModifier: null,
          halved: waterHalvesFall(terrain, ground),
          levelsFallen: levels,
          ...bottomOpt,
        },
        sink,
      );
      return settleFall(lower);
    }
    const r = pushPilotingCheck(sink, unit, reason, trigger, preModifier, rng, hex);
    if (r.success) return null;
    unit.position = { ...lower };
    const terrain = cellAt(state, lower).terrain;
    applyFall(
      state,
      unit,
      rng,
      {
        cause,
        hex: { ...lower },
        seatbeltModifier: modifier + Math.max(0, levels - 1),
        halved: waterHalvesFall(terrain, ground),
        levelsFallen: levels,
        ...bottomOpt,
      },
      sink,
    );
    return settleFall(lower);
  };
  const entering = cellAt(state, to).terrain;
  const water = waterEntryModifier(entering);
  if (water !== null) {
    const reason: PilotingCheckReason =
      entering === "water1" ? "water1" : entering === "water2" ? "water2" : "water3";
    const fellAt = rollFall(reason, water, { kind: "terrain", terrain: "water" }, to);
    if (fellAt !== null) return fellAt;
    if (stop()) return to;
  }
  if (entering === "rubble") {
    const fellAt = rollFall("rubble", 0, { kind: "terrain", terrain: "rubble" }, to);
    if (fellAt !== null) return fellAt;
    if (stop()) return to;
  }
  const buildingType = buildingEntryModifier(entering);
  const def = mechDefFor(unit);
  if (buildingType !== null) {
    // Only ground movement gets here: a jump cannot end in a building hex
    // (TW p.168), and moveUnit refuses one that tries.
    const building = buildingType + buildingMovementModifier(hexesMoved);
    /** Entry damage to the hex (TW p.167), resolved after any crash damage
     *  (TW p.177). */
    const wearHex = (): void => {
      damageBuildingByUnit(state, unit, to, rng, sink);
    };
    unit.position = to;
    const legWasGoneR = legGone(unit.damage, "rightLeg");
    const legWasGoneL = legGone(unit.damage, "leftLeg");
    const gyroWasGone = countDestroyedGyro(def, unit.damage, unit.critSlotsDestroyed);
    if (isShutdown(unit) || isPilotUnconscious(unit)) {
      wearHex();
      if (isUnitRemoved(unit)) return to;
      applyFall(
        state,
        unit,
        rng,
        {
          cause: { kind: "terrain", terrain: "building" },
          hex: to,
          seatbeltModifier: null,
          halved: false,
        },
        sink,
      );
      return to;
    }
    const r = pushPilotingCheck(sink, unit, "building", building, preModifier, rng, to);
    if (r.success) {
      wearHex();
    } else {
      // Crash damage reads the CF current at entry, before this unit's own
      // toll (TW pp.167, 177).
      const cf = state.buildings[hexKey(to)]?.cf ?? 0;
      const total = Math.ceil(cf / BUILDING_CRASH_DIVISOR);
      const column: Arc = forward ? "front" : "rear";
      const groups: DamageGroup[] = [];
      for (const amount of fallingDamageGroups(total)) {
        const roll = roll2D6(rng);
        groups.push({
          location: hitLocationForArc(column, roll),
          damage: amount,
          ...(roll === 2 ? { tac: true as const } : {}),
        });
      }
      const crits = applyDamageGroups(state, unit, rng, groups, column, sink);
      sink.push({
        kind: "buildingCrash",
        unitId: unit.id,
        col: to.col,
        row: to.row,
        column,
        groups,
        crits,
      });
      wearHex();
      // A crash that wrecks a leg or the gyro (or knocks the pilot out via
      // an ammo blast) drops the 'Mech on the spot (TW automatic fall);
      // without this the unit would stand into the weapon phase on a gone
      // leg or keep moving while unconscious.
      if (!unit.prone && !isUnitRemoved(unit)) {
        const legFell =
          (!legWasGoneR && legGone(unit.damage, "rightLeg")) ||
          (!legWasGoneL && legGone(unit.damage, "leftLeg"));
        const gyroNow = countDestroyedGyro(def, unit.damage, unit.critSlotsDestroyed);
        const gyroFell = gyroNow >= GYRO_DESTROYED_HITS && gyroWasGone < GYRO_DESTROYED_HITS;
        const down = isShutdown(unit) || isPilotUnconscious(unit);
        if (legFell || gyroFell || down) {
          applyFall(
            state,
            unit,
            rng,
            {
              cause: { kind: "terrain", terrain: "building" },
              hex: to,
              seatbeltModifier: down
                ? null
                : gyroFell
                  ? SEATBELT_GYRO_DESTROYED
                  : SEATBELT_LEG_DESTROYED,
              halved: false,
            },
            sink,
          );
        }
      }
      // A failed building roll deals damage but is not a fall (TW p.167):
      // the move goes on unless the crash knocked the 'Mech down.
      return stop() ? to : null;
    }
  }
  return stop() ? to : null;
}
