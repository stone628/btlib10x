import { D2D6_MAX, roll2D6, rollD6 } from "../core/dice";
import { bearingExact, hexDistance, isAdjacent, neighbor, sameHex } from "../core/hex";
import {
  cellAt,
  costToClimb,
  groundLevel,
  type HexGrid,
  hexCell,
  hexEntryCost,
  setCell,
  terrainTargetMod,
  waterDepth,
} from "../core/terrain";
import {
  type ArmLocation,
  type BuildingTerrainType,
  damageTransferTo,
  FACINGS,
  type Facing,
  type HexCell,
  type HexCoord,
  hexKey,
  isArm,
  isLeg,
  isTorso,
  isWoodsTerrain,
  type LimbLocation,
  LOCATIONS,
  type Location,
  type MoveMode,
  msgHex,
  oppositeFacing,
  type Rng,
  rotateFacing,
  type TerrainHexDef,
  type TerrainType,
} from "../core/types";
import { ensureMechRegistered, type MapDef, type MechModelHolder, mechDefFor } from "../data/index";
import type { ResolvedMechDef } from "../data/mech.schema";
import { isFireableWeapon, weaponDefFor } from "../data/weapon.schema";
import {
  armWeaponToHitModifier,
  clubHandsFunctional,
  targetingComputerModifier,
} from "./actuators";
import {
  type AmmoBins,
  type AmmoPolicy,
  binsForWeaponName,
  consumeAmmoForName,
  pooledShotsLeft,
} from "./ammo";
import {
  type Arc,
  classifyArc,
  classifyArcWithBoundary,
  classifyFiringArc,
  defenderArcChoice,
  effectiveFacingForTwist,
  mountArcLocation,
  mountCanFireIntoArc,
  type SecondaryTargetMod,
  secondaryTargetModifier,
  type Twist,
  twistDelta,
} from "./arcs";
import { type AttackResolution, PARTIAL_COVER_TERRAIN_MOD, resolveWeaponAttack } from "./attack";
import {
  applyBuildingDamage,
  type BuildingState,
  collapseToRubble,
  createBuildingState,
  DEFAULT_BUILDING_LEVELS,
  isBuildingTerrain,
  isCollapsed,
} from "./building";
import {
  applyAmmoExplosion,
  type CriticalEffect,
  type CriticalResolution,
  type CritMask,
  cloneCritTable,
  countDestroyedEngine,
  countDestroyedGyro,
  countDestroyedHip,
  countDestroyedLifeSupport,
  countDestroyedSensor,
  critDamageDealt,
  critSeveredLimbs,
  destroyAmmoBin,
  destroyedStructures,
  ENGINE_SLOTS_KILL,
  effectiveMovement,
  HIP,
  isSlotDestroyed,
  isWeaponCritted,
  markLocationCatastrophicallyDestroyed,
  resolveCriticalHits,
} from "./critical";
import {
  applyDamage,
  canAttemptStandUp,
  canFireMount,
  type DamageApplication,
  dealtOf,
  destroyedLegs,
  isUnitDestroyed,
  isUnitImmobile,
  isUnitLocationDestroyed,
  structureStruck,
  type UnitDamageState,
} from "./damage";
import {
  ammoExplosionAvoidWithThreshold,
  effectiveMoveBudget,
  engineHitHeat,
  heatDissipation,
  heatDissipationMax,
  isTsmActive,
  largestAmmoBin,
  movementHeat,
  outsideHeatApplied,
  shutdownAvoid,
  shutdownAvoidWithThreshold,
  toHitHeatModifier,
  waterHeatBonus,
} from "./heat";
import { hitLocationForArc, punchHitLocation } from "./hitlocation";
import { resolveInitialDamage, type UnitInitDamage } from "./initialDamage";
import { rollInitiative } from "./initiative";
import { internalStructureForTonnage } from "./internalStructure";
import {
  defenderLosSide,
  interveningHexes,
  interveningTerrains,
  type LosSide,
  losBlockedByBuilding,
  losBlockedByElevation,
  losClear,
  losWoodsPointsBetween,
  type ProneEnds,
  unitLosLevel,
} from "./los";
import * as mv from "./movement";
import { BACKWARD_LEVEL_CHANGE_MAX, FORWARD_LEVEL_CHANGE_MAX, JUMP_MP_PER_HEX } from "./movement";
import {
  type DamageGroup,
  DFA_ATTACKER_PSR_MOD,
  DFA_MISS_LEVELS_FALLEN,
  isMeleeCharge,
  type PhysicalAttackDecl,
  type PhysicalAttackType,
  type PhysicalResolution,
  type PhysicalWeaponName,
  resolvePhysicalAttack,
  resolveStrikeArm,
  validatePhysicalAttack,
} from "./physical";
import { isPilotUnconscious } from "./pilot";
import {
  buildingEntryModifier,
  buildingMovementModifier,
  consciousnessTarget,
  DEFAULT_PILOT_HIT_MAX,
  DEFAULT_PILOTING,
  ejectionDamage,
  ejectionModifier,
  facingAfterFall,
  fallingDamageGroups,
  fallingDamageTotal,
  GYRO_DESTROYED_HITS,
  GYRO_HIT_MOD,
  HIP_MOD,
  isValidPilotHitMax,
  LEG_ACTUATOR_MOD,
  LEG_ACTUATORS,
  type PilotingRollResult,
  PSR_DAMAGE_THRESHOLD,
  preexistingDamageModifier,
  rollConsciousness,
  rollFallDirection,
  rollPilotingCheck,
  sensorAttackModifier,
  sensorsBlind,
  waterEntryModifier,
} from "./piloting";
import { saveUnitState } from "./snapshot";
import { computeToHit, DEFAULT_GUNNERY, type RangeBracket, toHitTotal } from "./tohit";

export type UnitSkillRange = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Per-unit behavior settings fixed at setup (before the battle starts). */
export interface UnitPolicy {
  /** Which ammo bin a shot is drawn from (see `src/rules/ammo.ts`). */
  ammoPolicy: AmmoPolicy;
  /** Auto-eject system engaged (TO:AR p. 165; players may disable it per
   *  'Mech before the battle). On: losing the head, or a center torso to an
   *  ammo/weapon blast, ejects the pilot. Off: those kill the MechWarrior
   *  (TW p. 128). */
  autoEject: boolean;
  /** Flamer-family (`asHeat`) weapons apply their Damage Value as heat
   *  instead of damage (TW p.303 footnote ‡). On: every flamer hit heats the
   *  target; off: flamers deal normal damage. */
  heatFlamer: boolean;
}

/** Policy a unit gets when setup names none. */
export const DEFAULT_UNIT_POLICY: Readonly<UnitPolicy> = {
  ammoPolicy: "exposed",
  autoEject: true,
  heatFlamer: true,
};

/** The only legal team ids: 1 and 2 (one side each). */
export const TEAM_IDS = [1, 2] as const;
/** Legal team id. */
export type TeamId = (typeof TEAM_IDS)[number];
/** True when `n` is a legal team id (1 or 2). */
export function isValidTeam(n: number): n is TeamId {
  return n === 1 || n === 2;
}

export interface UnitInit extends MechModelHolder {
  readonly id: string;
  model: string;
  team: TeamId;
  /** Gunnery skill (TW regular = 4); defaults to {@link DEFAULT_GUNNERY}. */
  gunnery: UnitSkillRange;
  /** Pilot skill (TW regular = 5); defaults to {@link DEFAULT_PILOTING}. */
  piloting: UnitSkillRange;
  /** Pilot hit capacity (integer >= 1); the pilot dies when hits reach it.
   *  Defaults to {@link DEFAULT_PILOT_HIT_MAX} (6). */
  pilotHitMax: number;
  position: HexCoord;
  facing: Facing;
  /** Per-unit policies; `buildUnitInit` fills {@link DEFAULT_UNIT_POLICY}. */
  policy: UnitPolicy;
  /** Starting damage; absent = a pristine unit. See `UnitInitDamage`. */
  damage?: UnitInitDamage;
}

export function buildUnitInit(
  id: string,
  model: string,
  team: TeamId,
  position: HexCoord,
  facing: Facing = "n",
  gunnery: UnitSkillRange = DEFAULT_GUNNERY,
  piloting: UnitSkillRange = DEFAULT_PILOTING,
  pilotHitMax: number = DEFAULT_PILOT_HIT_MAX,
  policy: UnitPolicy = DEFAULT_UNIT_POLICY,
): UnitInit {
  return {
    id,
    model,
    team,
    position,
    facing,
    gunnery,
    piloting,
    pilotHitMax,
    policy: { ...policy },
  };
}

/** One declared weapon shot.
 *
 * Immutable: all fields are `readonly`, so instances are assigned (shared by reference), never copied. */
export interface WeaponAttackDecl {
  readonly weaponIndex: number;
  readonly targetId: string;
  /** Request a rapid-fire (double-tap) volley; only valid on rapid-fire weapons. Defaults off. */
  readonly rapidFire?: boolean;
  /** Firing arc of the target relative to the ATTACKER's facing, classified at
   *  declaration time. Drives per-weapon fire legality (TW p.105 hex
   *  template; every hex falls wholly in one arc). */
  readonly arc?: Arc;
  /** Attack direction: the side of the TARGET the attack strikes (TW p.107),
   *  classified from the target's facing at declaration time. Drives the
   *  hit-location table column and the front/rear armor pool. A boundary
   *  line takes the hexside of the chosen LOS chain (`attackDirectionFor`). */
  readonly attackDirection?: Arc;
  /** Multiple-targets to-hit modifier (TW p.108), classified at declaration
   *  against the attacker's twisted facing: +1 for a secondary target in the
   *  forward arc, +2 in a side/rear arc. Absent for the primary target. */
  readonly secondaryMod?: SecondaryTargetMod;
}

export type { SecondaryTargetMod };

/** One step of a declared move. Immutable: all fields are `readonly`, so instances are assigned (shared by reference), never copied. */
export type MoveStep =
  | { readonly kind: "enter"; readonly to: HexCoord }
  | { readonly kind: "turn"; readonly facings: number };

/** Weapon half of a merged `attacksDeclared` event: one entry per distinct
 *  weapon target — resolved range fields (from the target's first declared
 *  weapon), declaration count, and the multiple-targets status (TW p.108). */
export interface DeclaredWeaponVolley {
  readonly targetId: string;
  readonly count: number;
  readonly distance: number;
  readonly rangeBracket: string;
  readonly rangeMod: number;
  /** Multiple-targets to-hit modifier: 0 primary, +1 forward-arc secondary, +2 side/rear. */
  readonly secondaryMod: 0 | SecondaryTargetMod;
}

/** Physical half of a merged `attacksDeclared` event: one entry per
 *  declared physical attack (two-arm punches may name different targets;
 *  strikes name the mounted physical weapon used). */
export interface DeclaredPhysicalAttack {
  readonly type: PhysicalAttackType;
  readonly targetId: string;
  readonly weapon?: PhysicalWeaponName;
}

/** Off-line status of a unit. `"not"` = online; any other value = shut down.
 *  `"manual"` persists until a voluntary startup roll succeeds, `"heat"`
 *  auto-restarts in the heat phase once heat drops. */
export type ShutdownState = "manual" | "heat" | "not";

/** Physical destruction state of a unit: "not" = intact. Reason tracks
 *  which kill condition ended the 'Mech (head/CT IS depleted, cockpit
 *  crit, head blown off, or three engine crits). */
export type DestroyedReason =
  | "headDestroyed"
  | "centerTorsoDestroyed"
  | "cockpitDestroyed"
  | "headBlownOff"
  | "engineDestroyed";
export type DestroyedState = "not" | DestroyedReason;

/** Club source / held-club kind (TW p.146): a severed limb, an uprooted
 *  tree, or a girder pried from rubble. */
export type ClubKind = "limb" | "tree" | "girder";

export interface HeldLimbClub extends MechModelHolder {
  readonly kind: "limb";
  readonly limb: LimbLocation;
  readonly model: string;
  readonly ownerId: string | null;
}

/** A club carried by a unit. A limb club records which severed limb it is
 *  and the model it came from (`ownerId` null for a limb the map placed);
 *  trees and girders carry no per-item identity (trees are consumed on a
 *  successful hit, girders are reusable indefinitely).
 *
 *  Immutable: all fields are `readonly`, so instances are assigned (shared by reference), never copied. */
export type HeldClub = HeldLimbClub | { readonly kind: "tree" } | { readonly kind: "girder" };

/** Pickup request: which source to take. Omitted resolves at declaration
 *  time: the hex's single club token, else terrain (tree, then girder).
 *  `tokenIndex` (1-based) picks one of several tokens in the hex.
 *
 *  Immutable: all fields are `readonly`, so instances are assigned (shared by reference), never copied. */
export interface ClubPickupDecl {
  readonly source?: ClubKind;
  readonly tokenIndex?: number;
}

/** A pickup as declared (`UnitState.declaredPickup`): the source
 *  `validatePickup` resolved, plus the ground token when one was chosen.
 *  Resolution re-finds `token` by value, so a token list that changed since
 *  declaration cannot shift it.
 *
 *  Immutable: all fields are `readonly`, so instances are assigned (shared by reference), never copied. */
export interface DeclaredPickup {
  readonly source: ClubKind;
  readonly token?: ClubGroundToken;
}

/** A club lying in a hex, available for pickup (TW p.146): a severed limb
 *  (model recorded; owner recorded so a pickup can void its salvage, null
 *  for a limb the map placed), or a dropped tree /
 *  girder, which stays intact and is re-taken without a roll. Fresh trees
 *  and girders still in terrain leave no token.
 *
 *  Immutable: all fields are `readonly`, so instances are assigned (shared by reference), never copied. */
export type ClubGroundToken =
  | {
      readonly kind: "limb";
      readonly limb: LimbLocation;
      readonly model: string;
      readonly ownerId: string | null;
    }
  | { readonly kind: "tree" }
  | { readonly kind: "girder" };

/** A severed arm or leg. `salvageable` starts true and drops to false the
 *  first time the limb is picked up (house rule; TW has no salvage values). */
export interface SeveredLimb {
  readonly limb: LimbLocation;
  salvageable: boolean;
}

/** Girder-search target numbers by rubble origin (TW p.146): 7+ from
 *  medium rubble, 6+ from heavy, 5+ from hardened. Light rubble yields no
 *  girders. */
export const GIRDER_SEARCH_TARGET: Readonly<Partial<Record<BuildingTerrainType, number>>> = {
  mediumBuilding: 7,
  heavyBuilding: 6,
  hardenedBuilding: 5,
};

/** One consciousness roll: 2D6 `roll` against `target`, the table number
 *  for `hits` total pilot hits (TW p.42). */
export interface ConsciousnessRoll {
  readonly roll: number;
  readonly target: number;
  readonly hits: number;
}

/** Why the pilot took damage. Drives the `pilotDamaged` event `reason`
 *  field and the `applyPilotHits` parameter; both stay typed so web and
 *  tests can pattern-match exhaustively. */
export type PilotHitReason =
  | "headHit"
  | "ammoExplosion"
  | "fall"
  | "shutdownFall"
  | "lifeSupport"
  | "ejection";

/** Removal from play: "not" = on the board and active. "destroyed" = unit
 *  killed (paired with a DestroyedState reason); it leaves the board.
 *  "pilotEjected" = pilot ejected, "pilotKilled" = six pilot hits,
 *  "pilotAbandoned" = pilot stepped out of a shut-down 'Mech (house rule
 *  adapted from TO:AR p.165). Those three leave the frame on the board as a
 *  neutral hull (TO:AR pp.184-185, see `isHull`) while it is not destroyed. */
export type RemovalReason = "destroyed" | "pilotEjected" | "pilotKilled" | "pilotAbandoned";
export type RemovedState = "not" | RemovalReason;
export type ActorPhase = "movement" | "attack";
export type Phase = "initiative" | ActorPhase | "end";
export type ShutdownCheckResult = "heat" | "shutdown" | "unconscious" | "manual" | "avoid";
export type RestartCheckResult = "success" | "fail" | "heat" | "unconscious";

export type UnitFallReason =
  | "legDestroyed"
  | "gyroDestroyed"
  | "shutdown"
  | "rubble"
  | "water"
  | "building"
  | "voluntaryDrop";

/** Trigger for one Piloting Skill Roll (TW p.59-60). Typed so the web log
 *  can render a per-situation message from the event instead of parsing a
 *  free-form string. */
export type PilotingCheckReason =
  | "damage20"
  | "legActuator"
  | "hip"
  | "gyro"
  | "runDamaged"
  | "jumpDamaged"
  | "shutdown"
  | "seatbelt"
  | "standUp"
  | "rubble"
  | "water1"
  | "water2"
  | "water3"
  | "building"
  | "kick"
  | "kickMiss"
  | "chargeTarget"
  | "chargeMade"
  | "dfaMade"
  | "ejection";

/** Why a 'Mech fell (TW p.68). `failedPsr` carries the PSR trigger that
 *  failed; `terrain` covers automatic falls while entering terrain
 *  (shut-down/unconscious) plus failed terrain-entry falls. */
export type UnitFallCause =
  | { readonly kind: "failedPsr"; readonly reason: PilotingCheckReason }
  | { readonly kind: "legDestroyed" }
  | { readonly kind: "gyroDestroyed" }
  | { readonly kind: "shutdown" }
  | { readonly kind: "terrain"; readonly terrain: "rubble" | "water" | "building" }
  | { readonly kind: "buildingCollapse" }
  | { readonly kind: "dfaMiss" }
  | { readonly kind: "voluntaryDrop" }
  /** Salvage fall (TW p.128): a 'Mech destroyed in a phase it stood in
   *  falls automatically; the damage marks its record for salvage. */
  | { readonly kind: "salvageFall" };

export interface UnitState extends MechModelHolder {
  readonly id: string;
  readonly model: string;
  readonly team: number;
  gunnery: number;
  /** Piloting skill (TW regular = 5); drives every Piloting Skill Roll. */
  piloting: number;
  /** Pilot hits taken (0..pilotHitMax; reaching it kills the pilot). */
  pilotHits: number;
  /** Pilot hit capacity (default 6). Remaining HP = pilotHitMax - pilotHits. */
  pilotHitMax: number;
  /** Turn the pilot was knocked out on (no wake attempt that turn); null while
   *  conscious. The only record of consciousness: read it through
   *  `isPilotUnconscious`. An unconscious pilot's unit cannot act and counts as
   *  immobile until it wakes in a later end phase. */
  unconsciousSinceTurn: number | null;
  /** True while the 'Mech lies on the ground (fell or dropped). */
  prone: boolean;
  position: HexCoord;
  facing: Facing;
  damage: UnitDamageState;
  /** Per-slot destroyed flag for each location's crit slot table. */
  critSlotsDestroyed: CritMask;
  /** Per-crit-slot ammo state: identity + remaining shots (see
   *  `src/rules/ammo.ts`). Per-weapon totals are derived on demand. */
  ammoBins: AmmoBins;
  /** Which of a unit's ammo bins the next shot is drawn from. */
  ammoPolicy: AmmoPolicy;
  /** Auto-eject system engaged (from `UnitPolicy.autoEject`). */
  autoEject: boolean;
  /** Flamers fire in heat mode (from `UnitPolicy.heatFlamer`). */
  heatFlamer: boolean;
  jammedWeapons: number[];
  /** Arms and legs blown off by critical hits (TW p.124, 145), with their
   *  salvage flag. A severed limb can be picked up as a club (TW p.146). */
  blownOffLimbs: SeveredLimb[];
  /** Armor + structure points each other unit has dealt to this one over the
   *  battle, keyed by attacker id: weapon and physical attacks (with the
   *  critical-hit blasts they set off) and accidental falls onto it. */
  damageTakenFrom: Record<string, number>;
  /** Club currently carried (TW p.146). While held, both hands are occupied:
   *  punch and strike declarations plus arm-mounted weapon fire are
   *  rejected until the club is dropped or consumed. */
  club: HeldClub | null;
  /** Pickup declaration for this attack phase (TW p.146). Exclusive with
   *  every weapon and physical declaration: the pickup turn allows no
   *  attacks at all. Acquisition resolves in the physical sub-pass. */
  declaredPickup: DeclaredPickup | null;
  moveMode: MoveMode | null;
  /** Hexes counting toward the target movement modifier: those since the
   *  last direction reversal (TW p.107). */
  hexesMovedThisTurn: number;
  jumpedThisTurn: boolean;
  mpSpent: number;
  /** Current heat scale value (TW p. 159: 0-30 scale plus unbounded
   *  overflow above 30). Movement and
   *  weapon heat accumulate during the turn; dissipation runs in the end
   *  phase. */
  heat: number;
  /** Own heat generated this turn that has not yet been applied to the
   *  scale. Movement, weapon, posture, and engine-crit heat all accumulate
   *  here during their producing phases and land on the scale only in the
   *  end phase (TW p.159 single-step net update). Reset to 0 by the heat
   *  phase. The to-hit modifier used during this turn's weapon attack
   *  phase reads `heat` (not `heat + heatPending`), matching TW p.160. */
  heatPending: number;
  /** Outside heat received this turn from heat-causing weapons (TW p.159),
   *  tallied apart from own heat and capped at
   *  {@link OUTSIDE_HEAT_CAP} when the Heat Phase applies it. Reset to 0 by
   *  the heat phase. */
  heatExternalPending: number;
  /** Shutdown state: "manual" (voluntary), "heat" (automatic, restartable in
   *  the heat phase) or "not" (online). Anything but "not" counts
   *  as shut down: cannot move, fire, or act as the next actor. */
  shutdown: ShutdownState;
  declaredWeaponAttacks: WeaponAttackDecl[];
  /** Physical attack declarations (punch, kick, club, strike) for this phase. */
  declaredPhysicalAttacks: PhysicalAttackDecl[];
  /** True if the unit explicitly passed on declaring attacks this phase. */
  passedAttacks: boolean;
  /** Charge or DFA declared by this turn's movement (TW pp.148-150). The
   *  unit stopped in the hex before the target and attacks nothing else; the
   *  attack resolves in the physical sub-pass. Cleared after it. */
  meleeCharge: MeleeCharge | null;
  destroyed: DestroyedState;
  removed: RemovedState;
}

