import type { HexGrid } from "../../core/terrain";
import type {
  ArmLocation,
  BuildingTerrainType,
  Facing,
  HexCoord,
  LimbLocation,
  Location,
  MoveMode,
  Rng,
  TerrainHexDef,
} from "../../core/types";
import type { MechModelHolder } from "../../data/index";
import type { ResolvedMechDef } from "../../data/mech.schema";
import type { AmmoBins, AmmoPolicy } from "../ammo";
import type { AmsAttack, AmsPolicy } from "../ams";
import type { Arc, SecondaryTargetMod, Twist } from "../arcs";
import type { AttackResolution, MissileDefenseUse } from "../attack";
import type { BuildingState } from "../building";
import type { CriticalResolution, CritMask } from "../critical";
import type { UnitDamageState } from "../damage";
import type { UnitInitDamage } from "../initialDamage";
import type {
  DamageGroup,
  PhysicalAttackDecl,
  PhysicalAttackType,
  PhysicalResolution,
  PhysicalWeaponName,
} from "../physical";
import type { RangeBracket } from "../tohit";
import type { TEAM_IDS } from "./constants";

export type UnitSkillRange = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Per-unit behavior settings, chosen at setup and changeable by the acting
 *  unit during the movement and attack phases ({@link setUnitPolicy}). */
export interface UnitPolicy {
  /** Which ammo bin a shot is drawn from (see `src/rules/ammo.ts`). */
  ammoPolicy: AmmoPolicy;
  /** Auto-eject system engaged (TO:AR p. 165; players may disable it per
   *  'Mech before the battle, and here also switch it at the unit's own
   *  movement or attack activation). On: losing the head, or a center torso
   *  to an ammo/weapon blast, ejects the pilot. Off: those kill the
   *  MechWarrior (TW p. 128). */
  autoEject: boolean;
  /** Flamer-family (`asHeat`) weapons apply their Damage Value as heat
   *  instead of damage (TW p.303 footnote ‡). On: every flamer hit heats the
   *  target; off: flamers deal normal damage. */
  heatFlamer: boolean;
  /** Which hitting missile attack the unit's AMS / Laser AMS engage (TW
   *  p.129; see `src/rules/ams.ts`): `expected` (default), `firstHit`,
   *  `priority` or `off`. */
  amsPolicy: AmsPolicy;
}

/** Legal team id. */
export type TeamId = (typeof TEAM_IDS)[number];

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
  /** Torso twist the volley was declared with (TW pp.105-106); recorded so
   *  the unit's own AMS cover the twisted arcs this phase. Absent: untwisted. */
  readonly twist?: Twist;
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
  | "ejection"
  /** Kill-time raises ({@link raisePilotHits}): head lost (to one short of
   *  death on auto-eject, TO:AR p.165, else death, TW p.128), cockpit
   *  destroyed (TW p.125), CT lost to a blast without auto-eject (TW p.128). */
  | "headLoss"
  | "cockpitHit"
  | "ctBlast";

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
  /** AMS engagement choice (from `UnitPolicy.amsPolicy`). */
  amsPolicy: AmsPolicy;
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
       *  in the hex as a token (`returned` is always `true`). `cause` marks
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
      /** The unit's AMS / Laser AMS engaged a missile attack that hit it (TW
       *  p.129), pushed right after that attack's `attackResolved`. `heat`
       *  joins the unit's own heat this turn (`totalGenerated` = its
       *  `heatPending` after this event). */
      readonly kind: "amsEngaged";
      readonly unitId: string;
      /** Weapon index and name of the engaging AMS on `unitId`. */
      readonly weaponIndex: number;
      readonly weapon: string;
      readonly attackerId: string;
      readonly attackWeapon: string;
      /** Missiles that would have hit, and that hit after the AMS. */
      readonly hitsWithout: number;
      readonly hitsWith: number;
      readonly heat: number;
      readonly base: number;
      readonly totalGenerated: number;
      /** AMS ammo left in the unit's pool after the shot; null for a Laser AMS. */
      readonly shotsLeft: number | null;
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
      /** One event per damage source (one `applyPilotHits` call). Kill-time
       *  raises (head loss, cockpit hit, CT blast) are evented too, with
       *  reasons "headLoss" / "cockpitHit" / "ctBlast" and no
       *  consciousness roll (the pilot dies, or the ejection roll decides). */
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

