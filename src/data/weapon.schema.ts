/**
 * Weapon catalog. Ranges are the maximum hex count for each bracket
 * (short/medium/long); a target beyond longRange is out of range. Effects
 * mirror the letter codes printed on record sheets:
 *   P = Pulse (eligibility flag; the -2 lives in `toHitMod`),
 *   V = Variable damage by bracket,
 *   C = Cluster (rolls Cluster Hits Table), R = Rapid-fire multi-shot,
 *   S = Streak (all missiles hit on a successful to-hit roll, no cluster roll;
 *   a miss fires nothing: no ammo spent, no heat),
 *   H = Heat-Causing (`heatEffect`; target heat lands in the Heat Phase).
 * The To-Hit Mod column (TW p.303-304) lives in `toHitMod`:
 *   pulse -2, LB-X cluster -1 (cluster mode only, deferred), MRM +1,
 *   Clan heavy lasers +1.
 *
 * Catalog data lives in the engine (`weapons.data.ts`); this module holds
 * the schema, the validator, and the lookup helpers backed by a registry
 * that self-populates from the embedded table on first read. Call
 * `registerWeapons` only to override the shipped table (e.g. in tests).
 */

import { WEAPON_DATA } from "./weapons.data";

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
  /** P-code eligibility flag (Targeting Computer / aimed-shot rules, TW p.113, p.143).
   *  The actual -2 lives in `toHitMod`; this flag stays so later milestones can
   *  tell a pulse laser from any other -2 weapon. */
  readonly pulse?: boolean;
  /** To-Hit Mod column (TW p.303-304): -2 pulse, +1 MRM / Clan heavy lasers.
   *  LB-X stays 0 in slug mode; its -1 cluster-mode modifier arrives with the
   *  switchable-ammo milestone (see "What I'll do" in docs/VISION.md). */
  readonly toHitMod?: number;
  readonly antiInfantry?: boolean;
  /** HAG range-dependent cluster-roll modifier (TW p.136). */
  readonly clusterRangeMod?: WeaponClusterRangeMod;
  readonly rapidFireShots?: number;
  /** Streak launcher: full tube count hits on success, no cluster roll. */
  readonly streak?: boolean;
  /** Heat points generated per shot (Total Warfare Weapons & Equipment tables). */
  readonly heat?: number;
  /** Melee equipment (TW p.146 physical weapons): mounted via crit slots and
   *  used through physical-attack declarations, never fired as a ranged
   *  weapon. Only Hatchet, Sword, and Retractable Blade are modeled. */
  readonly physicalWeapon?: boolean;
  /** Explosion damage from a critical hit on the weapon itself (TW p.135-136). */
  readonly critExplosion?: number;
  /**
   * Critical slots the weapon occupies (TechManual). Listed only for weapons
   * large enough to be split across two locations; `resolveMechDef` uses it
   * to check a split weapon's slots add up and to pick its mount.
   */
  readonly crits?: number;
  /** H-code heat-causing behavior (TW p.113, p.303). Heat reaches only
   *  'Mech targets and lands in their next Heat Phase as outside heat
   *  (capped at 15 per turn, TW p.159). */
  readonly heatEffect?: WeaponHeatEffect;
  /** Broad weapon class used for catalog grouping and UI categorization. */
  readonly category: WeaponCategory;
}

/**
 * Heat-causing (H) weapon behavior:
 *   `asHeat` - flamers: the Damage Value may be applied as heat instead of
 *   damage, announced before the to-hit roll (TW p.303 footnote ‡); the
 *   attacker's `heatFlamer` policy makes the choice.
 *   `extraHeat` - plasma weapons: `dice` D6 of heat on every hit, on top of
 *   any `damage` (Plasma Rifle 10 + 1D6, Plasma Cannon 0 + 2D6; TW p.139).
 */
