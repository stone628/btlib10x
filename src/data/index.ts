import { type MapDef, validateMapDef } from "./map.schema.js";
import beginnerMapJson from "./maps/beginner.json";
import quickstartMapJson from "./maps/quickstart.json";
import testMapJson from "./maps/test.json";
import type { ResolvedMechDef } from "./mech.schema.js";
import { MECH_DEFS } from "./mechCatalog.generated.js";

export interface MechModelHolder {
  readonly model: string;
}

export function getMechDefFor(h: MechModelHolder): ResolvedMechDef {
  const def = MECH_DEFS.get(h.model);
  if (!def) throw new Error(`Unknown mech: ${h.model}`);
  return def;
}

export function getMechDef(model: string): ResolvedMechDef | undefined {
  return MECH_DEFS.get(model);
}

export { type AmmoNameHolder, getAmmoDefFor } from "./ammo.schema.js";
export { getWeaponDefFor, type WeaponNameHolder } from "./weapon.schema.js";

export function getAllMechDefs(): ResolvedMechDef[] {
  return Array.from(MECH_DEFS.values());
}

/** All battle maps shipped with the library, keyed by name; validated at load. */
const MAP_DEFS: Readonly<Map<string, MapDef>> = new Map<string, MapDef>(
  [beginnerMapJson, quickstartMapJson, testMapJson].map((m) => {
    return [m.name, validateMapDef(m)];
  }),
);

export interface MapNameHolder {
  readonly mapName: string | null;
}

export function getMapDefFor(h: MapNameHolder): MapDef {
  const key = h.mapName;
  if (key == null) throw new Error("Unknown map: <none>");
  const def = MAP_DEFS.get(key);
  if (!def) throw new Error(`Unknown map: ${key}`);
  return def;
}

export function getMapDef(name: string): MapDef | undefined {
  return MAP_DEFS.get(name);
}

export function getAllMapDefs(): MapDef[] {
  return Array.from(MAP_DEFS.values());
}

export function listMapNames(): string[] {
  return Array.from(MAP_DEFS.keys());
}

export type { AmmoDef } from "./ammo.schema.js";
export { getAllAmmo, listAmmoWeapons } from "./ammo.schema.js";
export type { MapDef } from "./map.schema.js";
export { validateMapDef } from "./map.schema.js";
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
} from "./mech.schema.js";
export {
  CRIT_SLOT_COUNTS,
  CRIT_SOAK_NAMES,
  CRIT_STRUCTURE_NAMES,
  resolveMechDef,
  validateMechDef,
} from "./mech.schema.js";
export type { TerrainDef } from "./terrain.schema.js";
export { getAllTerrainDefs, getTerrainDef } from "./terrain.schema.js";
export type { WeaponDef } from "./weapon.schema.js";
export { listWeaponNames } from "./weapon.schema.js";