export interface UnitAttackResolution {
  readonly targetId: string;
  readonly secondaryMod: 0 | SecondaryTargetMod;
  readonly resolution: AttackResolution;
  readonly weaponHeat: number;
  readonly buildingDamage: number;
  /** Leg hits that struck a building serving as partial cover (TW p.102). */
  readonly coverBuilding?: { readonly hex: HexCoord; readonly damage: number };
  /** The target's AMS engaged this attack (emitted as `amsEngaged`). */
  readonly ams?: AmsEngagement;
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

export type PickupChoice =
  | { ok: true; source: ClubKind; token?: ClubGroundToken }
  | { ok: false; reason: string };

export interface ExecuteMoveOptions {
  /** Landing facing of a jump (TW p.53), or the free facing of a stand-up
   *  that enters no hex (TW p.50); any other move refuses it. When omitted,
   *  the unit keeps the facing its steps leave it in. */
  readonly finalFacing?: Facing;
  /** Per-call random source. */
  readonly rng: Rng;
}

/** Posture change that can open an activation (TW pp.49-50). */
export type PostureChange = "standUp" | "drop";

/** MP a posture change already took from the activation's one pool. */
export interface PosturePool {
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

export interface DeclareAttacksOptions {
  /** Torso twist (TW pp.105-106): shifts the attacker's effective facing by one
   *  hexside before classifying the firing arc. Defaults to untwisted. */
  readonly twist?: Twist;
  /** Drop the held club first: hands are free for the rest of this
   *  declaration, so arm-mounted weapons, punch, and strike validate
   *  normally. The club (limb, tree or girder) stays intact in the hex as
   *  a token, and a later pickup takes it back without a roll.
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

/** Running per-unit {@link CritState} while a volley resolves: every weapon
 *  sees the damage and criticals of the weapons resolved before it (TW p.125:
 *  crits are rolled "before resolving any further weapons fire"). It is also
 *  the unit's one ammo ledger for the phase: its own Streak spending and the
 *  crits it takes both act on `ammoBins` here. The unit's own volley never
 *  reads it (see `resolveUnitAttacks`): only the unit's targets do. */
export interface RunningState {
  damage: UnitDamageState;
  critSlotsDestroyed: CritMask;
  ammoBins: AmmoBins;
}

/** A defender's AMS for the phase and the missile attacks declared at it. */
export interface DefenderAms {
  /** Weapon indices of the AMS able to engage this phase. */
  readonly mounts: readonly number[];
  /** AMS already used this turn (one attack each, TW p.129). */
  readonly used: Set<number>;
  /** Declared missile attacks at the unit that some AMS covers, in
   *  resolution order. */
  readonly attacks: AmsAttack[];
}

/** An engagement made in resolution pass 1, emitted in pass 2. */
export interface AmsEngagement {
  readonly defenderId: string;
  readonly use: MissileDefenseUse;
  readonly heat: number;
  readonly shotsLeft: number | null;
}

/** State shared by every unit's volley in one `resolveAllAttacks`. */
export interface AttackPhaseContext {
  readonly running: Record<string, RunningState>;
  readonly phaseStartCf: Record<string, number>;
  /** Phase-start ammo views (see `ownStateFor`). */
  readonly own: Record<string, RunningState>;
  /** AMS defenders by unit id; absent for units with no working AMS. */
  readonly ams: Record<string, DefenderAms>;
  /** Resolution-order key of the next weapon declaration. */
  nextKey: number;
}

/** Per-unit to-hit context of a volley, fixed for the whole phase. */
export interface VolleyContext {
  readonly def: ResolvedMechDef;
  readonly preHeat: number;
  readonly sensorMod: number;
  readonly pronePropArm: ArmLocation | null;
}

/** Damage points taken per unit since a phase snapshot (TW p.60 20-point
 *  trigger), keyed by unit id. Sums of circles actually marked
 *  (`dealtOf` / `critDamageDealt`); step-5 wipes (TW p.122), vented CASE
 *  damage and unspent overkill never become steps, so they are excluded —
 *  unlike the `damageTaken` before/after diff, which counts wiped armor. */
export type PhaseDealt = Record<string, number>;

export interface NewStructureHit {
  readonly location: Location;
  readonly name: string;
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

export interface PhaseSnapshots {
  readonly damage: Record<string, UnitDamageState>;
  readonly crit: Record<string, CritMask>;
}

/** Outcome of one {@link gameLoop} invocation. */
export interface GameLoopResult {
  /** Next unit that must act, or null if no actor ready (victory or transient phase). */
  actorId: string | null;
  /** True iff game loop stopper decides to stop. */
  stopped: boolean;
}

export type GameLoopStopper = (state: BattleState) => boolean;

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