export type WeaponHeatEffect =
  | { readonly kind: "asHeat" }
  | { readonly kind: "extraHeat"; readonly dice: 1 | 2 };

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
  const category = raw.category;
  if (typeof category !== "string" || !WEAPON_CATEGORIES.has(category as WeaponCategory)) {
    errors.push(`${label}.category must be one of MISSILE, BALLISTIC, ENERGY, EQUIPMENT`);
    valid = false;
  }
  // Ranged weapons need positive brackets; EQUIPMENT (probes, ECM, pods) may
  // carry 0 brackets for "no ranged fire" (e.g. A-Pod 0/0/0, Active Probe 0/0/5).
  const rangeOk =
    category === "EQUIPMENT"
      ? (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0
      : isBoundedInt;
  for (const field of ["short", "medium", "long"]) {
    if (!rangeOk(raw[field])) {
      errors.push(
        `${label}.${field} must be ${category === "EQUIPMENT" ? "a non-negative" : "a positive"} integer`,
      );
      valid = false;
    }
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
  const physicalWeapon = raw.physicalWeapon;
  if (physicalWeapon !== undefined && typeof physicalWeapon !== "boolean") {
    errors.push(`${label}.physicalWeapon must be a boolean`);
    valid = false;
  }
  const toHitMod = raw.toHitMod;
  if (
    toHitMod !== undefined &&
    (typeof toHitMod !== "number" || !Number.isInteger(toHitMod) || toHitMod < -5 || toHitMod > 5)
  ) {
    errors.push(`${label}.toHitMod must be an integer -5..5`);
    valid = false;
  }
  const critExplosion = raw.critExplosion;
  if (
    critExplosion !== undefined &&
    (typeof critExplosion !== "number" || !Number.isInteger(critExplosion) || critExplosion < 0)
  ) {
    errors.push(`${label}.critExplosion must be a non-negative integer`);
    valid = false;
  }
  const crits = raw.crits;
  if (crits !== undefined && !isBoundedInt(crits)) {
    errors.push(`${label}.crits must be a positive integer`);
    valid = false;
  }
  const heatEffect = raw.heatEffect;
  if (heatEffect !== undefined) {
    if (!isRecord(heatEffect)) {
      errors.push(`${label}.heatEffect must be an object`);
      valid = false;
    } else if (heatEffect.kind === "asHeat") {
      if (typeof raw.damage !== "number" || raw.damage <= 0) {
        errors.push(`${label}.heatEffect asHeat needs a positive damage`);
        valid = false;
      }
    } else if (heatEffect.kind === "extraHeat") {
      if (heatEffect.dice !== 1 && heatEffect.dice !== 2) {
        errors.push(`${label}.heatEffect.dice must be 1 or 2`);
        valid = false;
      }
    } else {
      errors.push(`${label}.heatEffect.kind must be asHeat or extraHeat`);
      valid = false;
    }
  }
  const clusterRangeMod = raw.clusterRangeMod;
  if (clusterRangeMod !== undefined) {
    if (!isRecord(clusterRangeMod)) {
      errors.push(`${label}.clusterRangeMod must be an object`);
      valid = false;
    } else {
      for (const field of ["short", "medium", "long"]) {
        const v = clusterRangeMod[field];
        if (typeof v !== "number" || !Number.isInteger(v)) {
          errors.push(`${label}.clusterRangeMod.${field} must be an integer`);
          valid = false;
        }
      }
    }
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
    "toHitMod",
    "antiInfantry",
    "clusterRangeMod",
    "rapidFireShots",
    "streak",
    "physicalWeapon",
    "minRange",
    "heat",
    "critExplosion",
    "crits",
    "heatEffect",
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

const WEAPONS: ReadonlyMap<string, WeaponDef> = new Map<string, WeaponDef>(
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

/**
 * True when the row fires as a ranged weapon in the Weapon Attack Phase.
 * EQUIPMENT rows never do: physical weapons strike through physical-attack
 * declarations (TW p.146), and TAG, Narc, probes, ECM, AMS, MGA and pods
 * belong to the unbuilt equipment pipeline (docs/VISION.md §4), so they
 * carry no damage and must not reach weapon-attack resolution.
 */
export function isFireableWeapon(weapon: WeaponDef): boolean {
  return weapon.category !== "EQUIPMENT";
}

export function allWeaponDefs(): readonly WeaponDef[] {
  return WEAPON_DATA;
}

export function listWeaponNames(): string[] {
  return Array.from(WEAPONS.keys());
}