/** A charge or DFA declared by movement (see `UnitState.meleeCharge`). */
export interface MeleeCharge {
  readonly kind: "charge" | "dfa";
  readonly targetId: string;
  /** The target's hex when declared; reserved for the attacker (nobody else
   *  may end movement there) in case the target leaves it. A shared
   *  `HexCoord`, not a copy. */
  readonly hex: HexCoord;
  /** Hex the move started in: a DFA reads its attack direction from here
   *  (TW p.150). */
  readonly from: HexCoord;
  /** A DFA'er whose weapon-phase piloting roll failed does not fall; the DFA
   *  automatically misses instead (TW p.149). */
  missed: boolean;
}

/** Attack-phase resolution boundaries, in order. */
export type AttackPhaseStage = "begin" | "weaponDone" | "physicalDone" | "end";

export type GameEvent =
  | {
      readonly kind: "phase";
      readonly prevTurn: number;
      readonly prevPhase: Phase;
      readonly turn: number;
      readonly phase: Phase;
    }
  | {
      readonly kind: "initiative";
      readonly rolls: Readonly<Record<number, number>>;
      readonly winnerTeam: number;
    }
  | { readonly kind: "moveDeclared"; readonly unitId: string; readonly mode: MoveMode }
  | {
      readonly kind: "moved";
      readonly unitId: string;
      readonly mode: MoveMode;
      readonly prevMode: MoveMode;
      readonly position: HexCoord;
      readonly facing: Facing;
      readonly mpSpent: number;
      readonly mpBudget: number;
      /** Set when the move ended against an enemy: the unit stopped in front
       *  of the target (`position`) and the charge (walk / run) or DFA (jump)
       *  resolves in the physical phase (TW pp.148-150). */
      readonly pendingCharge?: {
        readonly attack: "charge" | "dfa";
        readonly targetId: string;
        readonly targetHex: HexCoord;
      };
    }
  | {
      readonly kind: "attacksDeclared";
      readonly unitId: string;
      /** Weapon volleys, one per target (primary first); empty when the
       *  declaration holds no weapon attacks. */
      readonly weapons: readonly DeclaredWeaponVolley[];
      /** Declared physical attacks (possibly empty). */
      readonly physical: readonly DeclaredPhysicalAttack[];
    }
  | {
      /** Attack-phase resolution boundaries: weapon pass begin..weaponDone
       *  (incl. its pilot hits and PSR sweep), physical pass
       *  weaponDone..physicalDone, then physicalDone..end = physical pilot
       *  hits + PSR sweep + heat resolution. `end` lands right before the
       *  attack -> end `phase` event. */
      readonly kind: "attackPhaseStage";
      readonly stage: AttackPhaseStage;
      readonly turn: number;
    }
  | {
      readonly kind: "attackResolved";
      readonly unitId: string;
      readonly targetId: string;
      /** Multiple-targets to-hit modifier applied: 0 primary, +1/+2 secondary. */
      readonly secondaryMod: 0 | SecondaryTargetMod;
      readonly resolution: AttackResolution;
    }
  | {
      readonly kind: "physicalAttackResolved";
      readonly unitId: string;
      readonly targetId: string;
      readonly resolution: PhysicalResolution;
    }
  | {
      /** Club pickup declared (TW p.146): exclusive with every weapon and
       *  physical declaration — the pickup turn allows no attacks at all.
       *  `source` is resolved at declaration time (limb > terrain). */
      readonly kind: "pickupDeclared";
      readonly unitId: string;
      readonly source: ClubKind;
    }
  | {
      /** A unit fell two or more levels onto an occupied hex (TW p.152). */
      readonly kind: "accidentalFall";
      readonly unitId: string;
      readonly targetId: string;
      readonly toHit: number;
      readonly roll: number;
      readonly hit: boolean;
      readonly damage: number;
    }
  | {
      /** Club pickup resolved in the physical sub-pass. Limb/tree success
       *  sets the unit's held club; girder success needs `roll >= required`
       *  (7+/6+/5+ by rubble origin, TW p.146). `reason` explains failures
       *  (`noSource` | `attackerDown`). */
      readonly kind: "clubPickedUp";
      readonly unitId: string;
      readonly success: boolean;
      readonly clubKind?: ClubKind;
      readonly roll?: number;
      readonly required?: number;
      readonly reason?: string;
    }
  | {
      /** Held club dropped as the first act of an attack declaration: hands
       *  are free for the rest of the declaration. Every kind stays intact
       *  in the hex as a token (`returned: true`). `cause` marks
       *  involuntary drops (fall, or the holder leaving play). */
      readonly kind: "clubDropped";
      readonly unitId: string;
      readonly clubKind: ClubKind;
      readonly col: number;
      readonly row: number;
      readonly returned: boolean;
      readonly cause?: "fall" | "removed" | "hands";
    }
  | {
      /** Uprooted tree consumed by a successful club hit (TW p.146: good
       *  for one successful club attack only). Limb/girder clubs persist. */
      readonly kind: "clubConsumed";
      readonly unitId: string;
      readonly clubKind: ClubKind;
    }
  | {
      readonly kind: "unitRemoved";
      readonly unitId: string;
      readonly reason: RemovalReason;
      readonly destroyReason?: DestroyedReason | null;
      /** Kill credit ({@link killCredit}): enemy units that damaged this one
       *  in the resolution that removed it, with their share. Empty when none
       *  did (heat, falls, ejection, abandonment), and on the second
       *  `unitRemoved` of a hull later destroyed (credited once, when it
       *  left play). */
      readonly credit: readonly KillCredit[];
    }
  // Pilot ejects (`ejectPilot`), dies (`removePilotKilled`) or abandons the
  // 'Mech (`abandonPilot`): `unitRemoved` with that reason; an intact frame
  // stays on the board as a hull. A destroyed hull emits `unitRemoved` with
  // reason "destroyed" while the unit keeps its pilot removal reason.
  | {
      /** Battlefield wreckage (TO:AR p.155): a destroyed 'Mech of 40 t or
       *  more turned its hex into Rough. */
      readonly kind: "wreckageLeft";
      readonly unitId: string;
      readonly col: number;
      readonly row: number;
    }
  | {
      readonly kind: "buildingCollapsed";
      readonly col: number;
      readonly row: number;
    }
  | {
      readonly kind: "buildingDamaged";
      readonly col: number;
      readonly row: number;
      readonly damage: number;
      /** Structural factor remaining after the hit (0 when collapsed). */
      readonly cf: number;
    }
  | {
      readonly kind: "collapseDamage";
      readonly unitId: string;
      readonly col: number;
      readonly row: number;
      readonly location: Location;
      readonly damage: number;
    }
  | {
      readonly kind: "heatMove";
      readonly unitId: string;
      readonly heat: number;
      /** Scale value at the time of the action (= previous turn's end).
       *  Same value the weapon attack phase uses for to-hit this turn. */
      readonly base: number;
      /** Cumulative own heat generated this turn for this unit, including
       *  this push. Equals `unit.heatPending` after the event. */
      readonly totalGenerated: number;
    }
  | {
      readonly kind: "heatWeapon";
      readonly unitId: string;
      readonly heat: number;
      readonly base: number;
      readonly totalGenerated: number;
    }
  | {
      /** A heat-causing weapon hit (TW p.113): `heat` joins the target's
       *  outside heat for its next Heat Phase. */
      readonly kind: "heatInflicted";
      readonly unitId: string;
      readonly targetId: string;
      readonly weapon: string;
      readonly heat: number;
      readonly source: "asHeat" | "extraHeat";
      /** Target's outside heat tallied this turn, including this hit
       *  (= `heatExternalPending` after the event; uncapped). */
      readonly totalReceived: number;
    }
  | {
      /** Outside heat landing on the scale in the Heat Phase (TW p.159):
       *  `applied = min(received, 15)`, the rest is `wasted`. */
      readonly kind: "heatExternal";
      readonly unitId: string;
      readonly received: number;
      readonly applied: number;
      readonly wasted: number;
    }
  | {
      readonly kind: "heatEngineCrit";
      readonly unitId: string;
      readonly heat: number;
      readonly base: number;
      readonly totalGenerated: number;
    }
  | {
      readonly kind: "heatDissipated";
      readonly unitId: string;
      readonly dissip: number;
      /** Scale value entering the heat phase (pre-own-heat application). */
      readonly startHeat: number;
      /** Sum of own heat generated this turn (= `heatPending` at phase
       *  entry). */
      readonly totalGenerated: number;
      /** Outside heat applied this phase after the 15 cap (TW p.159; see
       *  `heatExternal`); 0 when none. */
      readonly external: number;
      /** Scale value after dissipation (= `unit.heat` after this event). */
      readonly endHeat: number;
      /** Net change this turn = endHeat - startHeat. */
      readonly netChange: number;
      readonly capacity: number;
      readonly capacityMax: number;
    }
  | {
      readonly kind: "shutdownCheck";
      readonly unitId: string;
      readonly result: ShutdownCheckResult;
      // readonly avoided: boolean;
      readonly manual: boolean;
      /** Unconscious pilot: no avoid roll was allowed (TW p.160). */
      // readonly unconscious?: boolean;
      readonly roll: number;
      readonly heat: number;
      readonly avoid: number;
      readonly threshold: number;
    }
  | {
      readonly kind: "restartCheck";
      readonly unitId: string;
      // readonly success: boolean;
      readonly result: RestartCheckResult;
      readonly manual: boolean;
      /** Set when no roll was allowed: heat 30+ or an unconscious pilot. */
      // readonly blocked?: "heat" | "unconscious";
      readonly roll: number;
      readonly heat: number;
      readonly avoid: number;
      readonly threshold: number;
    }
  | {
      readonly kind: "ammoExplosionCheck";
      readonly unitId: string;
      readonly weapon: string;
      readonly location: Location;
      readonly slotIndex: number;
      readonly roll: number;
      readonly avoid: number;
      readonly heat: number;
      readonly threshold: number;
      readonly shotsRemaining: number;
      readonly damage: number;
      readonly damagePerShot: number;
      readonly avoided: boolean;
      /** Follow-up criticals rolled for structure the blast damaged. */
      readonly crits?: readonly CriticalResolution[];
    }
  | {
      /** One Piloting Skill Roll (TW p.59). `roll` is null when the outcome
       *  was automatic (target <= 2 auto-success, target > 12 auto-fall).
       *  The UI derives `modifier = triggerModifier + preexistingModifier`
       *  and `target = basePiloting + modifier` from these components. */
      readonly kind: "pilotingCheck";
      readonly unitId: string;
      readonly reason: PilotingCheckReason;
      readonly basePiloting: number;
      readonly triggerModifier: number;
      readonly preexistingModifier: number;
      readonly roll: number | null;
      readonly success: boolean;
      /** Hex the roll is about (terrain entry, fall site, stand-up spot). */
      readonly hex?: HexCoord;
    }
  | {
      /** The 'Mech falls (TW p.68): facing rotates per the Facing After
       *  Fall roll and the damage clusters land on that column. `crits`
       *  holds the determining resolutions the fall damage triggered.
       *  A voluntary drop reuses this shape with
       *  `cause: { kind: "voluntaryDrop" }`:
       *  facing stays put, so `fallRoll` is null, and TW p.49 causes no
       *  falling damage, so `groups`/`crits` are empty. The fall's damage is
       *  `damageGroupsTotal(groups)`. */
      readonly kind: "unitFell";
      readonly unitId: string;
      readonly cause: UnitFallCause;
      /** Hex the 'Mech fell in (or onto, for multi-level falls). */
      readonly hex?: HexCoord;
      readonly facingAfter: Facing;
      /** Facing After Fall roll, or null when no facing roll happened. */
      readonly fallRoll: number | null;
      readonly column: Arc;
      /** Underlying-terrain levels fallen (0 for a same-hex fall). */
      readonly levelsFallen: number;
      readonly groups: readonly DamageGroup[];
      readonly crits: readonly CriticalResolution[];
      /** Set when the 'Mech was an empty hull: it fell without a roll (the
       *  `cause` names the PSR trigger it could not answer, TW p.60) and no
       *  MechWarrior took damage. */
      readonly hull?: true;
    }
  | {
      /** One event per damage source (one `applyPilotHits` call). */
      readonly kind: "pilotDamaged";
      readonly unitId: string;
      readonly reason: PilotHitReason;
      /** Points applied by this source (>= 1; fewer than dealt once dead). */
      readonly hits: number;
      /** Pilot hits after all of this source's points. */
      readonly totalHits: number;
      /** Pilot HP left afterwards (pilotHitMax - totalHits, floored at 0). */
      readonly hpRemaining: number;
    }
  | {
      /** Consciousness rolls for one damage source, or the End Phase
       *  recovery roll (TW p.42). Damage rolls stop at the first failure. */
      readonly kind: "consciousnessCheck";
      readonly unitId: string;
      readonly cause: PilotHitReason | "recovery";
      /** Rolls actually made, in order. */
      readonly rolls: readonly ConsciousnessRoll[];
      /** Rolls the damage demanded (m): one per point taken while conscious,
       *  a killing point excluded. Recovery = 1. */
      readonly required: number;
      /** 1-based index (n) of the failing roll, or null when all passed. */
      readonly failedAt: number | null;
      /** True when every roll made passed (`failedAt === null`). */
      readonly success: boolean;
      /** Conscious before these rolls (false for recovery). */
      readonly consciousBefore: boolean;
    }
  | {
      /** Building-entry PSR failed (TW p.167): the crash damages the 'Mech
       *  (ceil(CF / 10) in 5-point groups on the front column, or the rear
       *  column when it backed in) but never knocks it down. `crits` holds
       *  the determining resolutions. */
      readonly kind: "buildingCrash";
      readonly unitId: string;
      readonly col: number;
      readonly row: number;
      readonly column: "front" | "rear";
      readonly groups: readonly DamageGroup[];
      readonly crits: readonly CriticalResolution[];
    };

interface UnitAttackResolution {
  readonly targetId: string;
  readonly secondaryMod: 0 | SecondaryTargetMod;
  readonly resolution: AttackResolution;
  readonly weaponHeat: number;
  readonly buildingDamage: number;
  /** Leg hits that struck a building serving as partial cover (TW p.102). */
  readonly coverBuilding?: { readonly hex: HexCoord; readonly damage: number };
}

export interface UnitAttackResult {
  readonly unitId: string;
  readonly resolutions: readonly UnitAttackResolution[];
  readonly jammedWeapons: readonly number[];
}

export interface BattleState extends HexGrid {
  turn: number;
  phase: Phase;
  initiativeWinnerTeam: number | null;
  units: Record<string, UnitState>;
  /** When true, critical hit resolution is suppressed at attack time. */
  critsDisabled: boolean;
  actedThisPhase: string[];
  /** Activation order for the current phase, built lazily on first query
   *  from the roster as it stands then, and kept until the next phase
   *  transition. Not a pure cache: rebuilding mid-phase reads the current
   *  roster, so a unit that left play or changed shutdown state since would
   *  shift the alternation (e.g. a unit destroyed during its own move would
   *  let its team move twice in a row). Snapshots keep it for that reason. */
  actorQueue: string[] | null;
  /** Building state keyed by hex `"col,row"`; only building hexes present. */
  buildings: Record<string, BuildingState>;
  /** Severed limbs lying in hexes, keyed by `"col,row"` (TW p.146). A
   *  blown-off arm or leg stays where it was lost until picked up. */
  clubs: Record<string, ClubGroundToken[]>;
  /** Building sub-type a rubble hex collapsed from, keyed by `"col,row"`.
   *  Drives girder-search eligibility (TW p.146: medium/heavy/hardened
   *  only). Hexes that started as rubble have no entry and yield nothing. */
  rubbleOrigin: Record<string, BuildingTerrainType>;
  /** Battlefield wreckage (TO:AR p.155), keyed by hex `"col,row"`: the
   *  destroyed 'Mechs of 40 t or more lying there, in order. The hex
   *  counts as Rough stacked on its terrain (+1 MP, see `hasWreckage`); no
   *  LOS, to-hit or PSR effect. */
  wreckage: Record<string, WreckageEntry[]>;
  /** The latest damage window (see `DealtWindow`): set when a window
   *  starts, left in place after it, never saved in snapshot. Undefined until the first
   *  window and after a snapshot load. */
  currentDealt?: DealtWindow;
}

/** One destroyed frame lying as wreckage (TO:AR p.155).
 *
 *  Immutable: all fields are `readonly`, so instances are assigned (shared by reference), never copied. */
export interface WreckageEntry extends MechModelHolder {
  readonly model: string;
  /** The destroyed unit; null for wreckage the map placed. */
  readonly unitId: string | null;
}

export type { TerrainHexDef };

export interface CreateBattleOptions {
  /**
   * Disable critical hit resolution. Tests that script dice for narrow
   * damage scenarios (where any crit would alter the expected outcome) can
   * set this to `true` so the engine follows the scripted RNG only for the
   * attack and location rolls.
   */
  readonly critsDisabled: boolean;
}

export const DEFAULT_CREATE_BATTLE_OPTION: CreateBattleOptions = {
  critsDisabled: false,
};

export function requireUnit(state: BattleState, unitId: string): UnitState {
  const unit = state.units[unitId];
  if (!unit) throw new Error(`Unknown unit id: ${unitId}`);
  return unit;
}

/**
 * Enforce that `unitId` is the next pending actor for the given phase.
 * Drives off `pendingActors` so the same exclusions apply: removed, shut-down
 * (weapon phase), unconscious, and already-acted or passed units are not
 * eligible. Callers must pass the head-of-queue unit, otherwise the engine
 * rejects the action. Matches TW turn flow.
 */
