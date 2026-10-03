import { registerMaps } from "./map.schema";
import { registerMechs } from "./mech.schema";

export { AMMO_DATA } from "./ammo.data";
export type { AmmoDef } from "./ammo.schema";
export {
  type AmmoNameHolder,
  ammoDefFor,
  listAmmoWeapons,
} from "./ammo.schema";
export type {
  CatalogManifest,
  CatalogStringTable,
  MapManifestEntry,
  MechManifestEntry,
} from "./catalog";
export {
  catalogMaps,
  catalogMechs,
  ensureMapRegistered,
  ensureMechRegistered,
  loadCatalog,
} from "./catalog";
export { encodeMapDef, MAP_WIRE_VERSION } from "./map.codec";
export type { MapDef } from "./map.schema";
export {
  listMapNames,
  type MapNameHolder,
  mapDef,
  mapDefFor,
  registeredMapDefs,
  registerMap,
  validateMapDef,
} from "./map.schema";
export {
  encodeMechDef,
  internString,
  type MechIdentity,
  type MechStringTable,
  resolveStringRef,
  WIRE_VERSION,
} from "./mech.codec";
export type {
  CritSlot,
  CritSlots,
  CritSoakName,
  CritStructureName,
  MechDef,
  MyomerType,
  RearArmorKey,
  ResolvedArmor,
  ResolvedCritSlot,
  ResolvedCritSlots,
  ResolvedMechDef,
  WeaponMount,
} from "./mech.schema";
export {
  CRIT_SLOT_COUNTS,
  CRIT_SOAK_NAMES,
  CRIT_STRUCTURE_NAMES,
  type MechModelHolder,
  mechDef,
  mechDefFor,
  registeredMechDefs,
  registerMech,
  resolveMechDef,
  validateMechDef,
  type WeightClass,
  weightClassForTonnage,
} from "./mech.schema";
export { allTerrainDefs, terrainDef } from "./terrain.schema";
export type { WeaponDef } from "./weapon.schema";
export {
  listWeaponNames,
  type WeaponNameHolder,
  weaponDefFor,
} from "./weapon.schema";
export { WEAPON_DATA } from "./weapons.data";
export { registerMaps, registerMechs };
