import { MAP_DEFS, type MapDef } from "./map.schema";
import type { ResolvedMechDef } from "./mech.schema";
import { MECH_DEFS } from "./mechCatalog.generated";

export interface MechModelHolder {
  readonly model: string;
}

export function mechDefFor(h: MechModelHolder): ResolvedMechDef {
  const def = MECH_DEFS.get(h.model);
  if (!def) throw new Error(`Unknown mech: ${h.model}`);
  return def;
}

export function mechDef(model: string): ResolvedMechDef | undefined {
  return MECH_DEFS.get(model);
}

export { type AmmoNameHolder, ammoDefFor } from "./ammo.schema";
export { type WeaponNameHolder, weaponDefFor } from "./weapon.schema";

export function allMechDefs(): ResolvedMechDef[] {
  return Array.from(MECH_DEFS.values());
}

export interface MapNameHolder {
  readonly mapName: string | null;
}

export function mapDefFor(h: MapNameHolder): MapDef {
  const key = h.mapName;
  if (key === null) throw new Error("Unknown map: <none>");
  const def = MAP_DEFS.get(key);
  if (!def) throw new Error(`Unknown map: ${key}`);
  return def;
}

export function mapDef(name: string): MapDef | undefined {
  return MAP_DEFS.get(name);
}

export function allMapDefs(): MapDef[] {
  return Array.from(MAP_DEFS.values());
}

export function listMapNames(): string[] {
  return Array.from(MAP_DEFS.keys());
}

export type { AmmoDef } from "./ammo.schema";
export { allAmmo as getAllAmmo, listAmmoWeapons } from "./ammo.schema";
export type { MapDef } from "./map.schema";
export { validateMapDef } from "./map.schema";
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
  CRIT_SLOT_COUNTS,
  CRIT_SOAK_NAMES,
  CRIT_STRUCTURE_NAMES,
  resolveMechDef,
  validateMechDef,
} from "./mech.schema";
export type { TerrainDef } from "./terrain.schema";
export { allTerrainDefs, terrainDef } from "./terrain.schema";
export type { WeaponDef } from "./weapon.schema";
export { listWeaponNames } from "./weapon.schema";