function requireCurrentActor(state: BattleState, unitId: string, phase: ActorPhase): void {
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

/** Tonnage of the unit's mech chassis. Reads the catalog def; throws on
 *  unknown models. TW weight class boundaries run 20/35/55/75/100; rule code
 *  using tonnage (e.g. the wreckage threshold, `WRECKAGE_TONNAGE_MIN`) keys
 *  off the raw `tonnage` field, not the human-friendly `weightClass` label. */
function unitTonnage(h: MechModelHolder): number {
  return mechDefFor(h).tonnage;
}

export function isNominal(unit: UnitState) {
  return unit.shutdown === "not";
}

export function isShutdown(unit: UnitState) {
  return unit.shutdown !== "not";
}

export function isImmobile(unit: UnitState) {
  return (
    isHull(unit) || isShutdown(unit) || isPilotUnconscious(unit) || isUnitImmobile(unit.damage)
  );
}

/** Out of play as an actor: destroyed, or its pilot gone (a hull still sits
 *  on the board, see `isUnitOnBoard`). */
export function isUnitRemoved(unit: UnitState): boolean {
  return unit.removed !== "not";
}

/** Active on the board: can move, attack and make heat choices. */
export function isUnitAvailable(unit: UnitState): boolean {
  return unit.removed === "not";
}

/** An abandoned 'Mech (TO:AR pp.184-185): the pilot is gone (ejected,
 *  killed or stepped out) and the frame is intact. It stays on the board as
 *  a neutral, permanently shut-down unit that both sides may target, that
 *  any unit may move through but none may end movement on, and that never
 *  rolls a PSR (an event that would call for one drops it, TW p.60). */
export function isHull(unit: UnitState): boolean {
  return (
    (unit.removed === "pilotEjected" ||
      unit.removed === "pilotKilled" ||
      unit.removed === "pilotAbandoned") &&
    unit.destroyed === "not"
  );
}

/** On the board: an active unit or a hull. Destroyed units are not. */
export function isUnitOnBoard(unit: UnitState): boolean {
  return unit.removed === "not" || isHull(unit);
}

/** True when `unit` may be the target of `attacker`'s weapon or physical
 *  attack as far as sides go: any enemy, or a hull of either team. */
export function isTargetableBy(attacker: UnitState, target: UnitState): boolean {
  return isHull(target) || target.team !== attacker.team;
}

/**
 * Partial-cover to-hit modifier against `target` from `attacker`:
 *  - water1 target hex: +1 for a standing 'Mech, regardless of relative
 *    elevation (TW p.102: water surrounds it, applies even when attacker higher).
 *  - building target hex: +1 for a standing 'Mech when attacker level ≤
 *    target level (target's own hex, attacker not firing downhill).
 *  - intervening higher hex (TW p.102): +1 for a standing 'Mech when an
 *    adjacent hex lies between attacker and target, is at least one level
 *    above the target's underlying hex, and attacker LOS level ≤ target LOS
 *    level (attacker not firing downhill).
 * Partial cover comes only from terrain (TW p.102): hulls and wreckage give
 * none. Leg hit-location rolls strike the cover under any non-zero value
 * (see `hitLocationCovered` in `src/rules/attack.ts`). On a hexside line the
 * intervening hex comes from the chain `losSideFor` locks in (LOS-02).
 */
export function partialCoverMod(
  state: BattleState,
  attacker: UnitState,
  target: UnitState,
  side: LosSide = losSideFor(state, attacker, target),
): number {
  return partialCoverDetail(state, attacker, target, side).mod;
}

/** The building hex providing the terrain partial cover to `target`, if the
 *  cover is a building (TW p.102: leg hits strike it and damage it). */
export function partialCoverBuildingHex(
  state: BattleState,
  attacker: UnitState,
  target: UnitState,
  side: LosSide = losSideFor(state, attacker, target),
): HexCoord | undefined {
  return partialCoverDetail(state, attacker, target, side).buildingHex;
}

/**
 * The hexside chain the defender locks in between `attacker` and `target`
 * (TW pp.99, 101): woods, partial cover, the to-hit preview and the attack
 * direction all read this one chain, so woods on one side never adds to
 * cover on the other (LOS-02). To-hit decides the pick; the attack direction
 * only breaks a tie. `prone` defaults to the pair's `losEnds`.
 */
export function losSideFor(
  state: BattleState,
  attacker: UnitState,
  target: UnitState,
  prone: ProneEnds | undefined = losEnds(state, attacker, target),
): LosSide {
  return defenderLosSide(
    state,
    attacker.position,
    target.position,
    prone,
    (side) => partialCoverDetail(state, attacker, target, side).mod,
    (side) => DEFENDER_ARC_RANK[attackDirectionOnSide(attacker, target, side)],
  );
}

/** How much the defender prefers being struck in each arc. */
const DEFENDER_ARC_RANK: Readonly<Record<Arc, number>> = {
  front: 2,
  leftSide: 1,
  rightSide: 1,
  rear: 0,
};

/**
 * Attack direction (TW p.119): the side of `target` that `attacker` strikes.
 * When the line meets the target's hex exactly at a corner between two
 * hexsides, it enters through the hexside facing the last hex of the chosen
 * chain (TW p.119 ties it to the TW p.99 LOS choice), so it follows
 * `losSideFor`.
 */
export function attackDirectionFor(
  state: BattleState,
  attacker: UnitState,
  target: UnitState,
  side: LosSide = losSideFor(state, attacker, target),
): Arc {
  return attackDirectionOnSide(attacker, target, side);
}

function attackDirectionOnSide(attacker: UnitState, target: UnitState, side: LosSide): Arc {
  const back = bearingExact(target.position, attacker.position)!;
  const dir = classifyArcWithBoundary(target.facing, back);
  if (dir.altArc === null) return dir.arc;
  const last = interveningHexes(attacker.position, target.position, side).at(-1);
  const entry = last !== undefined ? facingToward(target.position, last) : undefined;
  return entry !== undefined
    ? classifyArc(target.facing, entry)
    : defenderArcChoice(dir.arc, dir.altArc);
}

function partialCoverDetail(
  state: BattleState,
  attacker: UnitState,
  target: UnitState,
  side: LosSide,
): { mod: number; buildingHex?: HexCoord } {
  const targetTerrain = cellAt(state, target.position).terrain;
  const targetLevel = cellAt(state, target.position).level;
  const targetStandingGround = !target.prone;

  let terrain = 0;
  let buildingHex: HexCoord | undefined;
  if (targetStandingGround) {
    if (targetTerrain === "water1") {
      // TW p.102: water1 surrounds the 'Mech, applies even when attacker higher.
      terrain = PARTIAL_COVER_TERRAIN_MOD;
    } else {
      // Intervening higher hex (TW p.102): adjacent to target, between
      // attacker and target, at least one level above target's underlying
      // hex, attacker not firing downhill.
      const attackerLos = unitLosLevel(state, attacker.position, attacker.prone);
      const targetLos = unitLosLevel(state, target.position, false);
      if (attackerLos <= targetLos) {
        // On a hexside line only the chain the defender chose counts
        // (TW p.101).
        for (const h of interveningHexes(attacker.position, target.position, side)) {
          if (!isAdjacent(h, target.position)) continue;
          const cell = cellAt(state, h);
          const effectiveLevel = isBuildingTerrain(cell.terrain) ? cell.level + 2 : cell.level;
          if (effectiveLevel >= targetLevel + 1) {
            terrain = PARTIAL_COVER_TERRAIN_MOD;
            if (isBuildingTerrain(cell.terrain)) buildingHex = { ...h };
            break;
          }
        }
      }
    }
  }

  return buildingHex !== undefined ? { mod: terrain, buildingHex } : { mod: terrain };
}

function requirePhase(state: BattleState, phase: Phase): void {
  if (state.phase !== phase) {
    throw new Error(`Expected phase ${phase}, but battle is in ${state.phase}`);
  }
}

/** Unit on the board in `hex` (an active unit or a hull), if any. */
export function occupantAt(
  state: BattleState,
  hex: HexCoord,
  excludeId?: string,
): UnitState | undefined {
  for (const unit of Object.values(state.units)) {
    if (!isUnitOnBoard(unit) || unit.id === excludeId) continue;
    if (sameHex(unit.position, hex)) return unit;
  }
  return undefined;
}

/** Stacking view of `hex` for `reachableLandings`: the occupant's team, or
 *  `mv.NEUTRAL_TEAM` for a hull (passable by all, landable by none), or
 *  undefined when empty. */
export function occupantTeamAt(
  state: BattleState,
  hex: HexCoord,
  excludeId?: string,
): number | undefined {
  const occupant = occupantAt(state, hex, excludeId);
  if (occupant === undefined) return undefined;
  return isHull(occupant) ? mv.NEUTRAL_TEAM : occupant.team;
}

function cloneDamage(damage: UnitDamageState): UnitDamageState {
  return {
    armor: { ...damage.armor },
    armorRear: { ...damage.armorRear },
    internalStructure: { ...damage.internalStructure },
  };
}

/** The destroyed 'Mechs whose wreckage lies in `hex` (TO:AR p.155), in
 *  order; empty when the hex holds none. */
export function wreckageAt(state: BattleState, hex: HexCoord): readonly WreckageEntry[] {
  return state.wreckage[hexKey(hex)] ?? [];
}

/** True when battlefield wreckage lies in `hex`: ground entry pays its Rough
 *  surcharge (TO:AR p.155; `wreckageMoveCost`). */
export function hasWreckage(state: BattleState, hex: HexCoord): boolean {
  return wreckageAt(state, hex).length > 0;
}

/** Mark a unit as killed and removed, returning the paired events. The first
 *  kill wins: an already-destroyed unit keeps its recorded cause. A hull (an
 *  abandoned frame, see `isHull`) that is destroyed keeps its pilot removal
 *  reason, gains the frame's `destroyed` reason and leaves the board as
 *  wreckage; a pilot killed in the same step its 'Mech is destroyed is such a
 *  hull. `pilotDies` marks a destruction the MechWarrior does not survive
 *  (TW p. 128: center torso lost to an ammo/weapon blast with auto-eject off).
 *  Every destroyed frame takes the salvage fall and may leave wreckage (see
 *  `leaveDestroyedRemains`). */
/** One unit's share of a kill (`unitRemoved.credit`). */
export interface KillCredit {
  readonly unitId: string;
  /** Armor + structure points it dealt to the removed unit in the resolution
   *  that removed it. */
  readonly damage: number;
  /** `damage` over the total every enemy dealt; shares sum to 1. */
  readonly share: number;
}

/**
 * One damage window: a unit's move, the weapon sub-pass, the physical
 * sub-pass, or the heat phase, each closed by its piloting sweep
 * (`resolvePhasePiloting`). Each start assigns a fresh one to
 * `state.currentDealt` before any damage lands; it stays there until the
 * next start.
 */
export interface DealtWindow {
  /** Units in scope, as they stood when the window opened. */
  readonly before: PhaseSnapshots;
  /** Marked points per unit in scope (TW p.60 20-point trigger). */
  readonly total: PhaseDealt;
  /** Marked points per target, then per attacker: kill credit. */
  readonly byAttacker: Record<string, Record<string, number>>;
}

/**
 * Record `n` marked points `target` took, from `attackerId` (null: no
 * attacker, e.g. its own fall, recoil, heat or a collapse). They count toward
 * the window's 20-point total only when `target` is in the window's scope;
 * an attacker's points go to the battle-long `damageTakenFrom` and to the
 * window's kill credit.
 */
function creditDealt(
  state: BattleState,
  target: UnitState,
  attackerId: string | null,
  n: number,
): void {
  if (n <= 0) return;
  const window = state.currentDealt;
  if (window !== undefined && window.before.damage[target.id] !== undefined) {
    window.total[target.id] = (window.total[target.id] ?? 0) + n;
  }
  if (attackerId === null || attackerId === target.id) return;
  target.damageTakenFrom[attackerId] = (target.damageTakenFrom[attackerId] ?? 0) + n;
  if (window === undefined) return;
  const dealt = window.byAttacker[target.id] ?? {};
  dealt[attackerId] = (dealt[attackerId] ?? 0) + n;
  window.byAttacker[target.id] = dealt;
}

/**
 * Kill credit for `unit` as it leaves play: every enemy that damaged it in
 * the damage window that removed it (the weapon or physical sub-pass, with
 * its piloting sweep, or the move whose accidental fall hit it), by share of
 * the armor + structure points each dealt there. Attacks in a sub-pass
 * resolve simultaneously, so every hit in it shares the kill, not only the
 * last one resolved. Empty when no enemy dealt damage in it (heat, a
 * unit's own fall, ejection, abandonment). Largest share first, then unit
 * id.
 */
export function killCredit(state: BattleState, unit: UnitState): KillCredit[] {
  const dealt: [string, number][] = [];
  let total = 0;
  for (const [id, points] of Object.entries(state.currentDealt?.byAttacker[unit.id] ?? {})) {
    const attacker = state.units[id];
    if (attacker === undefined || attacker.team === unit.team || points <= 0) continue;
    dealt.push([id, points]);
    total += points;
  }
  return dealt
    .map(([unitId, damage]) => ({ unitId, damage, share: damage / total }))
    .sort((a, b) => b.damage - a.damage || (a.unitId < b.unitId ? -1 : 1));
}

function markUnitDestroyed(
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
  const headLoss = reason === "headDestroyed" || reason === "headBlownOff";
  // TO p.165: head destruction auto-ejects the pilot (cockpit crits still kill),
  // brought one hit short of death so the ejection roll decides survival.
  if (headLoss && unit.autoEject) {
    unit.pilotHits = Math.max(unit.pilotHits, unit.pilotHitMax - 1);
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
  if (reason === "cockpitDestroyed" || headLoss || pilotDies) {
    unit.pilotHits = Math.max(unit.pilotHits, unit.pilotHitMax);
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

/** Smallest 'Mech that leaves battlefield wreckage when destroyed (TO:AR
 *  p.155: "40 tons or more"). Lighter 'Mechs leave nothing on the board;
 *  their record is still kept for salvage. */
export const WRECKAGE_TONNAGE_MIN = 40;

/**
 * What a destroyed frame leaves behind. The unit's record and damage stay in
 * `state.units` for salvage reading.
 *  - Salvage fall (TW p.128): a 'Mech that was standing when destroyed falls
 *    automatically; the falling damage (and its criticals) marks its record,
 *    and a MechWarrior still alive in the cockpit takes the fall's pilot
 *    hit. An ejected pilot (auto-eject at this destruction, or a hull's pilot
 *    who left earlier) is outside the 'Mech and takes none.
 *  - Wreckage (TO:AR p.155): a 'Mech of {@link WRECKAGE_TONNAGE_MIN} t or
 *    more turns its hex into Rough (`state.wreckage`); a hex already holding
 *    wreckage just records the extra id (no pile-up).
 * `standing` is the posture before the destruction.
 */
function leaveDestroyedRemains(
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
 *  seatbelt roll for a dead 'Mech) and no consciousness roll: the
 *  MechWarrior is out of the battle. A pilot who ejected or abandoned is
 *  outside the 'Mech and takes none, as in `applyFall`. */
function salvageFall(state: BattleState, unit: UnitState, rng: Rng, sink: GameEvent[]): void {
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
  }
}

/** True while a destruction sweep may still record a kill on `unit`: it is
 *  on the board (an active unit or a hull, see `markUnitDestroyed`). */
function awaitsDestroyedMark(unit: UnitState): boolean {
  return isUnitOnBoard(unit);
}

/** Turn an active unit whose pilot is gone into a hull (`isHull`): it
 *  keeps its record, team, posture and hex, drops any club, and acts no
 *  more. Emits `unitRemoved` with `reason`. */
function leaveHull(
  state: BattleState,
  unit: UnitState,
  reason: "pilotEjected" | "pilotKilled" | "pilotAbandoned",
  sink: GameEvent[],
): void {
  releaseClub(state, unit, "removed", sink);
  unit.removed = reason;
  sink.push({ kind: "unitRemoved", unitId: unit.id, reason, credit: killCredit(state, unit) });
}

/** A pilot killed by six accumulated pilot hits removes the unit from play
 *  without destroying the 'Mech (TW p.41-42: the pilot is dead): the frame
 *  stays as a hull. If damage in the same step also destroyed the frame, the
 *  destruction sweep then turns the hull into wreckage. Emits a single
 *  `unitRemoved` event with reason "pilotKilled". */
function removePilotKilled(state: BattleState, unit: UnitState, sink: GameEvent[]): void {
  if (isUnitRemoved(unit)) return;
  leaveHull(state, unit, "pilotKilled", sink);
}

/** The single kill-reason derivation for every damage path (weapon,
 *  physical, fall/collapse, heat): the first crit resolution in `crits`
 *  that killed the unit decides (its `killedReason`, first kill in that
 *  cascade, blasts included); otherwise the location whose IS hit zero. */
function destroyedReasonFor(
  damage: UnitDamageState,
  crits?: readonly CriticalResolution[],
): DestroyedReason {
  for (const res of crits ?? []) {
    if (res.killedReason !== null) return res.killedReason;
  }
  if (damage.internalStructure.head <= 0) return "headDestroyed";
  if (damage.internalStructure.centerTorso <= 0) return "centerTorsoDestroyed";
  return "engineDestroyed";
}

/** Out of the game by damage alone: head or center torso gone, or three
 *  engine hits counting slots in destroyed locations (TW pp.125, 128). */
function isUnitWrecked(unit: UnitState): boolean {
  return (
    isUnitDestroyed(unit.damage) ||
    countDestroyedEngine(mechDefFor(unit), unit.damage, unit.critSlotsDestroyed) >=
      ENGINE_SLOTS_KILL
  );
}

/**
 * Resolve a model id named by a unit or by map debris, registering a catalog
 * sheet nobody has fielded yet (DATA-04). Only the exact canonical id counts:
 * a wrong-case id would be stored and later miss `mechDefFor`.
 */
function catalogModel(model: string): ResolvedMechDef | undefined {
  const def = ensureMechRegistered(model);
  // Not `def?.model === model`, which holds for a model of undefined.
  return def !== undefined && def.model === model ? def : undefined;
}

export function createBattle(
  map: MapDef,
  units: readonly UnitInit[],
  options: CreateBattleOptions = DEFAULT_CREATE_BATTLE_OPTION,
): BattleState {
  if (units.length < 2) throw new Error("A battle needs at least two units");
  const seen = new Set<string>();
  for (const init of units) {
    if (seen.has(init.id)) throw new Error(`Duplicate unit id: ${init.id}`);
    seen.add(init.id);
    if (!catalogModel(init.model)) throw new Error(`Unknown 'Mech model: ${init.model}`);
    if (!isValidPilotHitMax(init.pilotHitMax)) {
      throw new Error(`pilotHitMax(${init.pilotHitMax}) for ${init.id} must be an integer >= 1`);
    }
  }
  // Note: team ids are locked to 1|2 per unit (checked above), but a single
  // team is allowed here (rendering drills, movement fixtures). Real games
  // require both teams 1 and 2 via setupStartBattle.

  const unitStates: Record<string, UnitState> = {};
  for (const init of units) {
    const def: ResolvedMechDef = mechDefFor(init);
    const pilotHitMax = init.pilotHitMax ?? DEFAULT_PILOT_HIT_MAX;
    const start = resolveInitialDamage(def, init.id, init.damage, pilotHitMax);
    const { damage, ammoBins } = start;
    unitStates[init.id] = {
      id: init.id,
      model: init.model,
      team: init.team,
      gunnery: init.gunnery,
      piloting: init.piloting,
      pilotHits: start.pilotHits,
      pilotHitMax,
      unconsciousSinceTurn: null,
      prone: start.prone,
      position: init.position,
      facing: init.facing,
      damage,
      ammoBins,
      ammoPolicy: init.policy.ammoPolicy,
      autoEject: init.policy.autoEject,
      heatFlamer: init.policy.heatFlamer,
      jammedWeapons: [],
      critSlotsDestroyed: start.critSlotsDestroyed,
      blownOffLimbs: [],
      damageTakenFrom: {},
      club: null,
      declaredPickup: null,
      moveMode: null,
      hexesMovedThisTurn: 0,
      jumpedThisTurn: false,
      mpSpent: 0,
      heat: 0,
      heatPending: 0,
      heatExternalPending: 0,
      shutdown: "not",
      declaredWeaponAttacks: [],
      declaredPhysicalAttacks: [],
      passedAttacks: false,
      meleeCharge: null,
      destroyed: "not",
      removed: "not",
    };
  }

  const { width, height } = map;
  for (const [label, n] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`Board ${label} must be an integer >= 1`);
    }
  }
  const cells: HexCell[] = new Array<HexCell>(width * height).fill(hexCell("clear"));
  const terrainSeen = new Set<string>();
  const buildings: Record<string, BuildingState> = {};
  for (const t of map.terrain) {
    const key = hexKey(t);
    if (terrainSeen.has(key)) throw new Error(`Duplicate terrain definition for hex ${msgHex(t)}`);
    terrainSeen.add(key);
    cells[t.col - 1 + (t.row - 1) * width] = hexCell(t.type, t.level ?? 0);
    if (isBuildingTerrain(t.type)) buildings[key] = createBuildingState(t.type);
  }
  const clubs: Record<string, ClubGroundToken[]> = {};
  for (const c of map.clubs ?? []) {
    if (!catalogModel(c.model))
      throw new Error(`Unknown 'Mech model for club at ${msgHex(c)}: ${c.model}`);
    const key = hexKey(c);
    clubs[key] = [
      ...(clubs[key] ?? []),
      { kind: "limb", limb: c.limb, model: c.model, ownerId: null },
    ];
  }
  const wreckage: Record<string, WreckageEntry[]> = {};
  for (const w of map.wreckage ?? []) {
    const def = catalogModel(w.model);
    if (!def) throw new Error(`Unknown 'Mech model for wreckage at ${msgHex(w)}: ${w.model}`);
    if (def.tonnage < WRECKAGE_TONNAGE_MIN) {
      throw new Error(
        `Wreckage at ${msgHex(w)}: ${w.model} is ${def.tonnage} t, under ${WRECKAGE_TONNAGE_MIN} t`,
      );
    }
    const key = hexKey(w);
    wreckage[key] = [...(wreckage[key] ?? []), { model: w.model, unitId: null }];
  }

  return {
    // turn: 1,
    turn: 0,
    // phase: "initiative",
    phase: "end",
    initiativeWinnerTeam: null,
    units: unitStates,
    cells,
    width,
    height,
    critsDisabled: options.critsDisabled,
    actedThisPhase: [],
    actorQueue: null,
    buildings,
    wreckage,
    clubs,
    rubbleOrigin: {},
  };
}

/** Outcome of applying weapon damage to a building hex. */
export interface BuildingDamageResult {
  readonly col: number;
  readonly row: number;
  readonly damage: number;
  /** Structural factor before the hit. */
  readonly preCf: number;
  /** Structural factor remaining after the hit (0 = collapsed). */
  readonly cf: number;
  readonly collapsed: boolean;
  /** Unit ids occupying the hex at the moment of collapse. */
  readonly occupants: readonly string[];
}

/**
 * Apply damage (weapon fire, or a 'Mech entering or falling in the hex) to
 * the building occupying a hex, collapsing it to rubble when its structural
 * factor reaches zero. Pushes the `buildingDamaged` / `buildingCollapsed`
 * event into `sink` and returns the outcome, or `null` when the hex has no
 * building. Occupant collapse damage is applied by the caller (see
 * `resolveBuildingCollapse`).
 */
export function damageBuildingAt(
  state: BattleState,
  hex: HexCoord,
  damage: number,
  sink: GameEvent[],
): BuildingDamageResult | null {
  const key = hexKey(hex);
  const building = state.buildings[key];
  if (building === undefined) return null;
  const preCf = building.cf;
  const occupants = Object.values(state.units)
    .filter((u) => isUnitOnBoard(u) && sameHex(u.position, hex))
    .map((u) => u.id);
  state.buildings[key] = applyBuildingDamage(building, damage);
  const cf = state.buildings[key]!.cf;
  if (isCollapsed(state.buildings[key]!)) {
    const cell = cellAt(state, hex);
    const rubble = collapseToRubble(cell);
    if (rubble !== null) setCell(state, hex, rubble);
    // Remember what the rubble was: girder searches (TW p.146) only work
    // rubbled medium/heavy/hardened buildings.
    if (isBuildingTerrain(cell.terrain)) state.rubbleOrigin[key] = cell.terrain;
    delete state.buildings[key];
    sink.push({ kind: "buildingCollapsed", col: hex.col, row: hex.row });
    return { col: hex.col, row: hex.row, damage, preCf, cf: 0, collapsed: true, occupants };
  }
  sink.push({ kind: "buildingDamaged", col: hex.col, row: hex.row, damage, cf });
  return {
    col: hex.col,
    row: hex.row,
    damage,
    preCf,
    cf,
    collapsed: false,
    occupants: [],
  };
}

/**
 * Record severed limbs on `unit` (`blownOffLimbs`) and leave one ground token
 * per limb in the unit's current hex (TW p.146: a blown-off arm or leg stays
 * where it was lost). Each severing has exactly one report: a damage
 * application's `blownOffLimbs` (an arm lost with its side torso) or a crit
 * row (`critSeveredLimbs`), and both only sever a limb that still stands, so
 * a repeat is a bug.
 */
export function recordSeveredLimbs(
  state: BattleState,
  unit: UnitState,
  limbs: readonly LimbLocation[],
): void {
  for (const limb of limbs) {
    if (unit.blownOffLimbs.some((l) => l.limb === limb)) {
      throw new Error(`${unit.id}: ${limb} severed twice`);
    }
    unit.blownOffLimbs.push({ limb, salvageable: true });
    const key = hexKey(unit.position);
    state.clubs[key] = [
      ...(state.clubs[key] ?? []),
      { kind: "limb", limb, model: unit.model, ownerId: unit.id },
    ];
  }
}

/**
 * Record every limb the crit resolutions severed (`critSeveredLimbs`).
 * Leaves the matching ground tokens in the victim's hex.
 */
function recordCritSeveredLimbs(
  state: BattleState,
  unit: UnitState,
  crits: readonly CriticalResolution[],
): void {
  for (const crit of crits) {
    recordSeveredLimbs(state, unit, critSeveredLimbs(crit));
  }
}

/** Club tokens lying in `unit`'s hex (all kinds), in deposit order. */
export function clubTokensInHex(state: BattleState, unit: UnitState): readonly ClubGroundToken[] {
  return state.clubs[hexKey(unit.position)] ?? [];
}

function describeToken(token: ClubGroundToken): string {
  return token.kind === "limb"
    ? `limb ${token.limb} of ${token.ownerId ?? token.model}`
    : token.kind;
}

function sameToken(a: ClubGroundToken, b: ClubGroundToken): boolean {
  if (a.kind !== b.kind) return false;
  return (
    a.kind !== "limb" ||
    (b.kind === "limb" && a.limb === b.limb && a.model === b.model && a.ownerId === b.ownerId)
  );
}

type PickupChoice =
  | { ok: true; source: ClubKind; token?: ClubGroundToken }
  | { ok: false; reason: string };

/**
 * Resolve which club `unit` would pick up in its current hex (TW p.146).
 * Tokens (severed limbs, dropped trees/girders) come first; with exactly one
 * matching token it is taken, with several the caller must pick one by
 * `tokenIndex` (index into the hex's token list) or the pick is an error.
 * With no matching token the terrain fallback applies: a tree in a wooded
 * hex, else a girder in eligible rubble (or the explicitly requested one).
 */
function choosePickup(state: BattleState, unit: UnitState, decl: ClubPickupDecl): PickupChoice {
  const tokens = clubTokensInHex(state, unit);
  const matching = tokens
    .map((token, index) => ({ token, index }))
    .filter((t) => decl.source === undefined || t.token.kind === decl.source);
  if (decl.tokenIndex !== undefined) {
    const picked = tokens[decl.tokenIndex - 1];
    if (picked === undefined || (decl.source !== undefined && picked.kind !== decl.source)) {
      return { ok: false, reason: `no club token ${decl.tokenIndex} in this hex` };
    }
    return { ok: true, source: picked.kind, token: picked };
  }
  if (matching.length > 1) {
    const list = matching.map((t) => `${t.index + 1}: ${describeToken(t.token)}`).join(", ");
    return { ok: false, reason: `several clubs lie in this hex (${list}); choose one by number` };
  }
  const only = matching[0];
  if (only !== undefined) return { ok: true, source: only.token.kind, token: only.token };

  const cell = cellAt(state, unit.position);
  const hasTree = isWoodsTerrain(cell.terrain);
  const origin = state.rubbleOrigin[hexKey(unit.position)];
  const hasGirder =
    cell.terrain === "rubble" && origin !== undefined && GIRDER_SEARCH_TARGET[origin] !== undefined;
  if (decl.source === "limb") return { ok: false, reason: "no limb club available in this hex" };
  if ((decl.source === undefined || decl.source === "tree") && hasTree) {
    return { ok: true, source: "tree" };
  }
  if ((decl.source === undefined || decl.source === "girder") && hasGirder) {
    return { ok: true, source: "girder" };
  }
  return decl.source !== undefined
    ? { ok: false, reason: `no ${decl.source} club available in this hex` }
    : { ok: false, reason: "no club available in this hex (no limb, woods, or girder rubble)" };
}

/**
 * Resolve which club source `unit` would pick up in its current hex (TW
 * p.146); see `choosePickup`. Returns null when the hex offers nothing or
 * the choice is ambiguous.
 */
export function pickupSourceInHex(state: BattleState, unit: UnitState): ClubKind | null {
  const choice = choosePickup(state, unit, {});
  return choice.ok ? choice.source : null;
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

/** MP cost of a stand-up attempt (TW p.50): shares the move budget. */
export const STAND_MP_COST = 2;
/** MP cost of a voluntary drop to prone (TW p.49): shares the walk budget. */
export const DROP_MP_COST = 1;

/** Max hexsides per facing-change step. */
const TURN_FACINGS_MAX = 5;
/** Minimum hexes entered for a jump declaration. */
const JUMP_MIN_HEXES = 1;
/** Heat from a stand-up attempt. A voluntary drop to
 *  prone costs no heat. */
const POSTURE_MOVE_HEAT = 1;
/** Walk budget below which a prone drop is refused. */
const DROP_BUDGET_MIN = 1;
/** End-of-heat-phase heat dealing 1 pilot hit with destroyed life support. */
const LIFE_SUPPORT_HEAT_1HIT = 15;
/** End-of-heat-phase heat dealing 2 pilot hits with destroyed life support. */
const LIFE_SUPPORT_HEAT_2HITS = 26;
/** Pilot hits per damaging head grouping. */
const HEAD_HIT_PILOT_HITS = 1;
/** Pilot hits per ammo explosion. */
const AMMO_BLAST_PILOT_HITS = 2;
/** True when a crit row detonated a blast: an ammo explosion, or a
 *  Gauss/HAG weapon-crit carrying `explosion` (TW p.135-136, handled like
 *  an ammo explosion). Pilot hits, damage replay, and cascade accounting
 *  all key off this predicate. */
function isCritBlastRow(row: CriticalEffect): boolean {
  if (row.kind === "ammoExplosion") return true;
  return row.kind === "weaponDestroyed" && row.explosion !== undefined;
}
/** The damage application of a blast row (ammo explosion, or Gauss/HAG
 *  weapon-crit explosion), or undefined for any other row. */
function blastApplication(row: CriticalEffect): DamageApplication | undefined {
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
function resolveCenterTorsoBlast(
  state: BattleState,
  unit: UnitState,
  applications: readonly (DamageApplication | undefined)[],
  rng: Rng,
  sink: GameEvent[],
): void {
  // A hull has nobody to eject: the destruction sweep records the loss.
  if (isUnitRemoved(unit)) return;
  if (!applications.some((a) => a?.newlyDestroyed.includes("centerTorso"))) return;
  if (!unit.autoEject) {
    markUnitDestroyed(state, unit, "centerTorsoDestroyed", rng, sink, true);
    return;
  }
  unit.destroyed = "centerTorsoDestroyed";
  resolveEjection(state, unit, rng, sink, "auto");
}

/** True when the pilot ejected because the head was destroyed: the blow that
 *  destroyed it is already folded into the raised pilot hits (TO p.165). */
function headLossEjected(unit: UnitState): boolean {
  return unit.removed === "pilotEjected" && unit.damage.internalStructure.head <= 0;
}

/** Pilot hits per failed seatbelt or fall. */
const FALL_PILOT_HITS = 1;
/** Seatbelt modifier when a leg is destroyed. */
const SEATBELT_LEG_DESTROYED = 5;
/** Seatbelt modifier when the gyro is destroyed. */
const SEATBELT_GYRO_DESTROYED = 6;
/** PSR modifier for the 20+ damage trigger in the phase sweep. */
const PHASE_DAMAGE_PSR_MOD = 1;
/** PSR modifier when a reactor shuts down (TW p.60). Rolled immediately;
 *  only *other* PSRs required while the 'Mech is down fail automatically. */
const SHUTDOWN_PSR_MOD = 3;
/** Seatbelt PSR carries the failed fall's combined modifier as its trigger;
 *  it has no separate preexisting component. */
const SEATBELT_PRE_MOD = 0;
/** Divisor for building-crash damage: ceil(remaining CF / 10). */
const BUILDING_CRASH_DIVISOR = 10;
/** A 'Mech entering or falling in a building hex deals tonnage / 10 (round
 *  up) to its CF (TW p.167). */
const BUILDING_UNIT_DAMAGE_DIVISOR = 10;
/** Per-attack CF toll divisor for units inside buildings (TW p. 171):
 *  each hitting Damage Value grouping costs ceil(CF at phase start / 10). */
const BUILDING_ABSORB_DIVISOR = 10;

/**
 * Collapse damage total for a building hex (TW p. 176): base damage (CF at
 * the start of the phase / 10) plus base × levels above the unit, rounded
 * up at the end. Pure: exported for tests.
 */
export function collapseDamageTotal(preCf: number, levelsAbove: number): number {
  return Math.ceil((preCf / BUILDING_ABSORB_DIVISOR) * (1 + levelsAbove));
}

/**
 * Emit one `pilotingCheck` event carrying the PSR components. The UI
 * derives `modifier = triggerModifier + preexistingModifier` and
 * `target = basePiloting + modifier`; the roll outcome uses the same
 * values via `rollPilotingCheck`, so the log math always matches the
 * game logic.
 */
function pushPilotingCheck(
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
export interface ExecuteMoveOptions {
  /** Landing facing of a jump (TW p.53), or the free facing of a stand-up
   *  that enters no hex (TW p.50); any other move refuses it. When omitted,
   *  the unit keeps the facing its steps leave it in. */
  readonly finalFacing?: Facing;
  /** Per-call random source. */
  readonly rng: Rng;
}

/** Facing from `from` to the adjacent hex `to`, or undefined when not adjacent. */
/** LOS endpoint postures for an attack from `from` against `to`. A unit that
 *  declared a DFA is in the air until the physical phase: for LOS it sits two
 *  levels above the higher of its own hex and its target's hex (TW p.149). */
export function losEnds(state: BattleState, from: UnitState, to: UnitState): ProneEnds {
  const level = (u: UnitState): number | undefined => {
    const charge = u.meleeCharge;
    if (charge?.kind !== "dfa") return undefined;
    return Math.max(groundLevel(state, u.position), groundLevel(state, charge.hex)) + 2;
  };
  const fromLevel = level(from);
  const toLevel = level(to);
  return {
    from: from.prone,
    to: to.prone,
    ...(fromLevel !== undefined ? { fromLevel } : {}),
    ...(toLevel !== undefined ? { toLevel } : {}),
  };
}

export function facingToward(from: HexCoord, to: HexCoord): Facing | undefined {
  return FACINGS.find((f) => sameHex(neighbor(from, f), to));
}

/**
 * Why `unitId` cannot charge (walk / run) or DFA (jump) `targetId` from the
 * hex `stop` just before it, or null when the declaration is legal (TW
 * pp.148-150). The attacker is checked as if it already stood in `stop`
 * facing the target; `jumpMP` is the Jumping MP available for a DFA's
 * clearance. Shared by `executeMove` and the movement-candidate display.
 */
export function meleeDeclarationProblem(
  state: BattleState,
  unitId: string,
  stop: HexCoord,
  targetId: string,
  kind: "charge" | "dfa",
  jumpMP: number,
): string | null {
  const unit = state.units[unitId];
  const target = state.units[targetId];
  if (unit === undefined || target === undefined) return "unknown unit";
  const toward = facingToward(stop, target.position);
  if (toward === undefined) return "Charge / DFA target must be adjacent";
  if (kind === "dfa") {
    // The jump must clear the target hex: its level over the start hex plus
    // two for a standing target (TW p.149).
    const need =
      groundLevel(state, target.position) -
      groundLevel(state, unit.position) +
      (target.prone ? 0 : 2);
    if (jumpMP < need) return `A DFA at ${target.id} needs ${need} Jumping MP to clear it`;
  }
  // The attacker stays in `stop` for the rest of the turn.
  const squatter = occupantAt(state, stop, unitId);
  if (squatter !== undefined) return `${msgHex(stop)} is occupied by ${squatter.id}`;
  const others = Object.values(state.units).filter((u) => u.id !== unitId && !isUnitRemoved(u));
  // Standing in a hex another unit reserved is fine; moving into one is not.
  const reserved = sameHex(unit.position, stop)
    ? undefined
    : others.find((u) => u.meleeCharge !== null && sameHex(u.meleeCharge.hex, stop));
  if (reserved !== undefined) return `${msgHex(stop)} is reserved for ${reserved.id}'s charge`;
  if (others.some((u) => u.meleeCharge?.targetId === target.id)) {
    return `${target.id} is already the target of a charge or DFA this turn`;
  }
  if (others.some((u) => u.meleeCharge?.targetId === unitId)) {
    return `${unitId} is the target of a charge or DFA and cannot make one`;
  }
  const view: BattleState = {
    ...state,
    units: {
      ...state.units,
      [unitId]: { ...unit, position: stop, facing: toward, jumpedThisTurn: kind === "dfa" },
    },
  };
  const check = validatePhysicalAttack(view, unitId, { type: kind, targetId });
  return check.ok ? null : (check.reason ?? "illegal charge");
}

/** Posture change that can open an activation (TW pp.49-50). */
export type PostureChange = "standUp" | "drop";

/** MP a posture change already took from the activation's one pool. */
interface PosturePool {
  /** MP the stand or drop charged. */
  readonly mp: number;
  /** A stand made through Minimum Movement (TW p.49) is the turn's only MP
   *  expenditure: nothing is left for the movement after it. */
  readonly exhausted: boolean;
  /** The stand-up already charged the declared mode's heat (TW p.159). */
  readonly modeHeatPaid: boolean;
  /** TW p.50: once standing, the 'Mech may face any direction at no cost,
   *  so facing changes before its first hex entry are free. */
  readonly freeFacing: boolean;
}

/** MP a stand-up or drop charges for `unit` as it stands now (TW pp.49-50). */
export function postureCost(unit: UnitState, posture: PostureChange): number {
  return posture === "standUp" ? standUpCost(unit) : DROP_MP_COST;
}

function posturePool(cost: number, posture: PostureChange): PosturePool {
  return posture === "standUp"
    ? { mp: cost, exhausted: cost < STAND_MP_COST, modeHeatPaid: true, freeFacing: true }
    : { mp: cost, exhausted: false, modeHeatPaid: false, freeFacing: false };
}

function remainingAfterPosture(budget: number, pool: PosturePool): number {
  return pool.exhausted ? 0 : Math.max(0, budget - pool.mp);
}

/**
 * MP left for the movement that follows a stand-up or drop, out of the
 * locomotion `budget` (the walking or running MP the unit has now). Posture
 * and movement share one pool (TW pp.49-50); a stand made through Minimum
 * Movement leaves nothing (TW p.49). Call before the posture change: the
 * stand-up cost depends on the unit's current walking MP.
 */
export function postureMoveBudget(unit: UnitState, posture: PostureChange, budget: number): number {
  return remainingAfterPosture(budget, posturePool(postureCost(unit, posture), posture));
}

/**
 * Moves the current actor: declares `mode` and walks `steps` in one call.
 * The unit must head the movement queue, and the move ends its activation.
 * A stand-up or drop followed by movement goes through `executePostureMove`.
 */
export function executeMove(
  state: BattleState,
  unitId: string,
  mode: MoveMode,
  steps: readonly MoveStep[],
  sink: GameEvent[],
  options: ExecuteMoveOptions,
): void {
  moveUnit(state, unitId, mode, steps, sink, options, null);
}

/**
 * A stand-up or drop and the movement after it, as one activation with one
 * MP pool (TW pp.49-50): the posture cost counts against the locomotion
 * budget, and the activation is marked once. Movement follows only a
 * successful posture change; after a failed stand the 'Mech stays prone and
 * `steps` are not taken. A stand takes `locomotion` as its declared mode
 * (walk, run or stand still; never jump, TW p.49). A drop takes walk (turns
 * in place while prone) or stand still. Returns whether the posture change
 * succeeded.
 *
 * Not atomic: when the movement is illegal it throws after the posture change
 * has resolved. Callers wanting all-or-nothing hold a snapshot (see
 * `commitAtomic` in the web session).
 */
export function executePostureMove(
  state: BattleState,
  unitId: string,
  posture: PostureChange,
  locomotion: MoveMode,
  steps: readonly MoveStep[],
  sink: GameEvent[],
  options: ExecuteMoveOptions,
): boolean {
  if (locomotion === "jump") {
    throw new Error(
      `${unitId} cannot jump in a turn it ${posture === "standUp" ? "stands up" : "drops prone"}`,
    );
  }
  if (posture === "drop" && locomotion === "run") {
    throw new Error(`${unitId} drops prone: walk (turn in place) or stand still only`);
  }
  const rng = options.rng;
  // The posture change is a window of its own with nothing in scope: a
  // failed stand's fall rolls no sweep and earns no one credit.
  state.currentDealt = { before: { damage: {}, crit: {} }, total: {}, byAttacker: {} };
  let cost: number;
  if (posture === "standUp") {
    cost = attemptStandUp(state, unitId, sink, rng, locomotion);
    if (requireUnit(state, unitId).prone) return false;
  } else {
    dropProne(state, unitId, sink);
    cost = DROP_MP_COST;
  }
  if (steps.length > 0 || options.finalFacing !== undefined) {
    moveUnit(state, unitId, locomotion, steps, sink, options, posturePool(cost, posture));
  }
  return true;
}

/** `executeMove` body. With `posture`, the move continues the activation a
 *  stand-up or drop opened: that call already checked the actor and marked
 *  the activation, and its MP comes out of the same pool. */
function moveUnit(
  state: BattleState,
  unitId: string,
  mode: MoveMode,
  steps: readonly MoveStep[],
  sink: GameEvent[],
  options: ExecuteMoveOptions,
  posture: PosturePool | null,
): void {
  requirePhase(state, "movement");
  if (posture === null) requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot move`);
  if (isPilotUnconscious(unit)) throw new Error(`${unitId} is unconscious and cannot move`);
  if (mode !== "standStill" && isUnitImmobile(unit.damage)) {
    throw new Error(`${unitId} has no intact legs and arms and can only stand still`);
  }
  // TW p.122: a one-leg-destroyed 'Mech cannot run (running MP is 0).
  // TW p.49: minimum movement (one forward hex, nothing else) is still legal.
  // Minimum Movement must be the turn's only MP expenditure, so never after a
  // stand or drop.
  const minMoveShape =
    posture === null &&
    mode === "run" &&
    !unit.prone &&
    steps.length === 1 &&
    steps[0]!.kind === "enter" &&
    mv.isForwardStep(unit.position, steps[0]!.to, unit.facing);
  if (mode === "run" && destroyedLegs(unit.damage) >= 1 && !minMoveShape) {
    throw new Error(`${unitId} has a destroyed leg and cannot run`);
  }
  // Prone units may only stand still or walk turn-only steps. Combined check:
  // reject run/jump outright; reject walk with any hex-enter step.
  if (unit.prone && mode !== "standStill" && mode !== "walk") {
    throw new Error(`${unitId} is prone: stand up, turn, or pronestill`);
  }
  // TW p.49: standing up (or dropping) uses the turn's movement; no jump after.
  if (mode === "jump" && posture !== null) {
    throw new Error(`${unitId} stood up or dropped prone this turn and cannot jump`);
  }
  if (unit.prone && mode === "walk" && steps.some((s) => s.kind === "enter")) {
    throw new Error(`${unitId} is prone: turn or pronestill only (no hex enters)`);
  }
  const startHex: HexCoord = unit.position;
  unit.moveMode = mode;
  unit.hexesMovedThisTurn = 0;
  unit.mpSpent = 0;
  sink.push({ kind: "moveDeclared", unitId, mode });
  const rng = options.rng;
  const prechargedMP = posture?.mp ?? 0;

  const def = mechDefFor(unit);
  const movement = effectiveMovement(
    def,
    unit.damage,
    unit.critSlotsDestroyed,
    isTsmActive(def, unit.heat),
    waterDepth(cellAt(state, unit.position).terrain),
  );
  const budget = effectiveMoveBudget(unit.moveMode, movement, unit.heat);
  const jumping = unit.moveMode === "jump";
  const proneTurn = unit.prone && unit.moveMode === "walk";
  // TW p.49 minimum movement: a unit with >= 1 MP always affords the single
  // hex straight ahead; the charge is capped at what it has (at least 1).
  const minMove =
    minMoveShape && effectiveMoveBudget("walk", movement, unit.heat) >= mv.MIN_MOVEMENT_MP;
  const minMoveCap = Math.max(budget, mv.MIN_MOVEMENT_MP);

  let cursor: HexCoord = unit.position;
  let facing: Facing = unit.facing;
  let spent = 0;
  const directions: ("forward" | "backward")[] = [];
  // Charge / DFA (TW pp.148-150): a path whose last step enters an enemy hex
  // stops in front of it; the attack resolves in the physical phase.
  let meleeTarget: UnitState | null = null;
  let meleeStop: HexCoord = unit.position;
  // Stacking and charges are judged in the hex the unit ends in: the last
  // one it enters, even when turn steps follow (TW p.57).
  const firstEnterIdx = steps.findIndex((s) => s.kind === "enter");
  const lastEnterIdx = steps.reduce((m, s, k) => (s.kind === "enter" ? k : m), -1);
  // TW p.50: after a stand-up, the turns before the first hex entry are free.
  const freeTurn = (i: number): boolean =>
    posture?.freeFacing === true && (firstEnterIdx < 0 || i < firstEnterIdx);
  const standPick = posture?.freeFacing === true && firstEnterIdx < 0;
  if (options.finalFacing !== undefined && !jumping && !standPick) {
    throw new Error("finalFacing applies only to a jump landing or a stand-up facing pick");
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const isFinalStep = i === lastEnterIdx;

    if (step.kind === "turn") {
      if (jumping) throw new Error("Jumping 'Mechs choose facing freely on landing; no turn steps");
      if (unit.moveMode === "standStill") throw new Error("Standing still forbids facing changes");
      if (
        !Number.isInteger(step.facings) ||
        step.facings === 0 ||
        Math.abs(step.facings) > TURN_FACINGS_MAX
      ) {
        throw new Error("Facing change must be 1..5 hexsides in either direction");
      }
      if (!freeTurn(i)) spent += mv.facingChangeCost(Math.abs(step.facings));
      facing = rotateFacing(facing, step.facings);
      continue;
    }

    const to = step.to;
    if (to.col < 1 || to.col > state.width || to.row < 1 || to.row > state.height) {
      throw new Error(`${msgHex(to)} is off the board`);
    }
    if (jumping) {
      if (!isAdjacent(cursor, to)) {
        throw new Error("Jump steps must enter an adjacent hex");
      }
      if (budget > 0 && cellAt(state, to).level > budget + groundLevel(state, unit.position)) {
        throw new Error(`Jump path crosses ${msgHex(to)}, higher than Jumping MP + starting level`);
      }
      spent += JUMP_MP_PER_HEX;
      directions.push("forward");
    } else {
      if (unit.moveMode === "standStill") throw new Error("Standing still forbids entering hexes");
      if (proneTurn) {
        throw new Error(`${unitId} is prone: turn or pronestill only (no hex enters)`);
      }
      const forward = mv.isForwardStep(cursor, to, facing);
      const backward = !forward && mv.isBackwardStep(cursor, to, facing);
      if (!forward && !backward) {
        throw new Error("Ground moves must go straight ahead or straight back relative to facing");
      }
      if (backward && unit.moveMode === "run") {
        throw new Error("Running 'Mechs cannot move backward");
      }
      // TW p.53: running 'Mechs cannot enter depth 1+ water; Minimum Movement
      // (TW p.57) is the one exception.
      if (unit.moveMode === "run" && !minMove && waterDepth(cellAt(state, to).terrain) > 0) {
        throw new Error(`Running 'Mechs cannot enter water (${msgHex(to)})`);
      }
      const fromLevel = groundLevel(state, cursor);
      const toLevel = groundLevel(state, to);
      const delta = toLevel - fromLevel;
      const illegalChange = forward
        ? Math.abs(delta) > FORWARD_LEVEL_CHANGE_MAX
        : delta !== BACKWARD_LEVEL_CHANGE_MAX;
      if (illegalChange) {
        const slope = delta > 0 ? `${delta} levels higher` : `${-delta} levels lower`;
        throw new Error(
          forward
            ? `Ground moves can change at most 2 levels per hex (${msgHex(to)} is ${slope})`
            : `Walking backward cannot change level (${msgHex(to)} is ${slope})`,
        );
      }
      spent += hexEntryCost(state, to, hasWreckage(state, to)) + costToClimb(fromLevel, toLevel);
      directions.push(forward ? "forward" : "backward");
    }

    // Stacking (TW p.57; TO:AR p.184): friendly units and hulls of either
    // team may be passed through, never stopped on. Ending against an enemy
    // or a hull declares a charge / DFA.
    const occupant = occupantAt(state, to, unitId);
    if (occupant !== undefined) {
      if (isFinalStep && isTargetableBy(unit, occupant)) {
        if (i !== steps.length - 1) throw new Error("A charge or DFA ends the move");
        if (directions[directions.length - 1] !== "forward") {
          throw new Error("A charge must be made straight ahead");
        }
        meleeTarget = occupant;
        meleeStop = cursor;
      } else if (isFinalStep) {
        throw new Error(`Cannot end movement in ${msgHex(to)}: occupied by ${occupant.id}`);
      } else if (!jumping && occupant.team !== unit.team && !isHull(occupant)) {
        throw new Error(`Cannot move through enemy ${occupant.id} at ${msgHex(to)}`);
      }
    } else if (isFinalStep) {
      const holder = Object.values(state.units).find(
        (u) =>
          u.id !== unitId &&
          !isUnitRemoved(u) &&
          u.meleeCharge !== null &&
          sameHex(u.meleeCharge.hex, to),
      );
      if (holder !== undefined) {
        throw new Error(`Cannot end movement in ${msgHex(to)}: reserved for ${holder.id}'s charge`);
      }
    }

    cursor = to;
  }

  // TW p.125 Gyro: a prone 'Mech with a destroyed gyro may change facing one
  // hexside per turn.
  if (
    proneTurn &&
    spent > 1 &&
    countDestroyedGyro(def, unit.damage, unit.critSlotsDestroyed) >= GYRO_DESTROYED_HITS
  ) {
    throw new Error(`${unitId} has a destroyed gyro: one hexside facing change per turn`);
  }
  if (minMove) spent = Math.min(spent, minMoveCap);
  if (posture !== null) {
    // TW pp.49-50: the stand or drop and the move share one pool.
    const left = remainingAfterPosture(budget, posture);
    if (spent > left) {
      throw new Error(
        `Move costs ${spent} MP but only ${left} of the ${unit.moveMode} budget ${budget} is left after the posture change`,
      );
    }
  } else if (spent > budget && !minMove) {
    throw new Error(`Move costs ${spent} MP but ${unit.moveMode} budget is ${budget}`);
  }
  if (jumping && directions.length < JUMP_MIN_HEXES) {
    throw new Error("Jump needs at least 1 hex move");
  }
  if (
    jumping &&
    directions.length !== Math.max(JUMP_MIN_HEXES, hexDistance(unit.position, cursor))
  ) {
    throw new Error("A jump follows a shortest path to its landing hex");
  }
  if (
    steps.length > 0 &&
    !jumping &&
    unit.moveMode !== "standStill" &&
    isUnitImmobile(unit.damage)
  ) {
    throw new Error(`${unitId} has no intact legs and arms and cannot move`);
  }

  // Charge / DFA declaration checks (TW pp.148-150).
  let meleeKind: "charge" | "dfa" | null = null;
  let meleeFacing: Facing = facing;
  if (meleeTarget !== null) {
    meleeKind = jumping ? "dfa" : "charge";
    const problem = meleeDeclarationProblem(
      state,
      unitId,
      meleeStop,
      meleeTarget.id,
      meleeKind,
      budget,
    );
    if (problem !== null) throw new Error(problem);
    meleeFacing = facingToward(meleeStop, meleeTarget.position) ?? facing;
    cursor = meleeStop;
  }
  // TW p.168: a 'Mech cannot use Jumping MP to enter a building hex, only its
  // roof, and roofs are not modeled. Jumping out of or over one is legal.
  if (jumping && isBuildingTerrain(cellAt(state, cursor).terrain)) {
    throw new Error(`${unitId} cannot use Jumping MP to enter a building hex (${msgHex(cursor)})`);
  }

  // Preexisting damage applies to every movement-entry PSR (TW p.60). The
  // modifier is recomputed per roll: damage taken earlier in the move counts.
  const pre = preexistingDamageModifier(def, unit.damage, unit.critSlotsDestroyed);
  const currentPre = (): number =>
    preexistingDamageModifier(def, unit.damage, unit.critSlotsDestroyed).modifier;
  // Damage and criticals taken during the move trigger their end-of-phase
  // PSRs at the end of the move (TW pp.59-60, 126-128). The move is one
  // damage window with only the mover in scope.
  state.currentDealt = {
    before: {
      damage: { [unitId]: cloneDamage(unit.damage) },
      crit: { [unitId]: cloneCritTable(unit.critSlotsDestroyed) },
    },
    total: {},
    byAttacker: {},
  };
  const commitAt = (
    hex: HexCoord,
    face: Facing,
    mode: MoveMode,
    mp: number,
    dirs: ("forward" | "backward")[],
    declareCharge = false,
  ): void => {
    unit.position = hex;
    unit.facing = face;
    unit.jumpedThisTurn = jumping && steps.length > 0;
    // Target movement counts only hexes since the last reversal (TW p.107).
    let since = dirs.length;
    while (since > 0 && dirs[since - 1] === dirs[dirs.length - 1]) since -= 1;
    unit.hexesMovedThisTurn = dirs.length - since;
    unit.mpSpent = mp + prechargedMP;
    // A path that ends against an enemy declares the charge / DFA: the unit
    // takes no attack-phase actions and its attack resolves in the physical
    // sub-pass (TW pp.148-149). A later fall (strain PSR) leaves it declared;
    // the prone attacker then simply misses.
    let pendingCharge: { attack: "charge" | "dfa"; targetId: string; targetHex: HexCoord } | null =
      null;
    if (declareCharge && meleeKind !== null && meleeTarget !== null) {
      const target: UnitState = meleeTarget;
      unit.meleeCharge = {
        kind: meleeKind,
        targetId: target.id,
        hex: target.position,
        from: startHex,
        missed: false,
      };
      unit.declaredPhysicalAttacks = [{ type: meleeKind, targetId: target.id }];
      unit.passedAttacks = true;
      pendingCharge = {
        attack: meleeKind,
        targetId: target.id,
        targetHex: target.position,
      };
    }
    sink.push({
      kind: "moved",
      unitId,
      mode,
      prevMode: mode,
      position: hex,
      facing: face,
      mpSpent: mp + prechargedMP,
      mpBudget: budget,
      ...(pendingCharge !== null ? { pendingCharge } : {}),
    });
    const moveHeat = posture?.modeHeatPaid === true ? 0 : movementHeat(mode, mp);
    if (moveHeat > 0) {
      // Deferred own heat: accumulate into heatPending; the scale only
      // updates at the heat phase (TW p.159).
      unit.heatPending += moveHeat;
      sink.push({
        kind: "heatMove",
        unitId,
        heat: moveHeat,
        base: unit.heat,
        totalGenerated: unit.heatPending,
      });
    }
  };

  // Progressive commit: the validated path replays step by step so a failed
  // terrain PSR stops the 'Mech in the hex it fell in (TW: falls resolve as
  // they happen in the movement phase).
  let cur: HexCoord = unit.position;
  let curFacing: Facing = unit.facing;
  let curSpent = 0;
  const curDirs: ("forward" | "backward")[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const isFinal = i === lastEnterIdx;
    if (step.kind === "turn") {
      curFacing = rotateFacing(curFacing, step.facings);
      if (!freeTurn(i)) curSpent += mv.facingChangeCost(Math.abs(step.facings));
      continue;
    }
    const from = cur;
    const to = step.to;
    if (jumping) {
      curSpent += JUMP_MP_PER_HEX;
      curDirs.push("forward");
    } else {
      const forward = mv.isForwardStep(from, to, curFacing);
      curSpent +=
        hexEntryCost(state, to, hasWreckage(state, to)) +
        costToClimb(groundLevel(state, from), groundLevel(state, to));
      curDirs.push(forward ? "forward" : "backward");
    }
    if (minMove) curSpent = Math.min(curSpent, minMoveCap);
    // The target hex of a charge / DFA is never entered: no terrain PSR, the
    // unit stays in the hex before it (MP for the step is still paid).
    if (isFinal && meleeKind !== null) break;
    cur = to;
    // Terrain-entry PSRs (TW p.60): ground checks every entered hex, jump
    // only its landing. A fall, crash-kill, or shutdown ends the move here,
    // committed at the hex the fall rule leaves the 'Mech in (the lower
    // hex on a fall across levels).
    if (!jumping || isFinal) {
      // Sync unit.facing before the PSR so a fall rotates from the
      // correct facing (walk: turned facing; jump: chosen landing facing).
      if (jumping) {
        unit.facing = options.finalFacing ?? facing;
      } else {
        unit.facing = curFacing;
      }
      const fellAt = movementTerrainPsr(
        state,
        unit,
        rng,
        from,
        to,
        !jumping,
        currentPre(),
        sink,
        curDirs.length,
        curDirs[curDirs.length - 1] !== "backward",
      );
      // A move cut short still uses up the unit's activation (TW p.59).
      if (fellAt !== null) {
        commitAt({ ...fellAt }, unit.facing, mode, curSpent, curDirs);
        if (posture === null) state.actedThisPhase.push(unitId);
        return;
      }
      if (unit.prone || unit.destroyed !== "not") {
        commitAt({ ...cur }, unit.facing, mode, curSpent, curDirs);
        if (posture === null) state.actedThisPhase.push(unitId);
        return;
      }
    }
  }

  // A charge counts only the hexes moved before the target's (TW p.148).
  commitAt(
    cursor,
    meleeKind !== null ? meleeFacing : (options.finalFacing ?? facing),
    mode,
    spent,
    meleeKind === "charge" ? directions.slice(0, -1) : directions,
    true,
  );
  if (posture === null) state.actedThisPhase.push(unitId);

  // Running with a damaged hip/gyro, or jumping with damaged gyro, leg,
  // foot, or hip actuators (or a destroyed leg), forces a PSR at the end of
  // the move with preexisting-damage modifiers (TW p.60). The trigger adds
  // nothing on top of `pre`: both table rows read "per Preexisting Damage".
  // Stationary declarations (no hex entered) skip the check. A failed
  // jump-phase PSR falls 0 levels per errata even across levels, and the
  // landing hex is already committed, so no levelsFallen is passed.
  if (!unit.prone && directions.length > 0) {
    const gyroHits = countDestroyedGyro(def, unit.damage, unit.critSlotsDestroyed);
    const hipHits = countDestroyedHip(def, unit.damage, unit.critSlotsDestroyed);
    const strained =
      mode === "run" ? hipHits > 0 || gyroHits > 0 : mode === "jump" ? pre.modifier > 0 : false;
    if (strained) {
      const reason: PilotingCheckReason = mode === "run" ? "runDamaged" : "jumpDamaged";
      const r = pushPilotingCheck(sink, unit, reason, 0, pre.modifier, rng, cursor);
      if (!r.success) {
        const terrain = cellAt(state, cursor).terrain;
        applyFall(
          state,
          unit,
          rng,
          {
            cause: { kind: "failedPsr", reason },
            hex: cursor,
            seatbeltModifier: pre.modifier,
            halved: terrain === "water2" || terrain === "water3",
          },
          sink,
        );
      }
    }
  }
  resolvePhasePiloting(state, rng, sink);
}

/**
 * Arm a prone volley props itself up on, inferred from its declared weapons:
 * a volley with left-arm weapons props on the right arm and vice versa.
 * Null when standing, or when a prone volley fires no arm-mounted weapons.
 */
export function inferPronePropArm(
  def: ResolvedMechDef,
  decls: readonly WeaponAttackDecl[],
  prone: boolean,
): ArmLocation | null {
  if (!prone) return null;
  let hasLeft = false;
  let hasRight = false;
  for (const decl of decls) {
    const loc = def.weapons[decl.weaponIndex]?.location;
    if (loc === "leftArm") hasLeft = true;
    if (loc === "rightArm") hasRight = true;
  }
  if (hasLeft && hasRight) return null;
  if (hasLeft) return "rightArm";
  if (hasRight) return "leftArm";
  return null;
}

export interface DeclareAttacksOptions {
  /** Torso twist (TW pp.105-106): shifts the attacker's effective facing by one
   *  hexside before classifying the firing arc. Defaults to untwisted. */
  readonly twist?: Twist;
  /** Drop the held club first: hands are free for the rest of this
   *  declaration, so arm-mounted weapons, punch, and strike validate
   *  normally. A dropped limb returns to the hex; trees/girders vanish.
   *  Requires holding a club. */
  readonly dropClub?: boolean;
  /** Primary target for a multi-target volley (TW p.108). Must be one of the
   *  weapon targets, and in the forward arc whenever any weapon target is.
   *  Defaults to the first declared target (or the first forward-arc target
   *  when the first is not). Ignored when no weapons are declared. */
  readonly primaryTargetId?: string;
}

/** Resolved per-target fields of a weapon volley (TW p.108: a unit may split
 *  its weapons among any number of targets). Range fields come from the
 *  target's first declared weapon. */
export interface ValidatedTargetVolley {
  readonly targetId: string;
  readonly count: number;
  readonly attackDirection: Arc;
  readonly distance: number;
  readonly rangeBracket: RangeBracket;
  readonly rangeMod: number;
  readonly secondaryMod: 0 | SecondaryTargetMod;
}

/** Per-weapon resolved arc plus per-target direction/range fields.
 *  Returned by `validateAttacks` so `declareAttacks` (and any UIs that
 *  want to display the resolved arc before commit) can skip recomputing
 *  LOS, arc classification, and the to-hit range breakdown. */
export interface ValidatedAttackVolley {
  /** Primary weapon target; null when only physical attacks are declared. */
  readonly primaryTargetId: string | null;
  /** One entry per distinct weapon target, in declaration order. */
  readonly targets: readonly ValidatedTargetVolley[];
  readonly arcs: Readonly<Record<number, Arc>>;
  readonly normalized: PhysicalAttackDecl[];
}

/** Normalize physical attack limbs: a limbless punch defaults to the right
 *  arm, a limbless kick to the right leg (TW lets the attacker pick; the
 *  default keeps single-command declarations deterministic). A limbless
 *  strike defaults to its mounting arm (right when both mount it).
 *  A club carries no limb. */
function normalizePhysicalDecls(
  def: ResolvedMechDef,
  decls: readonly PhysicalAttackDecl[],
): PhysicalAttackDecl[] {
  return decls.map((d) => {
    if (d.type === "punch" && d.limb === undefined) return { ...d, limb: "rightArm" as const };
    if (d.type === "kick" && d.limb === undefined) return { ...d, limb: "rightLeg" as const };
    if (d.type === "strike" && d.limb === undefined && d.weapon !== undefined) {
      const arm = resolveStrikeArm(def, d.weapon, undefined);
      if (arm !== null) return { ...d, limb: arm };
    }
    return d;
  });
}

/**
 * Enforce the one-type-per-turn rule (TW p. 144) with the two-arm punch
 * exception (one punch per arm, separate rolls). Strikes are physical
 * weapon attacks: at most one per turn even with two mounted (TW p.144).
 * Throws on violation.
 */
function checkPhysicalSetShape(unitId: string, normalized: readonly PhysicalAttackDecl[]): void {
  if (normalized.some((d) => isMeleeCharge(d.type))) {
    throw new Error(`${unitId}: charge and DFA are declared by movement, not in the attack phase`);
  }
  const types = new Set(normalized.map((d) => d.type));
  if (types.size > 1)
    throw new Error(`${unitId} may make only one type of physical attack per turn`);
  const punches = normalized.filter((d) => d.type === "punch");
  if (punches.length > 2) throw new Error(`${unitId} may punch with at most two arms`);
  const punchLimbs = punches.map((d) => d.limb);
  if (new Set(punchLimbs).size !== punchLimbs.length)
    throw new Error(`${unitId} may punch with each arm only once per turn`);
  const strikes = normalized.filter((d) => d.type === "strike");
  if (strikes.length > 1)
    throw new Error(`${unitId} may make only one physical weapon attack per turn`);
  // TW p. 144: one physical attack per turn; two punches (one per arm) are
  // the only exception.
  if (punches.length === 0 && normalized.length > 1)
    throw new Error(`${unitId} may make only one ${normalized[0]!.type} per turn`);
}

/** Validation core shared by `validateAttacks` and `declareAttacks`.
 *  Runs every gate `declareAttacks` enforces: unit status (removed /
 *  shutdown / unconscious), sensors, prone arm-prop, and per-decl checks
 *  (weapon bounds, dup, jammed / destroyed, location, rapid-fire,
 *  multiple-target primary / secondary modifier, target validity, arc, LOS,
 *  range, to-hit, ammo), plus the
 *  physical set (one-type / two-punch shape, per-decl legality with the
 *  twist-aware arcs of `validatePhysicalAttack`, and the weapon/physical
 *  interaction backstop below). On success returns the primary target, each
 *  weapon's firing arc, and per-target attack direction, distance, range
 *  bracket, and secondary-target modifier (empty when no weapon attacks
 *  were passed). Does NOT mutate state, consume RNG, or
 *  emit events. Phase and actor-queue are checked by `declareAttacks`,
 *  not here. */
export function validateAttacksImpl(
  state: BattleState,
  unitId: string,
  weaponDecls: readonly WeaponAttackDecl[],
  physicalDecls: readonly PhysicalAttackDecl[] = [],
  options: DeclareAttacksOptions = {},
): ValidatedAttackVolley {
  const unit = requireUnit(state, unitId);
  const wantWeapons = weaponDecls.length > 0;
  const wantPhysical = physicalDecls.length > 0;
  if (!wantWeapons && !wantPhysical)
    throw new Error("declareAttacks requires at least one declaration");
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is destroyed`);
  if (isShutdown(unit))
    throw new Error(
      wantWeapons
        ? `${unitId} is shut down and cannot fire`
        : `${unitId} is shut down and cannot attack`,
    );
  if (isPilotUnconscious(unit))
    throw new Error(
      wantWeapons
        ? `${unitId} is unconscious and cannot fire`
        : `${unitId} is unconscious and cannot attack`,
    );
  const def = mechDefFor(unit);
  const twist = options.twist ?? "front";
  const dropping = options.dropClub === true;
  if (dropping && unit.club === null) {
    throw new Error(`${unitId} holds no club to drop`);
  }
  // Carrying a club occupies both hands (TW p.146): punch, strike,
  // and arm-mounted weapon fire are barred until it is dropped first.
  const handsOccupied = unit.club !== null && !dropping;
  const normalizedPhysical = normalizePhysicalDecls(def, physicalDecls);
  if (wantPhysical) {
    checkPhysicalSetShape(unitId, normalizedPhysical);
    // TW p.145: the two punches may go to two different targets; every
    // other physical attack (and weapon fire) is independent of the weapon
    // target, so no single-target rule applies here.
    const physicalTargets = new Set(normalizedPhysical.map((p) => p.targetId));
    if (physicalTargets.size > 1 && normalizedPhysical.some((p) => p.type !== "punch")) {
      throw new Error("Only two punches may be split between two targets");
    }
    for (const p of normalizedPhysical) {
      const result = validatePhysicalAttack(state, unitId, p, twist, dropping);
      if (!result.ok) throw new Error(result.reason ?? "invalid physical attack");
    }
  }
  const sensorsOut = countDestroyedSensor(def, unit.damage, unit.critSlotsDestroyed);
  if (wantWeapons && sensorsBlind(sensorsOut)) {
    throw new Error(`${unitId} cannot fire: sensors destroyed (no weapon attacks)`);
  }
  const sensorMod = sensorAttackModifier(sensorsOut);
  const effectiveFacing = effectiveFacingForTwist(unit.facing, options.twist ?? "front");
  if (unit.prone && twistDelta(options.twist ?? "front") !== 0) {
    throw new Error(`${unitId} cannot twist torso while prone`);
  }
  if (wantWeapons && unit.prone) {
    if (
      isUnitLocationDestroyed(unit.damage, "leftArm") ||
      isUnitLocationDestroyed(unit.damage, "rightArm")
    ) {
      throw new Error(`${unitId} cannot fire while prone (need both arm location)`);
    }
    const hasLeft = weaponDecls.some((d) => def.weapons[d.weaponIndex]?.location === "leftArm");
    const hasRight = weaponDecls.some((d) => def.weapons[d.weaponIndex]?.location === "rightArm");
    if (hasLeft && hasRight) {
      throw new Error(`${unitId} cannot fire while prone (volley uses both arms; prop one)`);
    }
  }

  // Multiple targets (TW p.108): classify every weapon target against the
  // twisted facing first, so the primary target and each secondary modifier
  // are known before any to-hit is computed. Invalid targets are left for
  // the per-weapon checks below to reject with their specific error.
  const declaredTargets = [...new Set(weaponDecls.map((d) => d.targetId))];
  const forwardArcOf = new Map<string, boolean>();
  for (const id of declaredTargets) {
    const t = state.units[id];
    if (t === undefined || !isUnitOnBoard(t) || !isTargetableBy(unit, t)) continue;
    const a = classifyFiringArc(unit.position, t.position, effectiveFacing);
    if (a !== null) forwardArcOf.set(id, a === "front");
  }
  let primaryTargetId: string | null = null;
  if (declaredTargets.length > 0 && forwardArcOf.size === declaredTargets.length) {
    const forward = declaredTargets.filter((id) => forwardArcOf.get(id) === true);
    const requested = options.primaryTargetId;
    if (requested !== undefined) {
      if (!declaredTargets.includes(requested)) {
        throw new Error(`primary target ${requested} is not a declared weapon target`);
      }
      if (forward.length > 0 && !forward.includes(requested)) {
        throw new Error("primary target must be in the forward arc when any target is");
      }
      primaryTargetId = requested;
    } else {
      const first = declaredTargets[0]!;
      primaryTargetId = forward.length === 0 || forward.includes(first) ? first : forward[0]!;
    }
  }
  const secondaryModFor = (id: string): 0 | SecondaryTargetMod =>
    primaryTargetId === null || id === primaryTargetId
      ? 0
      : secondaryTargetModifier(unit.position, requireUnit(state, id).position, unit.facing, twist);

  const targetVolleys = new Map<string, ValidatedTargetVolley>();
  const seenWeapons = new Set<number>();
  const arcs: Record<number, Arc> = {};
  // TW p.103-104: same-name mounts share one ammo pool (any bin of the
  // right type, any location). Track claims within this volley so twins
  // declaring together cannot both spend the last shot.
  const claimedByWeaponName = new Map<string, number>();
  weaponDecls.forEach((decl) => {
    const mount = def.weapons[decl.weaponIndex];
    if (!mount) throw new Error(`weaponIndex ${decl.weaponIndex} out of range for ${unitId}`);
    const weapon = weaponDefFor(mount);
    if (weapon.physicalWeapon === true) {
      throw new Error(
        `${mount.weapon} on ${unitId} is physical-weapon equipment: strike with it, do not fire it`,
      );
    }
    if (!isFireableWeapon(weapon)) {
      throw new Error(`${mount.weapon} on ${unitId} is equipment, not a fireable weapon`);
    }

    if (seenWeapons.has(decl.weaponIndex)) {
      throw new Error(`${mount.weapon} on ${unitId} may only be declared once per turn`);
    }
    seenWeapons.add(decl.weaponIndex);

    if (unit.jammedWeapons.includes(decl.weaponIndex)) {
      throw new Error(`${mount.weapon} on ${unitId} is jammed`);
    }
    // Location first: a catastrophic wipe flags every slot there, and the
    // lost location is the clearer reason.
    if (!canFireMount(unit.damage, mount)) {
      throw new Error(
        `${mount.weapon} location (${mount.location}) is destroyed or its support torso is gone`,
      );
    }
    if (isWeaponCritted(def, unit.critSlotsDestroyed, decl.weaponIndex)) {
      throw new Error(`${mount.weapon} on ${unitId} is destroyed by a critical hit`);
    }
    if (handsOccupied && isArm(mount.location)) {
      throw new Error(
        `${mount.weapon} on ${unitId} cannot fire: hands occupied by club (drop it first)`,
      );
    }
    if (unit.prone && (mount.location === "rightLeg" || mount.location === "leftLeg")) {
      throw new Error(`${mount.weapon} on ${unitId} cannot fire while prone (leg-mounted)`);
    }
    const rapidFire = decl.rapidFire ?? false;
    if (rapidFire && weapon.rapidFireShots === undefined) {
      throw new Error(`${mount.weapon} is not rapid-fire`);
    }
    const shots = rapidFire ? (weapon.rapidFireShots ?? 1) : 1;

    const target = requireUnit(state, decl.targetId);
    if (!isUnitOnBoard(target)) throw new Error(`Target ${target.id} is removed from play`);
    if (!isTargetableBy(unit, target)) throw new Error("Target must belong to another team");

    const dist = hexDistance(unit.position, target.position);
    // Attacker-side firing arc (weapon legality, TW p.105 hex template).
    // Torso twist rotates the attacker's effective facing (see
    // `effectiveFacingForTwist`) before this classification so arm and
    // front-torso weapons cover the twisted arc. The template assigns every
    // hex wholly to one arc (no boundary pairs).
    // leg mounted weapon follows unit facing
    const fireArc = classifyFiringArc(
      unit.position,
      target.position,
      isLeg(mount.location) ? unit.facing : effectiveFacing,
    );
    if (fireArc === null) throw new Error("Attacker and target share a hex");
    arcs[decl.weaponIndex] = fireArc;
    const inArc = mountCanFireIntoArc(mount, fireArc);
    if (!inArc) {
      throw new Error(
        `${mount.weapon} on ${unitId} cannot fire into the ${fireArc} arc (target outside its firing arc)`,
      );
    }
    // Target-side attack direction (TW p.119): which side of the target the
    // attack strikes. Same for every weapon fired at this target.
    let targetVolley = targetVolleys.get(target.id);
    const losProne = losEnds(state, unit, target);
    const losSide = losSideFor(state, unit, target, losProne);
    const attackDirection =
      targetVolley?.attackDirection ?? attackDirectionFor(state, unit, target, losSide);

    const woodsPoints = losWoodsPointsBetween(
      state,
      unit.position,
      target.position,
      losProne,
      losSide,
    );
    if (!losClear(state, unit.position, target.position, losProne)) {
      if (losBlockedByBuilding(state, unit.position, target.position, losProne)) {
        throw new Error("Line of sight is blocked by intervening building");
      }
      if (losBlockedByElevation(state, unit.position, target.position, losProne)) {
        throw new Error("Line of sight is blocked by intervening elevation");
      }
      throw new Error("Line of sight is blocked by intervening woods");
    }

    if (dist > weapon.long) {
      throw new Error(`${mount.weapon}: target at range ${dist} exceeds long range ${weapon.long}`);
    }

    const breakdown = computeToHit({
      gunnery: unit.gunnery,
      attackerMovement: unit.moveMode ?? "standStill",
      attackerProne: unit.prone,
      sensorMod,
      actuatorMod: armWeaponToHitModifier(
        def,
        unit.damage,
        unit.critSlotsDestroyed,
        mountArcLocation(mount),
      ),
      targetHexesMoved: target.hexesMovedThisTurn,
      targetJumped: target.jumpedThisTurn,
      targetImmobile: isImmobile(target),
      targetProne: target.prone,
      targetTerrain: cellAt(state, target.position).terrain,
      partialCoverMod: partialCoverMod(state, unit, target, losSide),
      interveningWoods: woodsPoints,
      distance: dist,
      weapon,
      heatMod: toHitHeatModifier(unit.heat),
      tcMod: targetingComputerModifier(def, unit.damage, unit.critSlotsDestroyed, weapon),
      secondaryTargetMod: secondaryModFor(target.id),
    });
    targetVolley = {
      targetId: target.id,
      count: (targetVolley?.count ?? 0) + 1,
      attackDirection,
      distance: targetVolley?.distance ?? dist,
      rangeBracket: targetVolley?.rangeBracket ?? breakdown.rangeBracket,
      rangeMod: targetVolley?.rangeMod ?? breakdown.rangeMod,
      secondaryMod: secondaryModFor(target.id),
    };
    targetVolleys.set(target.id, targetVolley);
    if (breakdown.automatic === "miss") {
      throw new Error(
        `${mount.weapon}: modified TN ${toHitTotal(breakdown)} auto-misses; abort the declaration instead`,
      );
    }

    const needed = weapon.missiles !== undefined ? 1 : shots;
    // Pooled by weapon name: an unbound twin still draws from the shared
    // pool, so it gates and spends exactly like its sibling. Streaks fire
    // only on a hit (TW p.138) and resolve mid-volley exhaustion with an
    // auto-miss, so they need only one shared shot to declare and never
    // claim it up front; non-streaks spend at declare and accumulate.
    if (binsForWeaponName(def, mount.weapon).length > 0) {
      const left = pooledShotsLeft(def, unit, mount.weapon);
      if (weapon.streak === true) {
        if (left < 1) {
          throw new Error(`${mount.weapon}: needs 1 shot(s) but only ${left} remain`);
        }
      } else {
        const claimed = claimedByWeaponName.get(mount.weapon) ?? 0;
        if (left < claimed + needed) {
          throw new Error(`${mount.weapon}: needs ${needed} shot(s) but only ${left} remain`);
        }
        claimedByWeaponName.set(mount.weapon, claimed + needed);
      }
    }
  });

  const conflict = physicalWeaponConflict(def, weaponDecls, normalizedPhysical);
  if (conflict !== null) throw new Error(conflict);

  return {
    primaryTargetId,
    targets: declaredTargets.map((id) => targetVolleys.get(id)!),
    arcs,
    normalized: normalizedPhysical,
  };
}

export function validateAttacks(
  state: BattleState,
  unitId: string,
  weaponDecls: readonly WeaponAttackDecl[],
  physicalDecls: readonly PhysicalAttackDecl[] = [],
  options: DeclareAttacksOptions = {},
): void {
  validateAttacksImpl(state, unitId, weaponDecls, physicalDecls, options);
}

/**
 * Declare weapon and/or physical attacks for the current
 * weapon-attack-phase actor in one atomic call — the unit's single
 * attack declaration for the turn (a second call of either kind throws).
 * Weapons and physical attacks coexist in one turn (e.g. punch plus torso
 * weapons); commit order at resolution is weapons first, then physical.
 * Validates the full combined set (including the arm/leg weapon
 * interaction backstop) before mutating anything, so a throwing call
 * leaves no partial declarations behind. Emits one merged
 * `attacksDeclared` event carrying one weapon volley per target (primary
 * first; empty when the declaration holds physicals only) and the physical entries. At least
 * one declaration of either kind is required — except a lone `dropClub`,
 * which spends the activation shedding the club and attacking nothing.
 */
export function declareAttacks(
  state: BattleState,
  unitId: string,
  weaponDecls: readonly WeaponAttackDecl[] = [],
  physicalDecls: readonly PhysicalAttackDecl[] = [],
  sink: GameEvent[],
  rng: Rng,
  options: DeclareAttacksOptions = {},
): void {
  requireCurrentActor(state, unitId, "attack");
  const unit = requireUnit(state, unitId);
  const wantWeapons = weaponDecls.length > 0;
  const wantPhysical = physicalDecls.length > 0;
  if (!wantWeapons && !wantPhysical) {
    // Drop-only declaration: the unit spends its activation shedding the
    // club and attacks nothing this turn.
    if (options.dropClub !== true)
      throw new Error("declareAttacks requires at least one declaration");
    if (isUnitRemoved(unit)) throw new Error(`${unitId} is destroyed`);
    if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot attack`);
    if (isPilotUnconscious(unit)) throw new Error(`${unitId} is unconscious and cannot attack`);
    if (unit.club === null) throw new Error(`${unitId} holds no club to drop`);
    applyClubDrop(state, unit, sink);
    sink.push({ kind: "attacksDeclared", unitId, weapons: [], physical: [] });
    if (!state.actedThisPhase.includes(unitId)) state.actedThisPhase.push(unitId);
    return;
  }
  if (
    unit.declaredWeaponAttacks.length > 0 ||
    unit.declaredPhysicalAttacks.length > 0 ||
    unit.declaredPickup !== null
  )
    throw new Error(`${unitId} already declared attacks this turn`);
  const volley = validateAttacksImpl(state, unitId, weaponDecls, physicalDecls, options);
  const def = mechDefFor(unit);
  // Drop rides first in the declaration: hands are free for everything
  // queued below (validated as such above). The club stays intact in the
  // hex immediately, visible to later declarers.
  if (options.dropClub === true) {
    if (unit.club === null) throw new Error(`${unitId} holds no club to drop`);
    applyClubDrop(state, unit, sink);
  }
  // Consume non-streak ammo from the shared weapon-name pool per decl
  // (TW p.103-104); streak fires on hit and resolves its own ammo in
  // `resolveUnitAttacks`. RNG via ammo policy.
  if (wantWeapons) {
    for (const decl of weaponDecls) {
      const targetVolley = volley.targets.find((t) => t.targetId === decl.targetId);
      unit.declaredWeaponAttacks.push({
        ...decl,
        ...(volley.arcs[decl.weaponIndex] !== undefined
          ? { arc: volley.arcs[decl.weaponIndex] }
          : {}),
        ...(targetVolley !== undefined
          ? {
              attackDirection: targetVolley.attackDirection,
              ...(targetVolley.secondaryMod !== 0
                ? { secondaryMod: targetVolley.secondaryMod }
                : {}),
            }
          : {}),
      });
      const mount = def.weapons[decl.weaponIndex];
      if (!mount) continue;
      const weapon = weaponDefFor(mount);
      const rapidFire = decl.rapidFire ?? false;
      const shots = rapidFire ? (weapon.rapidFireShots ?? 1) : 1;
      const needed = weapon.missiles !== undefined ? 1 : shots;
      if (binsForWeaponName(def, mount.weapon).length === 0) continue;
      if (weapon.streak === true) continue;
      unit.ammoBins = consumeAmmoForName(def, unit, mount.weapon, needed, unit.ammoPolicy, rng);
    }
  }
  if (wantPhysical) {
    for (const decl of volley.normalized) {
      unit.declaredPhysicalAttacks.push({
        ...decl,
        ...(options.twist ? { twist: options.twist } : {}),
      });
    }
  }
  sink.push({
    kind: "attacksDeclared",
    unitId,
    weapons: [...volley.targets]
      .sort(
        (a, b) =>
          Number(b.targetId === volley.primaryTargetId) -
          Number(a.targetId === volley.primaryTargetId),
      )
      .map((t) => ({
        targetId: t.targetId,
        count: t.count,
        distance: t.distance,
        rangeBracket: t.rangeBracket,
        rangeMod: t.rangeMod,
        secondaryMod: t.secondaryMod,
      })),
    physical: volley.normalized.map((d) => ({
      type: d.type,
      targetId: d.targetId,
      ...(d.weapon !== undefined ? { weapon: d.weapon as PhysicalWeaponName } : {}),
    })),
  });
  if (!state.actedThisPhase.includes(unitId)) state.actedThisPhase.push(unitId);
}

