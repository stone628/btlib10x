import { type AmmoDef, ensureAmmoRegistered, registerAmmo } from "./ammo.schema";
import { type MapDefSrc, registerMaps } from "./map.schema";
import { type MechDef, registerMechs } from "./mech.schema";
import { ensureWeaponsRegistered, registerWeapons, type WeaponDef } from "./weapon.schema";

/**
 * Raw catalog bundle shape for caller-supplied data (the shipped path is
 * the packed `data/btlib10x.jsonl` catalog via `loadCatalog`).
 * Mech validation links crit slots against the weapon/ammo catalogs, so
 * explicit overrides must load before mechs.
 */
export interface ShippedDataBundle {
  readonly weapons?: readonly WeaponDef[];
  readonly ammo?: readonly AmmoDef[];
  readonly mechs: readonly MechDef[];
  readonly maps: readonly MapDefSrc[];
}

/** Validate and load a raw catalog bundle into the lookup registries. */
export function loadShippedData(bundle: ShippedDataBundle): void {
  if (bundle.weapons !== undefined) registerWeapons(bundle.weapons);
  else ensureWeaponsRegistered();
  if (bundle.ammo !== undefined) registerAmmo(bundle.ammo);
  else ensureAmmoRegistered();
  registerMechs(bundle.mechs);
  registerMaps(bundle.maps);
}

export { AMMO_DATA } from "./ammo.data";
export type { AmmoDef } from "./ammo.schema";
export {
  type AmmoNameHolder,
  allAmmo as getAllAmmo,
  ammoDefFor,
  ensureAmmoRegistered,
  listAmmoWeapons,
} from "./ammo.schema";
export type {
  CatalogManifest,
  MapManifestEntry,
  MechManifestEntry,
} from "./catalog";
export {
  catalogManifest,
  decodeMapLine,
  decodeMechLine,
  ensureMapRegistered,
  ensureMechRegistered,
  findMapEntry,
  findMechEntry,
  loadCatalog,
  parseCatalogManifest,
  registerAllCatalog,
} from "./catalog";
export { encodeMapDef, MAP_WIRE_VERSION } from "./map.codec";
export type { MapDef } from "./map.schema";
export {
  allMapDefs,
  listMapNames,
  type MapNameHolder,
  mapDef,
  mapDefFor,
  registerMap,
  validateMapDef,
} from "./map.schema";
export { encodeMechDef, type MechIdentity, WIRE_VERSION } from "./mech.codec";
export type {
  CritSlot,
  CritSlots,
  CritSoakName,
  CritStructureName,
  MechDef,
  RearArmorKey,
  ResolvedArmor,
  ResolvedCritSlot,
  ResolvedCritSlots,
  ResolvedMechDef,
  WeaponMount,
} from "./mech.schema";
export {
  allMechDefs,
  CRIT_SLOT_COUNTS,
  CRIT_SOAK_NAMES,
  CRIT_STRUCTURE_NAMES,
  type MechModelHolder,
  mechDef,
  mechDefFor,
  registerMech,
  resolveMechDef,
  validateMechDef,
  type WeightClass,
  weightClassForTonnage,
} from "./mech.schema";
export { allTerrainDefs, terrainDef } from "./terrain.schema";
export type { WeaponDef } from "./weapon.schema";
export {
  ensureWeaponsRegistered,
  listWeaponNames,
  type WeaponNameHolder,
  weaponDefFor,
} from "./weapon.schema";
export { WEAPON_DATA } from "./weapons.data";
export { registerAmmo, registerMaps, registerMechs, registerWeapons };
