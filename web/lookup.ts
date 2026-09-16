/**
 * Tolerant lookup wrappers for the engine's strict catalogs. The web CLI accepts
 * user-typed names with arbitrary case ("hbk-4g", "QuickStart", "medium laser");
 * these wrappers normalize input to match the catalog key shape.
 */
import {
  getAllMapDefs,
  getAllMechDefs,
  getAllWeaponDefs,
  type MapDef,
  type ResolvedMechDef,
  type WeaponDef,
} from "btlib10x";

const MECH_BY_UC: ReadonlyMap<string, ResolvedMechDef> = new Map(
  getAllMechDefs().map((d) => [d.model.toLowerCase(), d]),
);
const MAP_BY_LC: ReadonlyMap<string, MapDef> = new Map(
  getAllMapDefs().map((m) => [m.name.toLowerCase(), m]),
);
const WEAPON_BY_LC: ReadonlyMap<string, WeaponDef> = new Map(
  getAllWeaponDefs().map((w) => [w.name.toLowerCase(), w]),
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
