/**
 * Tolerant lookup wrappers for the engine's strict catalogs. The web CLI accepts
 * user-typed names with arbitrary case ("hbk-4g", "QuickStart", "medium laser");
 * these wrappers normalize input to match the catalog key shape.
 *
 * Lookups read the live registries on every call (no import-time snapshots:
 * sheets register on demand after boot). The catalog loads once at boot
 * (terminal.ts fetches data/btlib10x.jsonl into the engine store); every web
 * entry point reaches the catalogs through this module.
 */
import {
  ensureMapRegistered,
  ensureMechRegistered,
  type MapDef,
  type ResolvedMechDef,
  WEAPON_DATA,
  type WeaponDef,
} from "btlib10x";

export function lookupMech(model: string): ResolvedMechDef | undefined {
  return ensureMechRegistered(model);
}

export function lookupMap(name: string): MapDef | undefined {
  return ensureMapRegistered(name);
}

const WEAPONS: ReadonlyMap<string, WeaponDef> = new Map<string, WeaponDef>(
  WEAPON_DATA.map((def) => [def.name.toLowerCase(), def]),
);

export function lookupWeapon(name: string): WeaponDef | undefined {
  return WEAPONS.get(name.toLowerCase());
}
