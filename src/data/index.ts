import enforcerJson from "./mechs/enf-4r.json";
import hunchbackJson from "./mechs/hbk-4g.json";
import cicadaJson from "./mechs/cda-3ma.json";
import hermesJson from "./mechs/her-5sa.json";
import griffinJson from "./mechs/grf-1n.json";
import wolverineJson from "./mechs/wvr-6r.json";
import beginnerMapJson from "./maps/beginner.json";
import quickstartMapJson from "./maps/quickstart.json";
import { validateMapDef, toEngineTerrain, type MapDef } from "./mapschema.js";
import { validateMechDef, type MechDef } from "./schema.js";

function load(data: unknown): MechDef {
  return validateMechDef(data);
}

/** All 'Mech definitions shipped with the library, keyed by model. */
export const MECH_DEFS: Readonly<Record<string, MechDef>> = Object.fromEntries(
  [
    enforcerJson,
    hunchbackJson,
    cicadaJson,
    hermesJson,
    griffinJson,
    wolverineJson,
  ].map((data) => {
    const def = load(data);
    return [def.model, def];
  }),
);

export function getMechDef(model: string): MechDef | undefined {
  return MECH_DEFS[model];
}

/** All battle maps shipped with the library, keyed by name; validated at load. */
export const MAP_DEFS: Readonly<Record<string, MapDef>> = {
  beginner: validateMapDef(beginnerMapJson),
  quickstart: validateMapDef(quickstartMapJson),
};

export function getMapDef(name: string): MapDef | undefined {
  return MAP_DEFS[name];
}

export { toEngineTerrain, validateMapDef } from "./mapschema.js";
export type { MapDef } from "./mapschema.js";
export { validateMechDef } from "./schema.js";
export type { MechDef, WeaponMount } from "./schema.js";
export { WEAPONS, getWeapon } from "./weapons.js";
export type { WeaponDef } from "./weapons.js";
