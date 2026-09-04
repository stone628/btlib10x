/**
 * GENERATED FILE - do not edit by hand. Regenerate with `npm run gen:mechs`
 * (build/typecheck run it automatically). Indexes every src/data/mechs/*.json,
 * validating each against the raw JSON schema and resolving it into the
 * engine-facing definition that keeps front and rear armor as separate pools.
 */
import type { ResolvedMechDef } from "./mech.schema.js";
import { resolveMechDef, validateMechDef } from "./mech.schema.js";

const load = (data: unknown): ResolvedMechDef => resolveMechDef(validateMechDef(data));

import as7dJson from "./mechs/as7-d.json";
import cda3maJson from "./mechs/cda-3ma.json";
import enf4rJson from "./mechs/enf-4r.json";
import grf1nJson from "./mechs/grf-1n.json";
import hbk4gJson from "./mechs/hbk-4g.json";
import her5saJson from "./mechs/her-5sa.json";
import mcmkii2Json from "./mechs/mc-mkii-2.json";
import twprimeJson from "./mechs/tw-prime.json";
import whkprimeJson from "./mechs/whk-prime.json";
import wvr6rJson from "./mechs/wvr-6r.json";

/** All 'Mech definitions shipped with the library, keyed by model. */
export const MECH_DEFS: Readonly<Map<string, ResolvedMechDef>> = new Map<string, ResolvedMechDef>(
  [
    as7dJson,
    cda3maJson,
    enf4rJson,
    grf1nJson,
    hbk4gJson,
    her5saJson,
    mcmkii2Json,
    twprimeJson,
    whkprimeJson,
    wvr6rJson,
  ].map((data) => {
    const def = load(data);
    return [def.model, def];
  }),
);
