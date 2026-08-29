import beginnerMapJson from "./maps/beginner.json";
import quickstartMapJson from "./maps/quickstart.json";
import testMapJson from "./maps/test.json";
import { type MapDef, validateMapDef } from "./mapschema.js";
import { MECH_DEFS } from "./mechCatalog.generated.js";
import type { ResolvedMechDef } from "./schema.js";

export { MECH_DEFS };

export function getMechDef(model: string): ResolvedMechDef | undefined {
  return MECH_DEFS[model];
}

/** All battle maps shipped with the library, keyed by name; validated at load. */
export const MAP_DEFS: Readonly<Record<string, MapDef>> = {
  beginner: validateMapDef(beginnerMapJson),
  quickstart: validateMapDef(quickstartMapJson),
  test: validateMapDef(testMapJson),
};

export function getMapDef(name: string): MapDef | undefined {
  return MAP_DEFS[name];
}

export type { MapDef } from "./mapschema.js";
export { toEngineTerrain, validateMapDef } from "./mapschema.js";
export type {
  MechDef,
  RearArmorKey,
  ResolvedArmor,
  ResolvedMechDef,
  WeaponMount,
} from "./schema.js";
export { resolveMechDef, validateMechDef } from "./schema.js";
export type { WeaponDef } from "./weapons.js";
export { getWeapon, WEAPONS } from "./weapons.js";
