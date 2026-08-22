import enforcerJson from "./mechs/enf-4r.json";
import hunchbackJson from "./mechs/hbk-4g.json";
import cicadaJson from "./mechs/cda-3ma.json";
import hermesJson from "./mechs/her-5sa.json";
import griffinJson from "./mechs/grf-1n.json";
import wolverineJson from "./mechs/wvr-6r.json";
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

export { validateMechDef } from "./schema.js";
export type { MechDef, WeaponMount } from "./schema.js";
export { WEAPONS, getWeapon } from "./weapons.js";
export type { WeaponDef } from "./weapons.js";