/**
 * Validate a club pickup declaration (TW p.146). Checks unit status (no
 * prior declaration of any kind this turn — pickup is exclusive with every
 * weapon and physical attack), empty hands, and that the unit's hex offers
 * the requested source (or any source when omitted, by precedence).
 * Pure: no state change, no RNG. Returns the resolved source.
 */
export function validatePickup(
  state: BattleState,
  unitId: string,
  decl: ClubPickupDecl = {},
): ({ ok: true } & DeclaredPickup) | { ok: false; reason: string } {
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) return { ok: false, reason: `${unitId} is removed from play` };
  if (isShutdown(unit)) return { ok: false, reason: `${unitId} is shut down and cannot pick up` };
  if (isPilotUnconscious(unit))
    return { ok: false, reason: `${unitId} is unconscious and cannot pick up` };
  if (
    unit.declaredWeaponAttacks.length > 0 ||
    unit.declaredPhysicalAttacks.length > 0 ||
    unit.declaredPickup !== null
  ) {
    return { ok: false, reason: `${unitId} already declared attacks this turn` };
  }
  if (unit.club !== null) {
    return { ok: false, reason: `${unitId} already holds a club (drop it first)` };
  }
  if (!clubHandsFunctional(mechDefFor(unit), unit.damage, unit.critSlotsDestroyed)) {
    return { ok: false, reason: `${unitId} needs two working hands to pick up a club` };
  }
  const choice = choosePickup(state, unit, decl);
  if (!choice.ok) return choice;
  return choice.token === undefined
    ? { ok: true, source: choice.source }
    : { ok: true, source: choice.source, token: choice.token };
}

