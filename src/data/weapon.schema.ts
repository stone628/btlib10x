/**
 * Weapon catalog. Ranges are the maximum hex count for each bracket
 * (short/medium/long); a target beyond longRange is out of range. Effects
 * mirror the letter codes printed on record sheets:
 *   P = Pulse (-2 to-hit), V = Variable damage by bracket,
 *   C = Cluster (rolls Cluster Hits Table), R = Rapid-fire multi-shot,
 *   S = Streak (all missiles hit on a successful to-hit roll, no cluster roll;
 *   a miss fires nothing: no ammo spent, no heat).
 */
import { WEAPON_DATA } from "./weapon.data";

export type WeaponCategory = "MISSILE" | "BALLISTIC" | "ENERGY" | "EQUIPMENT";

const WEAPON_CATEGORIES: ReadonlySet<WeaponCategory> = new Set<WeaponCategory>([
  "MISSILE",
  "BALLISTIC",
  "ENERGY",
  "EQUIPMENT",
]);

export interface WeaponDef {
  readonly name: string;
  readonly short: number;
  readonly medium: number;
  readonly long: number;
  /** Direct-fire damage; omit for missile launchers and variable weapons. */
  readonly damage?: number;
  /** Damage per missile for cluster missile weapons (LRM=1, SRM=2). */
  readonly missileDamage?: 1 | 2;
  /** Number of missiles/tubes, used to pick the Cluster Hits Table column. */
  readonly missiles?: number;
  /** Closest range in hexes; closer targets take a (min - distance + 1) penalty. */
  readonly minRange?: number;
  /** V-code damage values per bracket [short, medium, long]. */
  readonly variableDamage?: readonly [number, number, number];
  readonly pulse?: boolean;
  readonly antiInfantry?: boolean;
  /** TODO: apply cluster range mod if it exists */
  readonly clusterRangeMod?: WeaponClusterRangeMod;
  readonly rapidFireShots?: number;
  /** Streak launcher: full tube count hits on success, no cluster roll. */
  readonly streak?: boolean;
  /** Heat points generated per shot (Total Warfare Weapons & Equipment tables). */
  readonly heat?: number;
  /** TODO: explosion damage from critical hit, per TW p.135 */
  readonly critExplosion?: number;
  /** Broad weapon class used for catalog grouping and UI categorization. */
  readonly category: WeaponCategory;
}

export interface WeaponClusterRangeMod {
  readonly short: number;
  readonly medium: number;
  readonly long: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Validate a raw weapon entry against {@link WeaponDef}; pushes a problem string or returns a clean def. */
function parseWeapon(raw: unknown, label: string, errors: string[]): WeaponDef | null {
  if (!isRecord(raw)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  const name = raw.name;
  if (typeof name !== "string" || name.length === 0) {
    errors.push(`${label}.name must be a non-empty string`);
  }
  let valid = true;
  for (const field of ["short", "medium", "long"]) {
    if (!isBoundedInt(raw[field])) {
      errors.push(`${label}.${field} must be a positive integer`);
      valid = false;
    }
  }
  const category = raw.category;
  if (typeof category !== "string" || !WEAPON_CATEGORIES.has(category as WeaponCategory)) {
    errors.push(`${label}.category must be one of MISSILE, BALLISTIC, ENERGY, EQUIPMENT`);
    valid = false;
  }
  const minRange = raw.minRange;
  if (minRange !== undefined && !isBoundedInt(minRange)) {
    errors.push(`${label}.minRange must be a positive integer`);
    valid = false;
  }
  const heat = raw.heat;
  if (heat !== undefined && (typeof heat !== "number" || !Number.isInteger(heat) || heat < 0)) {
    errors.push(`${label}.heat must be a non-negative integer`);
    valid = false;
  }
  const streak = raw.streak;
  if (streak !== undefined && typeof streak !== "boolean") {
    errors.push(`${label}.streak must be a boolean`);
    valid = false;
  }
  const out: Record<string, unknown> = {};
  for (const key of [
    "name",
    "short",
    "medium",
    "long",
    "damage",
    "missileDamage",
    "missiles",
    "variableDamage",
    "pulse",
    "antiInfantry",
    "rapidFireShots",
    "streak",
    "minRange",
    "heat",
    "category",
  ] as const) {
    const v = raw[key];
    if (v !== undefined) out[key] = v;
  }
  if (!valid || typeof name !== "string") return null;
  return out as unknown as WeaponDef;
}

/**
 * Hand-rolled structural validator (zero-dependency policy), mirroring the
 * method used for mech/map definitions. Throws with all accumulated problems.
 */
export function parseWeaponsData(data: unknown): readonly WeaponDef[] {
  const weapons = Array.isArray(data)
    ? data
    : data && typeof data === "object" && "weapons" in data
      ? (data as { weapons: unknown }).weapons
      : undefined;
  if (!Array.isArray(weapons)) {
    throw new Error("Invalid WeaponsFile: expected an array of weapon definitions");
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  const parsed: WeaponDef[] = [];
  for (const [i, entry] of weapons.entries()) {
    const def = parseWeapon(entry, `weapons[${i}]`, errors);
    if (def === null) continue;
    if (seen.has(def.name)) {
      errors.push(`weapons[${i}] duplicates name ${JSON.stringify(def.name)}`);
    } else {
      seen.add(def.name);
      parsed.push(def);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid WeaponDef:\n  - ${errors.join("\n  - ")}`);
  }
  return parsed;
}

const WEAPONS: Readonly<Map<string, WeaponDef>> = new Map<string, WeaponDef>(
  WEAPON_DATA.map((def) => [def.name, def]),
);

export function weaponDef(name: string): WeaponDef | undefined {
  return WEAPONS.get(name);
}

export interface WeaponNameHolder {
  readonly weapon: string;
}

export function weaponDefFor(h: WeaponNameHolder): WeaponDef {
  const def = WEAPONS.get(h.weapon);
  if (!def) throw new Error(`Unknown weapon: ${h.weapon}`);
  return def;
}

export function allWeaponDefs(): WeaponDef[] {
  return Array.from(WEAPONS.values());
}

export function listWeaponNames(): string[] {
  return Array.from(WEAPONS.keys());
}
