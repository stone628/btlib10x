/**
 * GENERATED FILE - do not edit by hand. Regenerate with `npm run gen:mechs`
 * (build/typecheck run it automatically). Indexes every src/data/mechs/*.ts,
 * resolving each typed MechDef into the engine-facing ResolvedMechDef that
 * keeps front and rear armor as separate pools.
 */
import type { MechDef, ResolvedMechDef } from "./mech.schema.js";
import { resolveMechDef } from "./mech.schema.js";

import as7dDef from "./mechs/as7-d.js";
import bswx1Def from "./mechs/bsw-x1.js";
import bzkf3Def from "./mechs/bzk-f3.js";
import cda3maDef from "./mechs/cda-3ma.js";
import enf4rDef from "./mechs/enf-4r.js";
import grf1nDef from "./mechs/grf-1n.js";
import hbk4gDef from "./mechs/hbk-4g.js";
import her5saDef from "./mechs/her-5sa.js";
import mcmkii2Def from "./mechs/mc-mkii-2.js";
import twprimeDef from "./mechs/tw-prime.js";
import whkprimeDef from "./mechs/whk-prime.js";
import wvr6rDef from "./mechs/wvr-6r.js";

const mechs: readonly [string, MechDef][] = [
  [as7dDef.model, as7dDef],
  [bswx1Def.model, bswx1Def],
  [bzkf3Def.model, bzkf3Def],
  [cda3maDef.model, cda3maDef],
  [enf4rDef.model, enf4rDef],
  [grf1nDef.model, grf1nDef],
  [hbk4gDef.model, hbk4gDef],
  [her5saDef.model, her5saDef],
  [mcmkii2Def.model, mcmkii2Def],
  [twprimeDef.model, twprimeDef],
  [whkprimeDef.model, whkprimeDef],
  [wvr6rDef.model, wvr6rDef],
];

/** All 'Mech definitions shipped with the library, keyed by model. */
export const MECH_DEFS: Readonly<Map<string, ResolvedMechDef>> = new Map<string, ResolvedMechDef>(
  mechs.map(([model, def]) => [model, resolveMechDef(def)]),
);