/**
 * Declare a club pickup for the current attack-phase actor (TW p.146).
 * Exclusive with every weapon and physical declaration: the pickup turn
 * allows no attacks at all. The environment is checked now; acquisition
 * itself resolves in the physical sub-pass of `resolveAllAttacks`.
 * Emits `pickupDeclared` and marks the actor done for the phase.
 */
export function declarePickup(
  state: BattleState,
  unitId: string,
  decl: ClubPickupDecl,
  sink: GameEvent[],
): void {
  requireCurrentActor(state, unitId, "attack");
  const result = validatePickup(state, unitId, decl);
  if (!result.ok) throw new Error(result.reason);
  const unit = requireUnit(state, unitId);
  unit.declaredPickup =
    result.token === undefined
      ? { source: result.source }
      : { source: result.source, token: result.token };
  sink.push({ kind: "pickupDeclared", unitId, source: result.source });
  if (!state.actedThisPhase.includes(unitId)) state.actedThisPhase.push(unitId);
}

/**
 * Resolve one declared pickup in the physical sub-pass (TW p.146). The
 * declaration-time environment is re-checked against the unit's current
 * hex: falls or kills since declaration can void it. Limb
 * and tree acquisition are automatic; girders need 2D6 against 7+/6+/5+
 * by rubble origin. Emits `clubPickedUp` in all cases.
 */
