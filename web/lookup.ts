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

export function lookupMechOrThrow(model: string): ResolvedMechDef {
  const def = lookupMech(model);
  if (!def) throw new Error(`Unknown mech: ${model}`);
  return def;
}

export function lookupMapOrThrow(name: string): MapDef {
  const def = lookupMap(name);
  if (!def) throw new Error(`Unknown map: ${name}`);
  return def;
}

export function lookupWeaponOrThrow(name: string): WeaponDef {
  const def = lookupWeapon(name);
  if (!def) throw new Error(`Unknown weapon: ${name}`);
  return def;
}

/** Normalize a user-typed model name to its canonical cased form (or null if unknown). */
export function canonicalModel(model: string): string | null {
  return lookupMech(model)?.model ?? null;
}

/** Normalize a user-typed map name to its canonical cased form (or null if unknown). */
export function canonicalMapName(name: string): string | null {
  return lookupMap(name)?.name ?? null;
}

/** Normalize a user-typed weapon name to its canonical cased form (or null if unknown). */
export function canonicalWeaponName(name: string): string | null {
  return lookupWeapon(name)?.name ?? null;
}
