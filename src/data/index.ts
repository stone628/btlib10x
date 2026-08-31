import beginnerMapJson from "./maps/beginner.json";
import quickstartMapJson from "./maps/quickstart.json";
import testMapJson from "./maps/test.json";
import { type MapDef, validateMapDef } from "./mapschema.js";
import { MECH_DEFS } from "./mechCatalog.generated.js";
import type { ResolvedMechDef } from "./schema.js";

export function getMechDef(model: string): ResolvedMechDef | undefined {
  return MECH_DEFS.get(model.toUpperCase());
}

export function getAllMechDefs(): ResolvedMechDef[] {
  return Array.from(MECH_DEFS.values());
}

/** All battle maps shipped with the library, keyed by name; validated at load. */
const MAP_DEFS: Readonly<Map<string, MapDef>> = new Map<string, MapDef>(
  [beginnerMapJson, quickstartMapJson, testMapJson].map((m) => {
    return [m.name.toLowerCase(), validateMapDef(m)];
  }),
);

export function getMapDef(name: string): MapDef | undefined {
  return MAP_DEFS.get(name.toLowerCase());
}

export function getAllMapDefs(): MapDef[] {
  return Array.from(MAP_DEFS.values());
}

export function listMapNames(): string[] {
  return Array.from(MAP_DEFS.keys());
}

export type { MapDef } from "./mapschema.js";
export { validateMapDef } from "./mapschema.js";
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
} from "./schema.js";
export {
  CRIT_SLOT_COUNTS,
  CRIT_SOAK_NAMES,
  CRIT_STRUCTURE_NAMES,
  resolveMechDef,
  validateMechDef,
} from "./schema.js";
export type { WeaponDef } from "./weapons.js";
export { getAllWeapons, getWeaponOrThrow as getWeapon, listWeaponNames } from "./weapons.js";
