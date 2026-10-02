/**
 * Vitest setup: load the shipped catalog data into the engine registries.
 * Rule tests import `../src/*` directly, while the web layer (`../web/*`)
 * resolves `btlib10x` through package exports to `dist/` — both registries
 * need loading. Run `npm run build` first so `dist/` matches `src/`.
 */
import { loadShippedData } from "btlib10x";
import * as distData from "btlib10x/data";
import { AMMO_DATA, MAP_SRCS, MECH_SRCS, WEAPON_DATA } from "../data/index";
import { loadShippedData as loadSrcCatalogs } from "../src/index";

loadSrcCatalogs({ weapons: WEAPON_DATA, ammo: AMMO_DATA, mechs: MECH_SRCS, maps: MAP_SRCS });
loadShippedData({
  weapons: distData.WEAPON_DATA,
  ammo: distData.AMMO_DATA,
  mechs: distData.MECH_SRCS,
  maps: distData.MAP_SRCS,
});
