import ammoJson from "./ammo.json";

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

export interface AmmosFile {
  readonly ammos: readonly AmmoDef[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseAmmo(raw: unknown, label: string, errors: string[]): AmmoDef | null {
  if (!isRecord(raw)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  const weapon = raw.weapon;
  if (typeof weapon !== "string" || weapon.length === 0) {
    errors.push(`${label}.weapon must be a non-empty string`);
  }
  if (!isBoundedInt(raw.shotsPerBin)) {
    errors.push(`${label}.shotsPerBin must be a positive integer`);
  }
  const explosiveRaw = raw.explosive;
  let explosive = true;
  if (explosiveRaw !== undefined) {
    if (typeof explosiveRaw !== "boolean") {
      errors.push(`${label}.explosive must be a boolean`);
    } else {
      explosive = explosiveRaw;
    }
  }
  if (typeof weapon !== "string" || weapon.length === 0) return null;
  return { weapon, shotsPerBin: raw.shotsPerBin as number, explosive };
}

export function parseAmmoData(data: unknown): readonly AmmoDef[] {
  const ammos = Array.isArray(data)
    ? data
    : data && typeof data === "object" && "ammos" in data
      ? (data as { ammos: unknown }).ammos
      : undefined;
  if (!Array.isArray(ammos)) {
    throw new Error("Invalid AmmosFile: expected an array of ammo definitions");
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  const parsed: AmmoDef[] = [];
  for (const [i, entry] of ammos.entries()) {
    const def = parseAmmo(entry, `ammos[${i}]`, errors);
    if (def === null) continue;
    if (seen.has(def.weapon)) {
      errors.push(`ammos[${i}] duplicates weapon ${JSON.stringify(def.weapon)}`);
    } else {
      seen.add(def.weapon);
      parsed.push(def);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid AmmoDef:\n  - ${errors.join("\n  - ")}`);
  }
  return parsed;
}

const AMMO: ReadonlyMap<string, AmmoDef> = new Map(
  parseAmmoData(ammoJson).map((def) => [def.weapon, def]),
);

export function getAmmoDef(name: string): AmmoDef | undefined {
  return AMMO.get(name);
}

export interface AmmoNameHolder {
  readonly weapon: string;
}

export function getAmmoDefFor(h: AmmoNameHolder): AmmoDef {
  const def = AMMO.get(h.weapon);
  if (!def) throw new Error(`Unknown ammo weapon: ${h.weapon}`);
  return def;
}

export function getShotsPerBinFor(h: AmmoNameHolder): number | undefined {
  return AMMO.get(h.weapon)?.shotsPerBin;
}

export function getAllAmmo(): readonly AmmoDef[] {
  return Array.from(AMMO.values());
}

export function listAmmoWeapons(): string[] {
  return Array.from(AMMO.keys());
}
