import type { BuildingTerrainType, MoveMode } from "../../core/types";
import type { Arc } from "../arcs";
import type { CreateBattleOptions, UnitPolicy } from "./types";

/** Policy a unit gets when setup names none. */
export const DEFAULT_UNIT_POLICY: Readonly<UnitPolicy> = {
  ammoPolicy: "exposed",
  autoEject: true,
  heatFlamer: true,
  amsPolicy: "expected",
};

/** The only legal team ids: 1 and 2 (one side each). */
export const TEAM_IDS = [1, 2] as const;

/** Girder-search target numbers by rubble origin (TW p.146): 7+ from
 *  medium rubble, 6+ from heavy, 5+ from hardened. Light rubble yields no
 *  girders. */
export const GIRDER_SEARCH_TARGET: Readonly<Partial<Record<BuildingTerrainType, number>>> = {
  mediumBuilding: 7,
  heavyBuilding: 6,
  hardenedBuilding: 5,
};

export const DEFAULT_CREATE_BATTLE_OPTION: CreateBattleOptions = {
  critsDisabled: false,
};

/** How much the defender prefers being struck in each arc. */
export const DEFENDER_ARC_RANK: Readonly<Record<Arc, number>> = {
  front: 2,
  leftSide: 1,
  rightSide: 1,
  rear: 0,
};

/** Smallest 'Mech that leaves battlefield wreckage when destroyed (TO:AR
 *  p.155: "40 tons or more"). Lighter 'Mechs leave nothing on the board;
 *  their record is still kept for salvage. */
export const WRECKAGE_TONNAGE_MIN = 40;

/** MP cost of a stand-up attempt (TW p.50): shares the move budget. */
export const STAND_MP_COST = 2;

/** MP cost of a voluntary drop to prone (TW p.49): shares the walk budget. */
export const DROP_MP_COST = 1;

/** Max hexsides per facing-change step. */
export const TURN_FACINGS_MAX = 5;

/** Minimum hexes entered for a jump declaration. */
export const JUMP_MIN_HEXES = 1;

/** Heat from a stand-up attempt. A voluntary drop to
 *  prone costs no heat. */
export const POSTURE_MOVE_HEAT = 1;

/** Walk budget below which a prone drop is refused. */
export const DROP_BUDGET_MIN = 1;

/** End-of-heat-phase heat dealing 1 pilot hit with destroyed life support. */
export const LIFE_SUPPORT_HEAT_1HIT = 15;

/** End-of-heat-phase heat dealing 2 pilot hits with destroyed life support. */
export const LIFE_SUPPORT_HEAT_2HITS = 26;

/** End-Phase pilot hits while submerged with destroyed life support. */
export const AIR_SUPPLY_PILOT_HITS = 1;

/** Pilot hits per damaging head grouping. */
export const HEAD_HIT_PILOT_HITS = 1;

/** Pilot hits per ammo explosion. */
export const AMMO_BLAST_PILOT_HITS = 2;

/** Pilot hits per failed seatbelt or fall. */
export const FALL_PILOT_HITS = 1;

/** Seatbelt modifier when a leg is destroyed. */
export const SEATBELT_LEG_DESTROYED = 5;

/** Seatbelt modifier when the gyro is destroyed. */
export const SEATBELT_GYRO_DESTROYED = 6;

/** PSR modifier for the 20+ damage trigger in the phase sweep. */
export const PHASE_DAMAGE_PSR_MOD = 1;

/** PSR modifier when a reactor shuts down (TW p.60). Rolled immediately;
 *  only *other* PSRs required while the 'Mech is down fail automatically. */
export const SHUTDOWN_PSR_MOD = 3;

/** Seatbelt PSR carries the failed fall's combined modifier as its trigger;
 *  it has no separate preexisting component. */
export const SEATBELT_PRE_MOD = 0;

/** Divisor for building-crash damage: ceil(remaining CF / 10). */
export const BUILDING_CRASH_DIVISOR = 10;

/** A 'Mech entering or falling in a building hex deals tonnage / 10 (round
 *  up) to its CF (TW p.167). */
export const BUILDING_UNIT_DAMAGE_DIVISOR = 10;

/** Per-attack CF toll divisor for units inside buildings (TW p. 171):
 *  each hitting Damage Value grouping costs ceil(CF at phase start / 10). */
export const BUILDING_ABSORB_DIVISOR = 10;

/** Every `MoveMode`: an unknown mode would leave the move with no MP budget. */
export const MOVE_MODES: readonly MoveMode[] = ["standStill", "walk", "run", "jump", "prone"];

/** Base to-hit of an Accidental Fall From Above (TW p.152). */
export const ACCIDENTAL_FALL_BASE_TN = 7;
