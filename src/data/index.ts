import { type AmmoDef, registerAmmo } from "./ammo.schema";
import { type MapDefSrc, registerMaps } from "./map.schema";
import { type MechDef, registerMechs } from "./mech.schema";
import { registerWeapons, type WeaponDef } from "./weapon.schema";

/**
 * Raw catalog bundle shape served by the `btlib10x/data` entry point
 * (`data/index.ts`). The engine validates and loads it via
 * `loadShippedData`; weapons and ammo must load before mechs because mech
 * validation links crit slots against those catalogs.
 */
export interface ShippedDataBundle {
  readonly weapons: readonly WeaponDef[];
  readonly ammo: readonly AmmoDef[];
  readonly mechs: readonly MechDef[];
  readonly maps: readonly MapDefSrc[];
}

/** Validate and load a raw catalog bundle into the lookup registries. */
export function loadShippedData(bundle: ShippedDataBundle): void {
  registerWeapons(bundle.weapons);
  registerAmmo(bundle.ammo);
  registerMechs(bundle.mechs);
  registerMaps(bundle.maps);
}

export type { AmmoDef } from "./ammo.schema";
export {
  type AmmoNameHolder,
  allAmmo as getAllAmmo,
  ammoDefFor,
  listAmmoWeapons,
} from "./ammo.schema";
export type { MapDef } from "./map.schema";
export {
  allMapDefs,
  listMapNames,
  type MapNameHolder,
  mapDef,
  mapDefFor,
  validateMapDef,
} from "./map.schema";
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
  resolveMechDef,
  validateMechDef,
} from "./mech.schema";
export type { TerrainDef } from "./terrain.schema";
export { allTerrainDefs, terrainDef } from "./terrain.schema";
export type { WeaponDef } from "./weapon.schema";
export { listWeaponNames, type WeaponNameHolder, weaponDefFor } from "./weapon.schema";
export { registerAmmo, registerMaps, registerMechs, registerWeapons };