function resolveClubPickup(
  state: BattleState,
  unit: UnitState,
  decl: DeclaredPickup,
  rng: Rng,
  sink: GameEvent[],
): void {
  const fail = (reason: string): void => {
    sink.push({ kind: "clubPickedUp", unitId: unit.id, success: false, reason });
  };
  if (isUnitRemoved(unit) || isPilotUnconscious(unit) || isShutdown(unit)) {
    fail("attackerDown");
    return;
  }
  if (!clubHandsFunctional(mechDefFor(unit), unit.damage, unit.critSlotsDestroyed)) {
    fail("noHands");
    return;
  }
  const tokens = clubTokensInHex(state, unit);
  // A declared token must still lie here (another unit may have taken it);
  // otherwise re-resolve from the hex as declared.
  let token: ClubGroundToken | undefined;
  const declared = decl.token;
  if (declared !== undefined) {
    token = tokens.find((t) => sameToken(t, declared));
    if (token === undefined) {
      fail("noSource");
      return;
    }
  }
  const choice =
    token !== undefined
      ? { ok: true as const, source: token.kind, token }
      : choosePickup(state, unit, { source: decl.source });
  if (!choice.ok) {
    fail("noSource");
    return;
  }
  const key = hexKey(unit.position);
  if (choice.token !== undefined) {
    const picked = choice.token;
    const at = tokens.findIndex((t) => sameToken(t, picked));
    state.clubs[key] = tokens.filter((_, i) => i !== at);
    if (picked.kind === "limb") {
      unit.club = { kind: "limb", limb: picked.limb, model: picked.model, ownerId: picked.ownerId };
      voidLimbSalvage(state, picked);
    } else {
      unit.club = { kind: picked.kind };
    }
    sink.push({ kind: "clubPickedUp", unitId: unit.id, success: true, clubKind: picked.kind });
    return;
  }
  if (choice.source === "tree") {
    unit.club = { kind: "tree" };
    sink.push({ kind: "clubPickedUp", unitId: unit.id, success: true, clubKind: "tree" });
    return;
  }
  const origin = state.rubbleOrigin[key];
  const required = (origin !== undefined ? GIRDER_SEARCH_TARGET[origin] : undefined) ?? null;
  if (required === null) {
    fail("noSource");
    return;
  }
  const roll = roll2D6(rng);
  if (roll >= required) {
    unit.club = { kind: "girder" };
    sink.push({
      kind: "clubPickedUp",
      unitId: unit.id,
      success: true,
      clubKind: "girder",
      roll,
      required,
    });
  } else {
    sink.push({
      kind: "clubPickedUp",
      unitId: unit.id,
      success: false,
      clubKind: "girder",
      roll,
      required,
      reason: "searchFailed",
    });
  }
}

