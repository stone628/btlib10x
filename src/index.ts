export { roll2D6, rollD6 } from "./core/dice.js";
export {
  bearing,
  hexDistance,
  isAdjacent,
  lineHexes,
  neighbor,
  neighbors,
  sameHex,
} from "./core/hex.js";
export * from "./core/locations.js";
export type { HexGrid } from "./core/terrain.js";
export {
  cellAt,
  costToClimb,
  costToEnter,
  MP_PER_FACING_CHANGE,
  MP_PER_LEVEL_CLIMB,
  MP_TO_ENTER_HEX,
  terrainMoveCost,
  woodsPoints,
} from "./core/terrain.js";
export * from "./core/types.js";
export type { AmmoDef } from "./data/ammo.schema.js";
export {
  type AmmoNameHolder,
  getAllAmmo,
  getAmmoDef,
  getAmmoDefFor,
  getShotsPerBinFor,
} from "./data/ammo.schema.js";
export type {
  CritSlot,
  CritSlots,
  CritSoakName,
  CritStructureName,
  MapDef,
  MapNameHolder,
  MechDef,
  MechModelHolder,
  RearArmorKey,
  ResolvedArmor,
  ResolvedCritSlot,
  ResolvedCritSlots,
  ResolvedMechDef,
  WeaponMount,
} from "./data/index.js";
export {
  CRIT_SLOT_COUNTS,
  CRIT_STRUCTURE_NAMES,
  getAllMapDefs,
  getAllMechDefs,
  getMapDef,
  getMapDefFor,
  getMechDef,
  getMechDefFor,
  listMapNames,
  resolveMechDef,
  validateMapDef,
  validateMechDef,
} from "./data/index.js";
export type { WeaponCategory, WeaponDef, WeaponNameHolder } from "./data/weapon.schema.js";
export { getAllWeaponDefs, getWeaponDefFor, listWeaponNames } from "./data/weapon.schema.js";
export * from "./rules/ammo.js";
export * from "./rules/arcs.js";
export type { AttackResolution, HitGroup, WeaponAttackInput } from "./rules/attack.js";
export { resolveWeaponAttack } from "./rules/attack.js";
export * from "./rules/cluster.js";
export type {
  CriticalEffect,
  CriticalResolution,
  CritSource,
  EffectiveMovement,
} from "./rules/critical.js";
export { effectiveMovement, resolveCriticalHits } from "./rules/critical.js";
export * from "./rules/damage.js";
export * from "./rules/fireability.js";
export * from "./rules/game.js";
export * from "./rules/hitlocation.js";
export * from "./rules/initiative.js";
export * from "./rules/internalStructure.js";
export * from "./rules/los.js";
export * from "./rules/movement.js";
export * from "./rules/tohit.js";
export { VERSION } from "./version.js";
