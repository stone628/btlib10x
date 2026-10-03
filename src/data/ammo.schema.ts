/**
 * Ammo catalog schema and lookup helpers.
 *
 * Catalog data lives in the engine (`ammo.data.ts`); this module holds the
 * schema, the validator, and the lookup helpers backed by a registry that
 * self-populates from the embedded table on first read. Call
 * `registerAmmo` only to override the shipped table (e.g. in tests).
 */

import { AMMO_DATA } from "./ammo.data";

export interface AmmoDef {
  readonly weapon: string;
  readonly shotsPerBin: number;
  /**
   * Whether this ammunition detonates from heat-triggered explosion checks
   * and crit-slot ammo hits. Total Warfare: most ammo is explosive; gauss
   * rifle rounds are inert slugs. Defaults to true when omitted from the
   * data file.
   */
  readonly explosive: boolean;
}

const AMMO: ReadonlyMap<string, AmmoDef> = new Map<string, AmmoDef>(
  AMMO_DATA.map((e) => [e.weapon, e]),
);

export function ammoDef(name: string): AmmoDef | undefined {
  return AMMO.get(name);
}

export interface AmmoNameHolder {
  readonly weapon: string;
}

export function ammoDefFor(h: AmmoNameHolder): AmmoDef {
  const def = AMMO.get(h.weapon);
  if (!def) throw new Error(`Unknown ammo weapon: ${h.weapon}`);
  return def;
}

export function shotsPerBinFor(h: AmmoNameHolder): number | undefined {
  return AMMO.get(h.weapon)?.shotsPerBin;
}

export function allAmmo(): readonly AmmoDef[] {
  return Array.from(AMMO.values());
}

export function listAmmoWeapons(): string[] {
  return Array.from(AMMO.keys());
}
