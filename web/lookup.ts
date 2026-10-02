/**
 * Tolerant lookup wrappers for the engine's strict catalogs. The web CLI accepts
 * user-typed names with arbitrary case ("hbk-4g", "QuickStart", "medium laser");
 * these wrappers normalize input to match the catalog key shape.
 */
import {
  allMapDefs,
  allMechDefs,
  allWeaponDefs,
  loadShippedData,
  type MapDef,
  type ResolvedMechDef,
  type WeaponDef,
} from "btlib10x";
import { AMMO_DATA, MAP_SRCS, MECH_SRCS, WEAPON_DATA } from "btlib10x/data";

// Catalog data ships separately from the engine (see `btlib10x/data`).
// Load it before building the lookup maps below; every web entry point
// reaches the catalogs through this module.
loadShippedData({ weapons: WEAPON_DATA, ammo: AMMO_DATA, mechs: MECH_SRCS, maps: MAP_SRCS });

const MECH_BY_UC: ReadonlyMap<string, ResolvedMechDef> = new Map(
  allMechDefs().map((d) => [d.model.toLowerCase(), d]),
);
const MAP_BY_LC: ReadonlyMap<string, MapDef> = new Map(
  allMapDefs().map((m) => [m.name.toLowerCase(), m]),
);
const WEAPON_BY_LC: ReadonlyMap<string, WeaponDef> = new Map(
  allWeaponDefs().map((w) => [w.name.toLowerCase(), w]),
);

export function lookupMech(model: string): ResolvedMechDef | undefined {
  return MECH_BY_UC.get(model.toLowerCase());
}

export function lookupMap(name: string): MapDef | undefined {
  return MAP_BY_LC.get(name.toLowerCase());
}

export function lookupWeapon(name: string): WeaponDef | undefined {
  return WEAPON_BY_LC.get(name.toLowerCase());
}
