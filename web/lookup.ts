/**
 * Tolerant lookup wrappers for the engine's strict catalogs. The web CLI accepts
 * user-typed names with arbitrary case ("hbk-4g", "QuickStart", "medium laser");
 * these wrappers normalize input to match the catalog key shape.
 *
 * Lookups read the live registries on every call (no import-time snapshots:
 * sheets register on demand after boot). The catalog loads once at boot
 * (main.ts fetches data/btlib10x.jsonl into the engine store); every web
 * entry point reaches the catalogs through this module.
 */
import {
  allMapDefs,
  allMechDefs,
  allWeaponDefs,
  type MapDef,
  type ResolvedMechDef,
  type WeaponDef,
} from "btlib10x";

export function lookupMech(model: string): ResolvedMechDef | undefined {
  const want = model.toLowerCase();
  for (const d of allMechDefs()) {
    if (d.model.toLowerCase() === want) return d;
  }
  return undefined;
}

export function lookupMap(name: string): MapDef | undefined {
  const want = name.toLowerCase();
  for (const m of allMapDefs()) {
    if (m.name.toLowerCase() === want) return m;
  }
  return undefined;
}

export function lookupWeapon(name: string): WeaponDef | undefined {
  const want = name.toLowerCase();
  for (const w of allWeaponDefs()) {
    if (w.name.toLowerCase() === want) return w;
  }
  return undefined;
}