/** Mark a picked-up severed limb as no longer salvageable (house rule). */
function voidLimbSalvage(state: BattleState, token: ClubGroundToken & { kind: "limb" }): void {
  if (token.ownerId === null) return;
  const owner = state.units[token.ownerId];
  if (owner === undefined) return;
  for (const entry of owner.blownOffLimbs) if (entry.limb === token.limb) entry.salvageable = false;
}

/**
 * Severed limbs of `unitId` still worth salvaging: never picked up (the
 * `salvageable` flag in `blownOffLimbs`) and holding at
 * least one weapon crit slot that survived. A slot counts as destroyed
 * when its flag is set OR its location is destroyed — plain-damage
 * destruction leaves slot flags unset by design, but blow-off preserves them.
 * Blow-off itself does not destroy the limb's contents (TW p.145).
 */
export function salvageableSeveredLimbs(state: BattleState, unitId: string): LimbLocation[] {
  const unit = requireUnit(state, unitId);
  const def = mechDefFor(unit);
  const out: LimbLocation[] = [];
  for (const { limb, salvageable } of unit.blownOffLimbs) {
    if (!salvageable) continue;
    const slots = def.critSlots[limb];
    if (
      slots.some(
        (slot, i) => slot.kind === "weapon" && !isSlotDestroyed(unit.critSlotsDestroyed, limb, i),
      )
    )
      out.push(limb);
  }
  return out;
}

/**
 * Apply a club drop: clear the held club, leave it intact as a token in the
 * hex (any kind; a later pickup of a token is automatic), and emit
 * `clubDropped`. Caller guarantees `unit.club !== null`. `cause` marks
 * involuntary drops (a fall, or the holder leaving play).
 */
