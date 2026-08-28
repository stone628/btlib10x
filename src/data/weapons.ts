/**
 * Weapon catalog for the quick-start rules. Ranges are the maximum hex count
 * for each bracket (short/medium/long); a target beyond longRange is out of
 * range. Effects mirror the letter codes printed on record sheets:
 *   P = Pulse (-2 to-hit), V = Variable damage by bracket,
 *   C = Cluster (rolls Cluster Hits Table), R = Rapid-fire multi-shot.
 */
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
  /** V-code damage values per bracket [short, medium, long]. */
  readonly variableDamage?: readonly [number, number, number];
  readonly pulse?: boolean;
  readonly antiInfantry?: boolean;
  readonly rapidFireShots?: number;
}

export const WEAPONS: Readonly<Record<string, WeaponDef>> = {
  "Small Laser": { name: "Small Laser", short: 1, medium: 2, long: 3, damage: 3 },
  "Medium Laser": { name: "Medium Laser", short: 3, medium: 6, long: 9, damage: 5 },
  "Large Laser": { name: "Large Laser", short: 5, medium: 10, long: 15, damage: 8 },
  PPC: { name: "PPC", short: 6, medium: 12, long: 18, damage: 10 },
  "Snub-Nose PPC": {
    name: "Snub-Nose PPC",
    short: 9,
    medium: 13,
    long: 15,
    variableDamage: [10, 8, 5],
  },
  Flamer: { name: "Flamer", short: 1, medium: 2, long: 3, damage: 2, antiInfantry: true },
  "Machine Gun": {
    name: "Machine Gun",
    short: 1,
    medium: 2,
    long: 3,
    damage: 2,
    antiInfantry: true,
  },
  "Autocannon/5": { name: "Autocannon/5", short: 6, medium: 12, long: 18, damage: 5 },
  "Autocannon/10": { name: "Autocannon/10", short: 5, medium: 10, long: 15, damage: 10 },
  "Autocannon/20": { name: "Autocannon/20", short: 3, medium: 6, long: 9, damage: 20 },
  "Ultra AC/5": {
    name: "Ultra AC/5",
    short: 6,
    medium: 13,
    long: 20,
    damage: 5,
    rapidFireShots: 2,
  },
  "Large Pulse Laser": {
    name: "Large Pulse Laser",
    short: 3,
    medium: 7,
    long: 10,
    damage: 9,
    pulse: true,
  },
  "Small Pulse Laser": {
    name: "Small Pulse Laser",
    short: 1,
    medium: 2,
    long: 3,
    damage: 3,
    pulse: true,
    antiInfantry: true,
  },
  "LRM 5": { name: "LRM 5", short: 7, medium: 14, long: 21, missileDamage: 1, missiles: 5 },
  "LRM 10": { name: "LRM 10", short: 7, medium: 14, long: 21, missileDamage: 1, missiles: 10 },
  "SRM 6": { name: "SRM 6", short: 3, medium: 6, long: 9, missileDamage: 2, missiles: 6 },

  // Clan weapons (full-intro tech; ranges/damage from TRO:3067 / Total Warfare).
  // "CL " prefix distinguishes Clan-built variants from Inner Sphere models of
  // the same name, matching MTF weapon codes (e.g. CLERMediumLaser).
  "CL ER Medium Laser": {
    name: "CL ER Medium Laser",
    short: 5,
    medium: 10,
    long: 15,
    damage: 7,
  },
  "CL Streak SRM 4": {
    name: "CL Streak SRM 4",
    short: 4,
    medium: 8,
    long: 12,
    missileDamage: 2,
    missiles: 4,
  },
  "CL Gauss Rifle": { name: "CL Gauss Rifle", short: 7, medium: 15, long: 22, damage: 15 },
  // LB 20-X modelled in its slug mode (20 damage to one location); the cluster
  // load (20 × 1-point pellets) is a full-rules option not represented here.
  "CL LB 20-X AC": { name: "CL LB 20-X AC", short: 4, medium: 8, long: 12, damage: 20 },
} as const;

export function getWeapon(name: string): WeaponDef {
  const def = WEAPONS[name];
  if (!def) throw new Error(`Unknown weapon: ${name}`);
  return def;
}
