/**
 * GENERATED FILE - do not edit by hand. Regenerate with `npm run gen:mechs`
 * (build/typecheck run it automatically). Indexes every src/data/mechs/*.json.
 */
import type { MechDef } from "./schema.js";
import { validateMechDef } from "./schema.js";

const load = (data: unknown): MechDef => validateMechDef(data);

import as7dJson from "./mechs/as7-d.json";
import cda3maJson from "./mechs/cda-3ma.json";
import enf4rJson from "./mechs/enf-4r.json";
import grf1nJson from "./mechs/grf-1n.json";
import hbk4gJson from "./mechs/hbk-4g.json";
import her5saJson from "./mechs/her-5sa.json";
import mcmkii2Json from "./mechs/mc-mkii-2.json";
import wvr6rJson from "./mechs/wvr-6r.json";

/** All 'Mech definitions shipped with the library, keyed by model. */
export const MECH_DEFS: Readonly<Record<string, MechDef>> = Object.fromEntries(
  [as7dJson, cda3maJson, enf4rJson, grf1nJson, hbk4gJson, her5saJson, mcmkii2Json, wvr6rJson].map(
    (data) => {
      const def = load(data);
      return [def.model, def];
    },
  ),
);