function applyClubDrop(
  state: BattleState,
  unit: UnitState,
  sink: GameEvent[],
  cause?: "fall" | "removed" | "hands",
): void {
  const held = unit.club;
  if (held === null) throw new Error(`${unit.id} holds no club to drop`);
  unit.club = null;
  const key = hexKey(unit.position);
  const token: ClubGroundToken =
    held.kind === "limb"
      ? { kind: "limb", limb: held.limb, model: held.model, ownerId: held.ownerId }
      : { kind: held.kind };
  state.clubs[key] = [...(state.clubs[key] ?? []), token];
  sink.push({
    kind: "clubDropped",
    unitId: unit.id,
    clubKind: held.kind,
    col: unit.position.col,
    row: unit.position.row,
    returned: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Involuntary release (TW silent): a unit that falls, drops prone, or
 *  leaves play lets go of its club in the hex where it ends up. */
function releaseClub(
  state: BattleState,
  unit: UnitState,
  cause: "fall" | "removed" | "hands",
  sink: GameEvent[],
): void {
  if (unit.club !== null) applyClubDrop(state, unit, sink, cause);
}

/**
 * Forced drop (TW p.146): a unit whose arms or hand actuators no longer let
 * it hold a club (see `clubHandsFunctional`) lets go of it in its hex. A
 * shoulder hit alone keeps the club; it only blocks the swing.
 */
function enforceClubHands(state: BattleState, unit: UnitState, sink: GameEvent[]): void {
  if (unit.club === null) return;
  if (!clubHandsFunctional(mechDefFor(unit), unit.damage, unit.critSlotsDestroyed)) {
    applyClubDrop(state, unit, sink, "hands");
  }
}

function enforceClubHandsAll(state: BattleState, sink: GameEvent[]): void {
  for (const unit of Object.values(state.units)) enforceClubHands(state, unit, sink);
}

/**
 * Weapon / physical-attack interaction backstop (TW pp. 145–147): a
 * punching or striking arm or kicking leg cannot fire its mounted weapons
 * that turn, and a pushing / clubbing 'Mech fires no arm-mounted weapons
 * at all. Returns a human-readable conflict, or null when the combination
 * is legal. The web layer pre-checks the same rules for better messages;
 * `declareAttacks` enforces them on the combined declaration set.
 */
function physicalWeaponConflict(
  def: ResolvedMechDef,
  weaponDecls: readonly WeaponAttackDecl[],
  physicalDecls: readonly PhysicalAttackDecl[],
): string | null {
  const punchedArms = new Set<string>();
  const kickedLegs = new Set<string>();
  const struckArms = new Set<string>();
  let noArmWeapons = false;
  for (const p of physicalDecls) {
    if (p.type === "punch" && p.limb !== undefined) punchedArms.add(p.limb);
    if (p.type === "kick" && p.limb !== undefined) kickedLegs.add(p.limb);
    if (p.type === "strike" && p.weapon !== undefined) {
      const arm = resolveStrikeArm(def, p.weapon, p.limb);
      if (arm !== null) struckArms.add(arm);
    }
    if (p.type === "club") noArmWeapons = true;
  }
  for (const w of weaponDecls) {
    const loc = def.weapons[w.weaponIndex]?.location;
    if (loc === undefined) continue;
    if (punchedArms.has(loc)) return `punching ${loc} cannot fire its weapons`;
    if (struckArms.has(loc)) return `striking ${loc} cannot fire its weapons`;
    if (kickedLegs.has(loc)) return `kicking ${loc} cannot fire its weapons`;
    if (noArmWeapons && isArm(loc)) return "pushing/clubbing 'Mech fires no arm-mounted weapons";
  }
  return null;
}

/** Running per-unit {@link CritState} while a volley resolves: every weapon
 *  sees the damage and criticals of the weapons resolved before it (TW p.125:
 *  crits are rolled "before resolving any further weapons fire"). It is also
 *  the unit's one ammo ledger for the phase: its own Streak spending and the
 *  crits it takes both act on `ammoBins` here. The unit's own volley never
 *  reads it (see `resolveUnitAttacks`): only the unit's targets do. */
interface RunningState {
  damage: UnitDamageState;
  critSlotsDestroyed: CritMask;
  ammoBins: AmmoBins;
}

/** The unit's running state, created from its committed state on first use. */
function runningStateFor(running: Record<string, RunningState>, unit: UnitState): RunningState {
  let run = running[unit.id];
  if (run === undefined) {
    run = {
      damage: cloneDamage(unit.damage),
      critSlotsDestroyed: cloneCritTable(unit.critSlotsDestroyed),
      ammoBins: { ...unit.ammoBins },
    };
    running[unit.id] = run;
  }
  return run;
}

function resolveUnitAttacks(
  state: BattleState,
  unit: UnitState,
  rng: Rng,
  running: Record<string, RunningState>,
  phaseStartCf: Record<string, number>,
): UnitAttackResult {
  const def = mechDefFor(unit);
  const preHeat = unit.heat;
  const sensorMod = sensorAttackModifier(
    countDestroyedSensor(def, unit.damage, unit.critSlotsDestroyed),
  );
  const pronePropArm = inferPronePropArm(def, unit.declaredWeaponAttacks, unit.prone);
  // TW resolves weapon attacks simultaneously, so the unit's own Streak
  // launchers see its bins as they stood at phase start: damage and crits
  // other units' fire put on it this phase cannot strand, destroy or
  // explode a bin out from under its own volley, whatever the resolution
  // order. `own` is that phase-start view, debited only by the unit's own
  // Streak shots; each shot is mirrored onto the running ledger `self`
  // (which carries the crits the unit takes) so the phase ends with one
  // set of bins and no shot spent twice.
  const own: RunningState = {
    damage: unit.damage,
    critSlotsDestroyed: unit.critSlotsDestroyed,
    ammoBins: { ...unit.ammoBins },
  };
  const self = runningStateFor(running, unit);
  const jammedWeapons: number[] = [];
  const resolutions: UnitAttackResolution[] = [];

  for (const decl of unit.declaredWeaponAttacks) {
    const mount = def.weapons[decl.weaponIndex]!;
    const weapon = weaponDefFor(mount);
    const target = requireUnit(state, decl.targetId);
    const losProne = losEnds(state, unit, target);
    const losSide = losSideFor(state, unit, target, losProne);
    const secondaryMod = decl.secondaryMod ?? 0;
    const rapidFire = decl.rapidFire ?? false;
    const shots = rapidFire ? (weapon.rapidFireShots ?? 1) : 1;
    let ammoExhausted = false;

    // Streak launchers share one pool per weapon name and fire only on a
    // hit: an earlier launcher may have drained the pool mid-resolution.
    // With nothing left the launcher cannot fire — auto-miss without
    // touching dice (no ammo spent, no heat).
    if (weapon.streak === true && pooledShotsLeft(def, own, weapon.name) < 1) {
      ammoExhausted = true;
    }

    const run = runningStateFor(running, target);
    const targetBaseDamage = run.damage;

    const resolution = resolveWeaponAttack({
      rng,
      gunnery: unit.gunnery,
      attackerMoved: unit.moveMode ?? "standStill",
      attackerHeat: preHeat,
      tcMod: targetingComputerModifier(def, unit.damage, unit.critSlotsDestroyed, weapon),
      ...(secondaryMod !== 0 ? { secondaryTargetMod: secondaryMod } : {}),
      attackerProne: unit.prone,
      ...(pronePropArm !== null ? { propArm: pronePropArm } : {}),
      sensorMod,
      actuatorMod: armWeaponToHitModifier(
        def,
        unit.damage,
        unit.critSlotsDestroyed,
        mountArcLocation(mount),
      ),
      targetHexesMoved: target.hexesMovedThisTurn,
      targetJumped: target.jumpedThisTurn,
      targetImmobile: isImmobile(target),
      targetProne: target.prone,
      targetTerrain: cellAt(state, target.position).terrain,
      partialCoverMod: partialCoverMod(state, unit, target, losSide),
      interveningTerrains: interveningTerrains(
        state,
        unit.position,
        target.position,
        losProne,
        losSide,
      ),
      distance: hexDistance(unit.position, target.position),
      // Resolution keys hit location and armor pool off the attack direction
      // (side of the target struck); the attacker-side firing arc only
      // gatekept the declaration.
      ...(decl.attackDirection !== undefined
        ? { arc: decl.attackDirection }
        : decl.arc !== undefined
          ? { arc: decl.arc }
          : {}),
      weapon: weapon.name,
      heatMode: unit.heatFlamer,
      ammoExhausted,
      shots,
      targetDamage: targetBaseDamage,
      buildingAbsorb: Math.ceil(
        (phaseStartCf[hexKey(target.position)] ?? 0) / BUILDING_ABSORB_DIVISOR,
      ),
      missesStrikeBuilding:
        phaseStartCf[hexKey(target.position)] !== undefined &&
        isAdjacent(unit.position, target.position),
      attackerLevel: cellAt(state, unit.position).level,
      targetLevel: cellAt(state, target.position).level,
      ...(state.critsDisabled
        ? {}
        : {
            targetCrits: {
              model: target.model,
              critSlotsDestroyed: run.critSlotsDestroyed,
              ammoBins: run.ammoBins,
              baseCritSlotsDestroyed: target.critSlotsDestroyed,
            },
          }),
    });
    run.damage = resolution.targetDamageAfter;
    const lastCrit = resolution.crits[resolution.crits.length - 1];
    if (lastCrit !== undefined) {
      run.critSlotsDestroyed = lastCrit.critSlotsDestroyed;
      run.ammoBins = lastCrit.ammoBins;
    }

    // Streak launchers expend one shot only when to-hit succeeds: miss
    // means launcher never fired (no ammo, no heat, no damage).
    const streakFired = weapon.streak === true && resolution.hit;
    if (weapon.streak === true && !resolution.hit) {
      resolutions.push({
        targetId: target.id,
        secondaryMod,
        resolution,
        weaponHeat: 0,
        buildingDamage: 0,
      });
      continue;
    }
    // Draw from the shared weapon-name pool so mounts with no directly
    // linked bins still spend shared ammo. The pre-resolution guard above
    // guarantees at least one shot remains, so this always draws exactly 1.
    if (streakFired) {
      const next = consumeAmmoForName(def, own, weapon.name, 1, unit.ammoPolicy, rng);
      const mirrored: AmmoBins = { ...self.ammoBins };
      for (const [id, left] of Object.entries(next)) {
        const spent = (own.ammoBins[id] ?? 0) - left;
        // A bin already exploded or spilled this phase holds 0: the shot
        // left it before the blast, so there is nothing more to take.
        if (spent > 0) mirrored[id] = Math.max(0, (mirrored[id] ?? 0) - spent);
      }
      own.ammoBins = next;
      self.ammoBins = mirrored;
    }

    const weaponHeat = (weapon.heat ?? 0) * shots;

    // TW p. 171: the hex absorbs, from each attack that hits, damage equal
    // to its CF at the beginning of the phase / 10 (round up). Each Damage
    // Value grouping with its own hit location roll counts as a separate
    // attack. The occupant takes only what the groupings have left
    // (absorbed inside `resolveWeaponAttack`); the building is charged what
    // it actually absorbed.
    const buildingDamage = resolution.buildingAbsorbed ?? 0;
    const coverHex =
      resolution.coverDamage !== undefined
        ? partialCoverBuildingHex(state, unit, target, losSide)
        : undefined;

    resolutions.push({
      targetId: target.id,
      secondaryMod,
      resolution,
      weaponHeat,
      buildingDamage,
      ...(coverHex !== undefined && resolution.coverDamage !== undefined
        ? { coverBuilding: { hex: coverHex, damage: resolution.coverDamage } }
        : {}),
    });

    if (resolution.jammed && !jammedWeapons.includes(decl.weaponIndex)) {
      jammedWeapons.push(decl.weaponIndex);
    }
  }

  return {
    unitId: unit.id,
    resolutions,
    jammedWeapons,
  };
}

/** Damage points taken per unit since a phase snapshot (TW p.60 20-point
 *  trigger), keyed by unit id. Sums of circles actually marked
 *  (`dealtOf` / `critDamageDealt`); step-5 wipes (TW p.122), vented CASE
 *  damage and unspent overkill never become steps, so they are excluded —
 *  unlike the `damageTaken` before/after diff, which counts wiped armor. */
export type PhaseDealt = Record<string, number>;

/**
 * Total armor + structure points lost between two damage states. Fallback
 * for the 20-point PSR trigger when the window's totals miss the unit
 * (a window filled by hand, damage outside any window):
 * unlike the ledger it also counts step-5 wiped armor (TW p.122), since a
 * before/after diff cannot tell wiped pools from hit ones.
 */
function damageTaken(before: UnitDamageState, after: UnitDamageState): number {
  let n = 0;
  for (const loc of LOCATIONS) {
    // An arm lost with its side torso is blown off, not damaged point by
    // point (TW p.121): its remaining armor and structure do not count.
    if (isArm(loc)) {
      const torso = damageTransferTo(loc);
      if (
        torso !== null &&
        before.internalStructure[torso] > 0 &&
        after.internalStructure[torso] <= 0
      )
        continue;
    }
    n += Math.max(0, before.armor[loc] - after.armor[loc]);
    if (isTorso(loc)) {
      n += Math.max(0, (before.armorRear[loc] ?? 0) - (after.armorRear[loc] ?? 0));
    }
    n += Math.max(0, before.internalStructure[loc] - after.internalStructure[loc]);
  }
  return n;
}

interface NewStructureHit {
  readonly location: Location;
  readonly name: string;
}

/** Structure slots destroyed now that were intact in the phase snapshot. */
function newlyDestroyedStructures(
  def: ResolvedMechDef,
  before: Readonly<CritMask>,
  now: Readonly<CritMask>,
): NewStructureHit[] {
  const out: NewStructureHit[] = [];
  for (const loc of Object.keys(def.critSlots) as Location[]) {
    const layout = def.critSlots[loc];
    for (let i = 0; i < layout.length; i++) {
      const slot = layout[i];
      if (slot?.kind !== "structure") continue;
      if (isSlotDestroyed(now, loc, i) && !isSlotDestroyed(before, loc, i)) {
        out.push({ location: loc, name: slot.type });
      }
    }
  }
  return out;
}

function legGone(damage: UnitDamageState, leg: "rightLeg" | "leftLeg"): boolean {
  return (damage.internalStructure[leg] ?? 0) <= 0;
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
function applyDamageGroups(
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
  // the weapon/physical paths; runs before the destruction sweep so a
  // head-destroying blow still tallies the hit before auto-eject raises the
  // pilot to one short of death, matching the weapon path ordering.
  const headGroups = groups.filter((g) => g.location === "head" && g.damage >= 1).length;
  if (headGroups > 0 && !headLossEjected(unit)) {
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
export interface FallOptions {
  readonly cause: UnitFallCause;
  /** Hex the 'Mech fell in (or onto). Copied onto the `unitFell` event. */
  readonly hex?: HexCoord;
  /**
   * Seatbelt-check modifier (same modifiers as the failed PSR; +5 for an
   * automatic fall off a destroyed leg, +6 off a destroyed gyro). `null`
   * skips the roll — the pilot takes 1 hit automatically (shut-down fall).
   */
  readonly seatbeltModifier: number | null;
  /** Halve the falling damage, rounding down (fall underwater, depth 2+). */
  readonly halved: boolean;
  /**
   * Water depth a 'Mech above the surface falls through to the bed (TW
   * p.57): damage is two halved packets, surface impact (`levelsFallen`)
   * plus bottom impact (this depth), each rounded down. Overrides `halved`.
   */
  readonly bottomDepth?: number;
  /** Underlying-terrain levels fallen (TW p.68): hex fell into minus hex
   *  the fall began from. Defaults to 0 (same-hex fall); callers that fall
   *  while moving across levels pass the drop. Jump-phase falls stay 0
   *  per errata even when the landing sits at another level. */
  readonly levelsFallen?: number;
  /** Allow the fall damage path on an already-prone unit (failed stand-up). */
  readonly allowProne?: boolean;
  /** Hit location is always the rear, whatever the fall direction rolled
   *  (a failed DFA, TW p.150). Facing after the fall still follows the roll. */
  readonly rearHits?: boolean;
}

/**
 * Immediate PSR when a unit's reactor shuts down (TW p.60, +3): rolled with
 * preexisting-damage modifiers even though the 'Mech is now down (only
 * *other* PSRs required while shut down fail automatically). Failure drops
 * the 'Mech on the spot; the pilot then takes the hit automatically via the
 * shutdown path in `applyFall`. No-op for removed or already-prone units.
 */
function shutdownFallCheck(state: BattleState, unit: UnitState, rng: Rng, sink: GameEvent[]): void {
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
function resolveBuildingCollapse(
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
function damageBuildingByUnit(
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

export interface PhaseSnapshots {
  readonly damage: Record<string, UnitDamageState>;
  readonly crit: Record<string, CritMask>;
}

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
  for (const unit of Object.values(state.units)) {
    if (unit.declaredWeaponAttacks.length === 0) continue;
    results.push(resolveUnitAttacks(state, unit, rng, running, phaseStartCf));
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
      if (headGroups > 0 && !headLossEjected(target))
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
    if (reason === "headHit" && headLossEjected(unit)) continue;
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

function processEndPhase(state: BattleState) {
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

export function advancePhase(state: BattleState, sink: GameEvent[], rng: Rng): void {
  sink.push(...advancePhaseGen(state, rng));
}

export function* advancePhaseGen(state: BattleState, rng: Rng): Generator<GameEvent> {
  const prevTurn = state.turn;
  const prevPhase = state.phase;
  state.actorQueue = null;
  switch (state.phase) {
    case "initiative": {
      if (state.initiativeWinnerTeam === null) {
        throw new Error("Roll initiative before leaving the initiative phase");
      }
      state.phase = "movement";
      break;
    }
    case "movement": {
      state.phase = "attack";
      state.actedThisPhase = [];
      break;
    }
    case "attack": {
      const sink: GameEvent[] = [];
      for (const unit of Object.values(state.units)) {
        if (awaitsDestroyedMark(unit) && isUnitWrecked(unit)) {
          markUnitDestroyed(state, unit, destroyedReasonFor(unit.damage), rng, sink);
        }
      }
      // The end phase starts with heat resolution: engine crit heat,
      // shutdown/restart checks, heat ammo explosions, then dissipation.
      resolveHeatPhase(state, rng, sink);
      sink.push({ kind: "attackPhaseStage", stage: "end", turn: state.turn });
      yield* sink;
      state.phase = "end";
      break;
    }
    case "end":
      processEndPhase(state);
      break;
  }
  yield { kind: "phase", prevTurn, prevPhase, turn: state.turn, phase: state.phase };
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
            // the rest of the phase.
            for (const lost of application.newlyDestroyed) {
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

/** Falls underwater halve damage: any depth 2+, plus a jump landing that
 *  tumbles to the bottom of depth 1 water (TW p.53). */
function waterHalvesFall(terrain: TerrainType, ground: boolean): boolean {
  const depth = waterDepth(terrain);
  return depth >= 2 || (!ground && depth >= 1);
}

/** Base to-hit of an Accidental Fall From Above (TW p.152). */
const ACCIDENTAL_FALL_BASE_TN = 7;
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
function movementTerrainPsr(
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
   *  the hex it came from. Accidental Falls From Above (TW p.152): two or more
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

/**
 * Stand-up attempt for a prone unit (TW p.50): spends `STAND_MP_COST` (or the
 * remaining walk budget, whichever is smaller — TW p.50 lets a 1-MP-prone
 * 'Mech like a one-leg unit still attempt to stand) and adds 1 heat, then
 * rolls a PSR with preexisting-damage modifiers only. On success the 'Mech
 * is left standing facing the direction it had been prone in; on failure it
 * crashes back down for fresh falling damage. A 'Mech with a destroyed gyro,
 * both legs gone, or one leg + both arms gone cannot attempt to stand (TW
 * p.50).
 *
 * Returns the MP cost actually charged for the stand. The stand ends the
 * activation; to move after it in the same activation, use
 * `executePostureMove`, which charges both from one pool.
 */
export function attemptStandUp(
  state: BattleState,
  unitId: string,
  sink: GameEvent[],
  rng: Rng,
  locomotion: MoveMode = "walk",
): number {
  requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (!unit.prone) throw new Error(`${unitId} is not prone`);
  if (unit.jumpedThisTurn) throw new Error(`${unitId} jumped this turn and cannot stand up`);
  if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot stand up`);
  if (isPilotUnconscious(unit)) throw new Error(`${unitId} is unconscious and cannot stand up`);
  const def = mechDefFor(unit);
  const pre = preexistingDamageModifier(def, unit.damage, unit.critSlotsDestroyed);
  const budget = standUpWalkBudget(unit);
  if (pre.gyroHits >= GYRO_DESTROYED_HITS)
    throw new Error(`${unitId} has a destroyed gyro and cannot stand up`);
  if (!canAttemptStandUp(unit.damage)) throw new Error(`${unitId} cannot stand up in this state`);
  const standCost = standUpCost(unit);
  unit.moveMode = "walk";
  unit.hexesMovedThisTurn = 0;
  unit.jumpedThisTurn = false;
  unit.mpSpent = standCost;
  state.actedThisPhase.push(unitId);
  // The stand costs 1 heat on top of the declared mode's own heat (TW p.159).
  const standHeat = POSTURE_MOVE_HEAT + (locomotion === "run" ? 2 : locomotion === "walk" ? 1 : 0);
  unit.heatPending += standHeat;
  sink.push({
    kind: "heatMove",
    unitId,
    heat: standHeat,
    base: unit.heat,
    totalGenerated: unit.heatPending,
  });
  const r = pushPilotingCheck(sink, unit, "standUp", 0, pre.modifier, rng, unit.position);
  if (r.success) {
    unit.prone = false;
    sink.push({
      kind: "moved",
      unitId,
      mode: "walk",
      prevMode: "prone",
      position: unit.position,
      facing: unit.facing,
      mpSpent: standCost,
      mpBudget: budget,
    });
    return standCost;
  }
  // Failed stand: the 'Mech crashes back down (TW p.50) for fresh fall damage.
  const terrain = cellAt(state, unit.position).terrain;
  applyFall(
    state,
    unit,
    rng,
    {
      cause: { kind: "failedPsr", reason: "standUp" },
      hex: unit.position,
      seatbeltModifier: pre.modifier,
      halved: terrain === "water2" || terrain === "water3",
      allowProne: true,
    },
    sink,
  );
  return standCost;
}

/** Walking MP a stand-up attempt draws on, whatever locomotion follows. */
function standUpWalkBudget(unit: UnitState): number {
  const def = mechDefFor(unit);
  return effectiveMoveBudget(
    "walk",
    effectiveMovement(def, unit.damage, unit.critSlotsDestroyed, isTsmActive(def, unit.heat)),
    unit.heat,
  );
}

/** MP `attemptStandUp` charges: TW p.50 lets a prone 'Mech with only 1 MP
 *  (e.g. a one-leg 'Mech) still attempt to stand, at the cost of whatever
 *  walking budget it has, so the charge is capped at that budget. */
export function standUpCost(unit: UnitState): number {
  return Math.min(STAND_MP_COST, standUpWalkBudget(unit));
}

/**
 * Voluntary drop to the ground (TW p.49; 1 MP): no roll, no heat, no
 * falling damage; the 'Mech counts as walking for to-hit this turn.
 * Not allowed in a turn the 'Mech jumped.
 */
export function dropProne(state: BattleState, unitId: string, sink: GameEvent[]): void {
  requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (unit.prone) throw new Error(`${unitId} is already prone`);
  if (unit.jumpedThisTurn) throw new Error(`${unitId} jumped this turn and cannot drop prone`);
  if (isShutdown(unit)) throw new Error(`${unitId} is shut down and cannot move`);
  if (isPilotUnconscious(unit)) throw new Error(`${unitId} is unconscious and cannot move`);
  const def = mechDefFor(unit);
  const budget = effectiveMoveBudget(
    "walk",
    effectiveMovement(def, unit.damage, unit.critSlotsDestroyed, isTsmActive(def, unit.heat)),
    unit.heat,
  );
  if (budget < DROP_BUDGET_MIN) throw new Error(`${unitId} has no MP to drop prone`);
  const prevMode = unit.moveMode ?? "standStill";
  unit.moveMode = "walk";
  unit.hexesMovedThisTurn = 0;
  unit.jumpedThisTurn = false;
  unit.mpSpent = DROP_MP_COST;
  unit.prone = true;
  releaseClub(state, unit, "fall", sink);
  state.actedThisPhase.push(unitId);
  // TW p.49: dropping to the ground causes no falling damage. The unitFell
  // marker is kept (zero damage, no groups, no crits) so the posture change
  // stays visible in the event log.
  sink.push(
    {
      kind: "unitFell",
      unitId,
      cause: { kind: "voluntaryDrop" },
      hex: unit.position,
      facingAfter: unit.facing,
      fallRoll: null,
      column: "front",
      levelsFallen: 0,
      groups: [],
      crits: [],
    },
    {
      kind: "moved",
      unitId,
      mode: "prone",
      prevMode,
      position: unit.position,
      facing: unit.facing,
      mpSpent: DROP_MP_COST,
      mpBudget: budget,
    },
  );
}

/** Tactical Operations ejection: the pilot rolls a Piloting Skill Roll
 *  (Ejection Modifiers Table via `ejectionModifier`).
 *  A failure deals floor(margin of failure / 2) pilot hits with the usual
 *  consciousness rolls. Either way the pilot leaves the 'Mech (`removed =
 *  "pilotEjected"`, even if the failure damage reaches `pilotHitMax`; the sheet
 *  then shows HP 0). An intact frame stays as a hull in the posture it was
 *  left in; a frame the auto-eject fled (`destroyed` already set) leaves its
 *  destroyed remains. `pilotHits` is retained. */
function resolveEjection(
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

/** Pilot eject, resolved during the movement phase: the pilot leaves the
 *  'Mech after an ejection PSR (see `resolveEjection`), the unit leaves the
 *  battle (counted against victory) and its frame stays on the board as a
 *  hull (`isHull`). The emergency exit: available to any active unit,
 *  including shut-down and immobile ones. */
export function ejectPilot(state: BattleState, unitId: string, rng: Rng, sink: GameEvent[]): void {
  requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  // A voluntary exit is a window of its own: no one earns credit for it.
  state.currentDealt = { before: { damage: {}, crit: {} }, total: {}, byAttacker: {} };
  resolveEjection(state, unit, rng, sink, "manual");
}

/** Voluntary abandonment (house rule adapted from TO:AR p.165): a 'Mech
 *  that is shut down at its movement activation — so shut down in an earlier
 *  turn, an active 'Mech cannot abandon in a single turn — may have its pilot
 *  step out instead of any other action (restart included). No Piloting
 *  Skill Roll and no pilot hits; the unit becomes a hull at once, in the
 *  posture it stood in (`removed = "pilotAbandoned"`), and the pilot
 *  survives for campaign purposes. Marks the unit as having acted. */
export function abandonPilot(state: BattleState, unitId: string, sink: GameEvent[]): void {
  requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (!isShutdown(unit)) {
    throw new Error(
      `${unitId} must be shut down to abandon: shut down this turn, abandon the next`,
    );
  }
  if (isPilotUnconscious(unit)) throw new Error(`${unitId} is unconscious and cannot abandon`);
  if (state.actedThisPhase.includes(unitId)) throw new Error(`${unitId} already acted this phase`);
  // A voluntary exit is a window of its own: no one earns credit for it.
  state.currentDealt = { before: { damage: {}, crit: {} }, total: {}, byAttacker: {} };
  leaveHull(state, unit, "pilotAbandoned", sink);
  state.actedThisPhase.push(unitId);
}

/** Voluntary shutdown declaration, resolved during the movement phase: the
 *  unit goes off-line ("manual") immediately and stays down until a
 *  successful voluntary startup. Unlike an involuntary shutdown it forces no
 *  PSR (TW p.160). Marks the unit as having acted. */
export function voluntaryShutdown(state: BattleState, unitId: string, sink: GameEvent[]): void {
  requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (isShutdown(unit)) throw new Error(`${unitId} is already shut down`);
  unit.shutdown = "manual";
  state.actedThisPhase.push(unitId);
  sink.push({
    kind: "shutdownCheck",
    unitId,
    result: "manual",
    manual: true,
    roll: 0,
    heat: unit.heat,
    avoid: 0,
    threshold: 0,
  });
}

/** Voluntary startup attempt, resolved during the movement phase: roll 2D6
 *  against the shutdown avoidance number at the current heat. On success the
 *  unit comes online at once: the startup is its movement for the turn (it
 *  stands still) and it keeps the attack phase. On failure it remains shut
 *  down. Marks the unit as having acted either way. */
export function attemptVoluntaryStartup(
  state: BattleState,
  unitId: string,
  sink: GameEvent[],
  rng: Rng,
): void {
  requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (isNominal(unit)) throw new Error(`${unitId} is not shut down`);
  // A heat shutdown restarts only through the Heat Phase roll (TW p.160);
  // a movement-phase attempt would be a second roll in the same turn.
  if (unit.shutdown === "heat") {
    throw new Error(`${unitId} shut down from heat: the restart roll is made in the Heat Phase`);
  }
  const heat = unit.heat;
  const avoid = shutdownAvoid(heat);
  state.actedThisPhase.push(unitId);
  if (avoid > D2D6_MAX) {
    // No roll: heat 30+ blocks restart
    sink.push({
      kind: "restartCheck",
      unitId,
      result: "heat",
      manual: true,
      roll: 0,
      heat,
      avoid,
      threshold: 0,
    });
    return;
  }
  if (avoid > 0 && isPilotUnconscious(unit)) {
    // an unconscious pilot cannot attempt one.
    sink.push({
      kind: "restartCheck",
      unitId,
      result: "unconscious",
      manual: true,
      roll: 0,
      heat,
      avoid,
      threshold: 0,
    });
    return;
  }
  const roll = avoid === 0 ? 0 : roll2D6(rng);
  if (roll >= avoid) {
    unit.shutdown = "not";
    sink.push({
      kind: "restartCheck",
      unitId,
      result: "success",
      manual: true,
      roll,
      heat,
      avoid,
      threshold: 0,
    });
  } else {
    sink.push({
      kind: "restartCheck",
      unitId,
      result: "fail",
      manual: true,
      roll,
      heat,
      avoid,
      threshold: 0,
    });
  }
}

/** Movement-phase pass for a shut-down unit that attempts no startup: it
 *  stays off-line and is marked as having acted. */
export function passMovement(state: BattleState, unitId: string): void {
  requireCurrentActor(state, unitId, "movement");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (isNominal(unit)) throw new Error(`${unitId} is not shut down`);
  state.actedThisPhase.push(unitId);
}

/** Attack-phase pass for the current actor: it declares no weapons,
 *  physical attacks, or pickup this turn and is marked as having acted.
 *  Mirrors `passMovement` for the alternating attack declarations
 *  (TW pp.37-38). */
export function passAttack(state: BattleState, unitId: string): void {
  requireCurrentActor(state, unitId, "attack");
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) throw new Error(`${unitId} is removed from play`);
  if (
    unit.declaredWeaponAttacks.length > 0 ||
    unit.declaredPhysicalAttacks.length > 0 ||
    unit.declaredPickup !== null
  )
    throw new Error(`${unitId} already declared attacks this turn`);
  if (unit.passedAttacks) throw new Error(`${unitId} already passed attacks this turn`);
  unit.passedAttacks = true;
  state.actedThisPhase.push(unitId);
}

/** Outcome of one {@link gameLoop} invocation. */
export interface GameLoopResult {
  /** Next unit that must act, or null if no actor ready (victory or transient phase). */
  actorId: string | null;
  /** True iff game loop stopper decides to stop. */
  stopped: boolean;
}

export type GameLoopStopper = (state: BattleState) => boolean;

/**
 * Advance the battle through transient phases (initiative roll, attack
 * resolution, phase transitions) until an actor must act or the game ends.
 * Mutates `state` in place; pure engine rules only — no session/UI state.
 * Throws if the loop exceeds 200 iterations (debug-only safety net).
 * engine keeps simulating, not responsible for win or lose
 */
export function gameLoop(
  state: BattleState,
  rng: Rng,
  stopper: GameLoopStopper,
  sink: GameEvent[],
): GameLoopResult {
  for (let i = 0; i < 200; i++) {
    if (stopper(state)) {
      return { actorId: null, stopped: true };
    }
    if (state.phase === "initiative") {
      rollInitiativePhase(state, rng, sink);
      continue;
    }
    if (state.phase === "end") {
      advancePhase(state, sink, rng);
      continue;
    }
    const id = nextActor(state);
    if (id !== null) return { actorId: id, stopped: false };
    if (state.phase === "attack") {
      resolveAllAttacks(state, rng, sink);
    }
    advancePhase(state, sink, rng);
  }
  throw new Error("phase driver exceeded 200 iterations");
}

function* _battleLoopGen(state: BattleState, rng: Rng): Generator<GameEvent, boolean> {
  for (;;) {
    if (state.phase === "initiative") {
      yield* initiativePhaseGen(state, rng);
      continue;
    }
    if (state.phase === "end") {
      yield* advancePhaseGen(state, rng);
    }
  }
}

/** Suggest which unit must act next (initiative loser alternates first). */
export function nextActor(state: BattleState): string | null {
  if (state.phase !== "movement" && state.phase !== "attack") return null;
  if (state.initiativeWinnerTeam === null) return null;
  return pendingActors(state)[0] ?? null;
}

export interface ActorQueueActorView {
  readonly id: string;
  readonly team: number;
  readonly hasPriority: boolean;
}
export interface ActorQueueView {
  readonly initiative: number | null;
  readonly acted: ActorQueueActorView[];
  readonly pending: ActorQueueActorView[];
  readonly removed: ActorQueueActorView[];
}

function actorToQueueView(actor: UnitState, forcePriority?: boolean): ActorQueueActorView {
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
function pendingActors(state: BattleState): string[] {
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
 *  1/1, 1/1, 1/2, 1/2, 1/2). */
function buildActorQueue(state: BattleState): string[] {
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

  const nominal = alive.filter((u) => !downIds.has(u.id));
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
