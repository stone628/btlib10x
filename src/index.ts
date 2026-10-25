export { D2D6_IMPOSSIBLE, D2D6_MAX, roll2D6, rollD6 } from "./core/dice";
export {
  type Bearing,
  bearingExact,
  hexDistance,
  isAdjacent,
  neighbor,
  sameHex,
} from "./core/hex";
export type { HexGrid } from "./core/terrain";
export {
  cellAt,
  hexCell,
  hexEntryCost,
  MP_PER_FACING_CHANGE,
  WRECKAGE_MOVE_COST,
  waterDepth,
} from "./core/terrain";
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
} from "./core/types";
export {
  FACINGS,
  hexKey,
  isArm,
  isLimb,
  isTorso,
  msgHex,
  oppositeFacing,
  rotateFacing,
  shoulderOf,
} from "./core/types";
export type { AmmoDef } from "./data/ammo.schema";
export {
  AMMO_DATA,
  type AmmoNameHolder,
  appendCatalog,
  type CatalogManifest,
  CRIT_SLOT_COUNTS,
  CRIT_SOAK_NAMES,
  CRIT_STRUCTURE_NAMES,
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
export type { MapClubSrc, MapDef, MapDefSrc, MapWreckageSrc } from "./data/map.schema";
export type {
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
export { type TerrainDef, terrainDef } from "./data/terrain.schema";
export type {
  WeaponAntiMissile,
  WeaponCategory,
  WeaponDef,
  WeaponHeatEffect,
  WeaponNameHolder,
} from "./data/weapon.schema";
export {
  allWeaponDefs,
  isFireableWeapon,
  listWeaponNames,
  weaponDefFor,
} from "./data/weapon.schema";
export type { ArmActuatorCounts } from "./rules/actuators";
export {
  AMMO_POLICIES,
  type AmmoBins,
  type AmmoPolicy,
  ammoBinId,
  collectAmmoBins,
  designTotalsByWeaponName,
  isBinUsable,
  loadAmmoBins,
  pooledTotalsByWeaponName,
  strandedShots,
  usableShots,
} from "./rules/ammo";
export {
  AMS_CLUSTER_MOD,
  AMS_POLICIES,
  AMS_STREAK_ROLL,
  type AmsPolicy,
  amsExpectedSaving,
  amsPriority,
  isAmsEngageable,
  isAmsPolicy,
} from "./rules/ams";
export type { SecondaryTargetMod } from "./rules/arcs";
export {
  type Arc,
  classifyArcWithBoundary,
  classifyFiringArc,
  mountArcLocation,
  mountCanFireIntoArc,
  type Twist,
  weaponCanFireIntoArc,
} from "./rules/arcs";
export type {
  AttackResolution,
  HitGroup,
  InflictedHeat,
  MissileDefenseResult,
  MissileDefenseUse,
  TargetCritContext,
  WeaponAttackInput,
} from "./rules/attack";
export { CLUSTER_COLUMNS, CLUSTER_TABLE, expectedClusterHits } from "./rules/cluster";
export type {
  CaseKind,
  ComponentHitStatus,
  CriticalEffect,
  CriticalResolution,
  CritSource,
  EffectiveMovement,
} from "./rules/critical";
export {
  type CritMask,
  type CritState,
  cloneCritTable,
  componentHitStatus,
  countDestroyedEngine,
  critSeveredLimbs,
  crittedWeapons,
  destroyedSlots,
  ENGINE_SLOTS_KILL,
  effectiveMovement,
  emptyCritTable,
  isSlotDestroyed,
  isWeaponCritted,
  setSlotDestroyed,
  TSM_WALK_BONUS,
} from "./rules/critical";
export {
  canAttemptStandUp,
  canFireFromLocation,
  canFireMount,
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
  fireTargetScore,
  hitProbability,
  suggestFireTargets,
} from "./rules/fireability";
export {
  clubTokensInHex,
  declarePickup,
  pickupSourceInHex,
  salvageableSeveredLimbs,
  validatePickup,
} from "./rules/game/clubs";
export { isImmobile } from "./rules/game/condition";
export {
  DEFAULT_UNIT_POLICY,
  DROP_MP_COST,
  GIRDER_SEARCH_TARGET,
  STAND_MP_COST,
  TEAM_IDS,
  WRECKAGE_TONNAGE_MIN,
} from "./rules/game/constants";
export { buildUnitInit, createBattle } from "./rules/game/create";
export { declareAttacks, passAttack, validateAttacks } from "./rules/game/declare";
export { facingToward } from "./rules/game/geometry";
export { gameLoop } from "./rules/game/loop";
export { meleeDeclarationProblem } from "./rules/game/melee";
export { executeMove, executePostureMove, passMovement } from "./rules/game/move";
export {
  abandonPilot,
  attemptVoluntaryStartup,
  ejectPilot,
  voluntaryShutdown,
} from "./rules/game/pilotActions";
export {
  canUnitStandUp,
  dropProne,
  postureCost,
  postureMoveBudget,
  standUpCost,
} from "./rules/game/posture";
export {
  hasWreckage,
  isHull,
  isNominal,
  isShutdown,
  isTargetableBy,
  isUnitAvailable,
  isUnitOnBoard,
  isUnitRemoved,
  isValidTeam,
  occupantAt,
  occupantTeamAt,
  requireUnit,
  wreckageAt,
} from "./rules/game/queries";
export { actorQueue, setUnitPolicy, unitPolicyOf } from "./rules/game/turnOrder";
export type {
  ActorQueueActorView,
  AttackPhaseStage,
  BattleState,
  ClubGroundToken,
  ClubKind,
  ClubPickupDecl,
  ConsciousnessRoll,
  CreateBattleOptions,
  DeclaredPhysicalAttack,
  DeclaredPickup,
  DeclaredWeaponVolley,
  DestroyedReason,
  DestroyedState,
  ExecuteMoveOptions,
  GameEvent,
  GameLoopResult,
  GameLoopStopper,
  HeldClub,
  MeleeCharge,
  MoveStep,
  Phase,
  PilotHitReason,
  PilotingCheckReason,
  PostureChange,
  RemovalReason,
  RemovedState,
  SeveredLimb,
  ShutdownState,
  TeamId,
  UnitFallCause,
  UnitInit,
  UnitPolicy,
  UnitSkillRange,
  UnitState,
  ValidatedTargetVolley,
  WeaponAttackDecl as AttackDecl,
  WreckageEntry,
} from "./rules/game/types";
export {
  AMMO_EXPLOSION_START_HEAT,
  ammoExplosionAvoid,
  ammoExplosionAvoidWithThreshold,
  effectiveMoveBudget,
  HEAT_SCALE_MAX,
  type HeatScaleEffects,
  heatDissipation,
  heatDissipationMax,
  heatScaleEffects,
  isTsmActive,
  type LargestAmmoBin,
  movementHeat,
  movementMpPenalty,
  movementMpPenaltyWithThreshold,
  OUTSIDE_HEAT_CAP,
  outsideHeatApplied,
  shutdownAvoid,
  TSM_ACTIVATION_HEAT,
  toHitHeatModifier,
  toHitHeatModifierWithThreshold,
} from "./rules/heat";
export { HIT_LOCATION_TABLE, LEFT_SIDE_TABLE, RIGHT_SIDE_TABLE } from "./rules/hitlocation";
export type { UnitInitDamage } from "./rules/initialDamage";
export type { InitiativeResult } from "./rules/initiative";
export { internalStructureForTonnage } from "./rules/internalStructure";
export { losClear } from "./rules/los";
export {
  attackerMovementModifier,
  type MoveFragment,
  type MovePathStep,
  pathMp,
  type ReachabilityOptions,
  type RevealedLanding,
  reachableLandings,
  targetMovementModifier,
} from "./rules/movement";
export {
  computePhysicalToHit,
  type DamageGroup,
  DFA_MISS_LEVELS_FALLEN,
  damageGroupsTotal,
  isMeleeCharge,
  isPhysicalWeaponName,
  meleeRecoilDamage,
  PHYSICAL_WEAPONS,
  type PhysicalAttackDecl,
  type PhysicalAttackType,
  type PhysicalModifiers,
  type PhysicalResolution,
  type PhysicalWeaponName,
  type PhysicalWeaponStats,
  physicalDamage,
  physicalToHitTotal,
  resolveStrikeArm,
  resolveStrikeMount,
  type StrikeMountResolution,
  strikeMountArms,
  strikeMounts,
  strikeWeaponInArm,
  validatePhysicalAttack,
} from "./rules/physical";
export {
  isPilotUnconscious,
  type PilotRecord,
  type PilotStatus,
  pilotRecord,
  pilotStatus,
} from "./rules/pilot";
export {
  consciousnessTarget,
  DEFAULT_PILOT_HIT_MAX,
  DEFAULT_PILOTING,
  EJECTION_BASE_MODIFIER,
  type EjectionModifierInput,
  ejectionDamage,
  ejectionModifier,
  type FallDirection,
  fallingDamageTotal,
  GYRO_DESTROYED_HITS,
  GYRO_HIT_MOD,
  isValidPilotHitMax,
  type PilotingRollResult,
  type PreexistingDamage,
  SENSOR_BLIND_HITS,
} from "./rules/piloting";
export {
  type SalvageAmmo,
  type SalvageEntry,
  type SalvageEquipmentName,
  type SalvageItem,
  type SalvageKind,
  type SalvageSlot,
  salvageReport,
} from "./rules/salvage";
export {
  BV_SKILL_MULTIPLIER,
  bvSkillMultiplier,
  type CrippleReason,
  crippleReasons,
  damagedFraction,
  SCORE_CRIPPLED_LOST,
  SCORE_ENEMY_WEIGHT,
  SCORE_OWN_WEIGHT,
  scoreReport,
  type TeamScore,
  type UnitScore,
  unitScore,
} from "./rules/score";
export { loadBattleState, parseBattleState, saveBattleState } from "./rules/snapshot";
export {
  type AttackModifiers,
  DEFAULT_GUNNERY,
  damageForBracket,
  type RangeBracket,
  type ToHitBreakdown,
  toHitTotal,
} from "./rules/tohit";
export { VERSION } from "./version";
