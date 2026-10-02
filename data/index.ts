/**
 * GENERATED FILE - do not edit by hand. Regenerate with `npm run gen:mechs`.
 * Indexes every data/mechs/*.json and data/maps/*.json as raw definitions
 * alongside the weapon/ammo tables. The engine validates and loads them via
 * `loadShippedData` (see `src/data/index.ts`).
 */
import type { AmmoDef, MapDefSrc, MechDef, WeaponDef } from "btlib10x";
import ammoJson from "./ammo.json";
import beginnerMap from "./maps/beginner.json";
import quickstartMap from "./maps/quickstart.json";
import testMap from "./maps/test.json";
import testgroundMap from "./maps/testground.json";
import as7dMech from "./mechs/as7-d.json";
import bswx1Mech from "./mechs/bsw-x1.json";
import bzkf3Mech from "./mechs/bzk-f3.json";
import cda3maMech from "./mechs/cda-3ma.json";
import enf4rMech from "./mechs/enf-4r.json";
import grf1nMech from "./mechs/grf-1n.json";
import hbk4gMech from "./mechs/hbk-4g.json";
import hct5sMech from "./mechs/hct-5s.json";
import her5saMech from "./mechs/her-5sa.json";
import mcmkii2Mech from "./mechs/mc-mkii-2.json";
import twprimeMech from "./mechs/tw-prime.json";
import whkprimeMech from "./mechs/whk-prime.json";
import wvr6rMech from "./mechs/wvr-6r.json";
import weaponsJson from "./weapons.json";

/** Raw weapon table shipped with the library; validated at load. */
export const WEAPON_DATA: readonly WeaponDef[] = weaponsJson as unknown as readonly WeaponDef[];

/** Raw ammo table shipped with the library; validated at load. */
export const AMMO_DATA: readonly AmmoDef[] = ammoJson as unknown as readonly AmmoDef[];

/** Raw 'Mech definitions shipped with the library; validated at load. */
export const MECH_SRCS: readonly MechDef[] = [
  as7dMech,
  bswx1Mech,
  bzkf3Mech,
  cda3maMech,
  enf4rMech,
  grf1nMech,
  hbk4gMech,
  hct5sMech,
  her5saMech,
  mcmkii2Mech,
  twprimeMech,
  whkprimeMech,
  wvr6rMech,
] as unknown as readonly MechDef[];

/** Raw map sources shipped with the library; validated at load. */
export const MAP_SRCS: readonly MapDefSrc[] = [
  beginnerMap,
  quickstartMap,
  testMap,
  testgroundMap,
] as unknown as readonly MapDefSrc[];
