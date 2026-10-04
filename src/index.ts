export { D2D6_MAX, roll2D6, rollD6 } from "./core/dice";
export {
  type Bearing,
  bearingExact,
  hexDistance,
  isAdjacent,
  neighbor,
  sameHex,
} from "./core/hex";
export type { HexGrid } from "./core/terrain";
export { cellAt, MP_PER_FACING_CHANGE } from "./core/terrain";
export type {
  ArmLocation,
  Facing,
  HexCell,
  HexCoord,
  LegLocation,
  Location,
  MoveMode,
  Rng,
  TerrainHexDef,
  TerrainType,
  TorsoLocation,
  WreckState,
} from "./core/types";
export {
  FACINGS,
  isArm,
  isLimb,
  isTorso,
  oppositeFacing,
  rotateFacing,
  shoulderOf,
} from "./core/types";
export type { AmmoDef } from "./data/ammo.schema";
export {
  AMMO_DATA,
  type AmmoNameHolder,
  type CatalogManifest,
  catalogMaps,
  catalogMechs,
  ensureMapRegistered,
  ensureMechRegistered,
  listMapNames,
  loadCatalog,
  MAP_WIRE_VERSION,
  type MapManifestEntry,
  type MapNameHolder,
  type MechIdentity,
  type MechManifestEntry,
  type MechModelHolder,
  mapDefFor,
  mechDef,
  mechDefFor,
  registeredMapDefs,
  registeredMechDefs,
  registerMap,
  registerMaps,
  registerMech,
  registerMechs,
  WEAPON_DATA,
  WIRE_VERSION,
  weightClassForTonnage,
} from "./data/index";
export type { MapDef, MapDefSrc } from "./data/map.schema";
export type {
  CRIT_SLOT_COUNTS,
  CRIT_SOAK_NAMES,
  CRIT_STRUCTURE_NAMES,
  CritSlot,
  CritSlots,
  CritSoakName,
  CritStructureName,
  HeatSinkConfig,
  MechDef,
  MyomerType,
  RearArmorKey,
  ResolvedArmor,
  ResolvedCritSlot,
  ResolvedCritSlots,
  ResolvedMechDef,
  ResolvedRearArmor,
  WeaponMount,
  WeightClass,
} from "./data/mech.schema";
export type { TerrainDef } from "./data/terrain.schema";
export type { WeaponCategory, WeaponDef, WeaponNameHolder } from "./data/weapon.schema";
export { allWeaponDefs, listWeaponNames, weaponDefFor } from "./data/weapon.schema";
export type { ArmActuatorCounts } from "./rules/actuators";
export {
  AMMO_POLICIES,
  type AmmoBins,
  type AmmoPolicy,
  ammoBinId,
  collectAmmoBins,
  loadAmmoBins,
  pooledTotalsByWeaponName,
} from "./rules/ammo";
export {
  type Arc,
  classifyArcWithBoundary,
  classifyFiringArc,
  weaponCanFireIntoArc,
} from "./rules/arcs";
export type { AttackResolution, HitGroup, WeaponAttackInput } from "./rules/attack";
export { CLUSTER_COLUMNS, CLUSTER_TABLE } from "./rules/cluster";
export type {
  CaseKind,
  ComponentHitStatus,
  CriticalEffect,
  CriticalResolution,
  CritSource,
  EffectiveMovement,
} from "./rules/critical";
export {
  componentHitStatus,
  countDestroyedEngine,
  ENGINE_SLOTS_KILL,
  effectiveMovement,
  TSM_WALK_BONUS,
} from "./rules/critical";
export {
  canAttemptStandUp,
  canFireFromLocation,
  type DamageApplication,
  type DamageOptions,
  type DamageTransferStep,
  destroyedArms,
  destroyedLegs,
  isUnitDestroyed,
  isUnitImmobile,
  type LocationValue,
  type TorsoLocationValue,
  type UnitDamageState,
} from "./rules/damage";
export {
  bestFireTarget,
  type FireBlocked,
  type FireBlockerReason,
  type FireSuggestion,
  type FireTarget,
  type FireWeapon,
  suggestFireTargets,
} from "./rules/fireability";
export type {
  ActorQueueActorView,
  BattleState,
  ClubGroundToken,
  ClubKind,
  ClubPickupDecl,
  CreateBattleOptions,
  DeclaredPhysicalAttack,
  DeclaredWeaponVolley,
  DestroyedReason,
  DestroyedState,
  GameEvent,
  GameLoopResult,
  GameLoopStopper,
  HeldClub,
  MoveStep,
  Phase,
  PilotHitReason,
  PilotingCheckReason,
  RemovalReason,
  RemovedState,
  ShutdownState,
  UnitFallCause,
  UnitInit,
  UnitSkillRange,
  UnitState,
  WeaponAttackDecl as AttackDecl,
} from "./rules/game";
export {
  actorQueue,
  attemptStandUp,
  attemptVoluntaryStartup,
  createBattle,
  DROP_MP_COST,
  declareAttacks,
  declarePickup,
  dropProne,
  ejectPilot,
  executeMove,
  GIRDER_SEARCH_TARGET,
  gameLoop,
  isImmobile,
  isNominal,
  isShutdown,
  isUnitAvailable,
  isUnitRemoved,
  passMovement,
  pickupSourceInHex,
  requireUnit,
  STAND_MP_COST,
  validateAttacks,
  validatePickup,
  voluntaryShutdown,
  wreckAt,
} from "./rules/game";
export {
  AMMO_EXPLOSION_START_HEAT,
  ammoExplosionAvoid,
  ammoExplosionAvoidWithThreshold,
  effectiveMoveBudget,
  HEAT_CAP,
  type HeatScaleEffects,
  heatDissipation,
  heatDissipationMax,
  heatScaleEffects,
  isTsmActive,
  type LargestAmmoBin,
  movementMpPenalty,
  movementMpPenaltyWithThreshold,
  shutdownAvoid,
  TSM_ACTIVATION_HEAT,
  toHitHeatModifier,
  toHitHeatModifierWithThreshold,
} from "./rules/heat";
export { HIT_LOCATION_TABLE, LEFT_SIDE_TABLE, RIGHT_SIDE_TABLE } from "./rules/hitlocation";
export type { InitiativeResult } from "./rules/initiative";
export { internalStructureForTonnage } from "./rules/internalStructure";
export {
  type MoveFragment,
  type MovePathStep,
  type ReachabilityOptions,
  type RevealedLanding,
  reachableLandings,
} from "./rules/movement";
export {
  type DamageGroup,
  isPhysicalWeaponName,
  PHYSICAL_WEAPONS,
  type PhysicalAttackDecl,
  type PhysicalAttackType,
  type PhysicalModifiers,
  type PhysicalResolution,
  type PhysicalWeaponName,
  type PhysicalWeaponStats,
  resolveStrikeArm,
  resolveStrikeMount,
  type StrikeMountResolution,
  strikeMountArms,
  strikeMounts,
  strikeWeaponInArm,
  validatePhysicalAttack,
} from "./rules/physical";
export {
  consciousnessTarget,
  DEFAULT_PILOTING,
  type FallDirection,
  GYRO_DESTROYED_HITS,
  GYRO_HIT_MOD,
  type PreexistingDamage,
  SENSOR_BLIND_HITS,
} from "./rules/piloting";
export { loadBattleState, parseBattleState, saveBattleState } from "./rules/snapshot";
export {
  type AttackModifiers,
  DEFAULT_GUNNERY,
  type RangeBracket,
  type ToHitBreakdown,
} from "./rules/tohit";
export { VERSION } from "./version";
