/**
 * Doctrine table for the doctrine player (GDD §9.2–9.3): MechWarrior habits
 * turned into scoring weights. A doctrine is a pilot's habit, not a 'Mech
 * role, and lives in the web/game layer only (never in `UnitInit`).
 *
 * Heat ceilings sit one point under a Heat Scale step (TW pp. 159–160):
 * Cold 4 (−1 MP at 5), Warm 7 (+1 to-hit at 8), Hot 9 (−2 MP at 10),
 * Redline 13 (shutdown check at 14). Overdrive plans up to the automatic
 * shutdown at 30.
 */

export type DoctrineKey =
  | "alpha"
  | "longtom"
  | "jumpjockey"
  | "hulldown"
  | "pitfighter"
  | "gladiator"
  | "dispossessed";

export type RangeBand = "short" | "medium" | "long" | "mediumLong" | "any";
export type MeleePreference = "never" | "opportunistic" | "seeks" | "first";
export type JumpUse = "none" | "reposition" | "hitAndRun";

/** Score weights of the GDD §9.1 terms. */
export interface DoctrineWeights {
  readonly range: number;
  readonly cover: number;
  readonly tmm: number;
  readonly flank: number;
  readonly melee: number;
  readonly exposed: number;
  readonly heat: number;
  readonly crowd: number;
  readonly ammo: number;
}

export interface AmmoDiscipline {
  /** Highest to-hit number an ammo weapon is fired at. */
  readonly maxTn: number;
  /** Fraction of the starting shots kept in reserve. */
  readonly reserve: number;
  /** Energy weapons are picked before ammo weapons of equal value. */
  readonly energyFirst: boolean;
}

export interface Doctrine {
  readonly key: DoctrineKey;
  /** Display name (proper noun, not translated). */
  readonly name: string;
  readonly range: RangeBand;
  readonly weights: DoctrineWeights;
  /** Highest end-of-turn heat the doctrine plans for. */
  readonly heatCeiling: number;
  /** Ceiling once the target is inside the unit's medium bracket (Hull-Down). */
  readonly heatCeilingEngaged: number;
  readonly ammo: AmmoDiscipline;
  readonly melee: MeleePreference;
  readonly jump: JumpUse;
  /** Yields when armor + structure left falls to this fraction; 0 = never. */
  readonly yieldAt: number;
  /** Yields earlier while ahead on the judges' points (Dispossessed). */
  readonly yieldWhenAhead: boolean;
}

/** Attack-phase multiplier on expected physical damage, by melee preference. */
export const MELEE_FACTOR: Readonly<Record<MeleePreference, number>> = {
  never: 0,
  opportunistic: 1,
  seeks: 1.2,
  first: 1.5,
};

/** Physical-biased doctrines (melee "seeks" / "first") also charge, DFA and pick up clubs. */
export function isMeleeBiased(doctrine: Doctrine): boolean {
  return doctrine.melee === "seeks" || doctrine.melee === "first";
}

const COLD = 4;
const WARM = 7;
const HOT = 9;
const REDLINE = 13;
const OVERDRIVE = 30;

const FREE: AmmoDiscipline = { maxTn: 12, reserve: 0, energyFirst: false };
const MEASURED: AmmoDiscipline = { maxTn: 10, reserve: 0, energyFirst: false };
const CONSERVATIVE: AmmoDiscipline = { maxTn: 8, reserve: 0.25, energyFirst: false };
const MISER: AmmoDiscipline = { maxTn: 7, reserve: 0.5, energyFirst: true };

// Parameter levels (§9.2) as weights.
const COVER = { low: 0.5, medium: 1, high: 2, veryHigh: 3 } as const;
const FLANK = { low: 0.5, medium: 1.5, high: 3 } as const;
const MELEE_WEIGHT: Readonly<Record<MeleePreference, number>> = {
  never: 0,
  opportunistic: 0.5,
  seeks: 2,
  first: 4,
};

function weights(
  cover: number,
  flank: number,
  melee: MeleePreference,
  exposed: number,
  extra: Partial<DoctrineWeights> = {},
): DoctrineWeights {
  return {
    range: 1,
    cover,
    tmm: 0.8,
    flank,
    melee: MELEE_WEIGHT[melee],
    exposed,
    heat: 2,
    crowd: 0,
    ammo: 0.2,
    ...extra,
  };
}

export const DOCTRINES: Readonly<Record<DoctrineKey, Doctrine>> = {
  alpha: {
    key: "alpha",
    name: "Alpha Striker",
    range: "short",
    weights: weights(COVER.low, FLANK.medium, "opportunistic", 0.6, { ammo: 0 }),
    heatCeiling: REDLINE,
    heatCeilingEngaged: REDLINE,
    ammo: FREE,
    melee: "opportunistic",
    jump: "none",
    yieldAt: 0.15,
    yieldWhenAhead: false,
  },
  longtom: {
    key: "longtom",
    name: "Long Tom",
    range: "long",
    weights: weights(COVER.high, FLANK.low, "never", 1.2),
    heatCeiling: WARM,
    heatCeilingEngaged: WARM,
    ammo: CONSERVATIVE,
    melee: "never",
    jump: "reposition",
    yieldAt: 0.4,
    yieldWhenAhead: false,
  },
  jumpjockey: {
    key: "jumpjockey",
    name: "Jump Jockey",
    range: "medium",
    weights: weights(COVER.medium, FLANK.high, "opportunistic", 1, { tmm: 1.2 }),
    heatCeiling: HOT,
    heatCeilingEngaged: HOT,
    ammo: MEASURED,
    melee: "opportunistic",
    jump: "hitAndRun",
    yieldAt: 0.3,
    yieldWhenAhead: false,
  },
  hulldown: {
    key: "hulldown",
    name: "Hull-Down",
    range: "any",
    weights: weights(COVER.veryHigh, FLANK.low, "opportunistic", 1.2, { tmm: 0.4 }),
    heatCeiling: COLD,
    heatCeilingEngaged: HOT,
    ammo: CONSERVATIVE,
    melee: "opportunistic",
    jump: "reposition",
    yieldAt: 0.5,
    yieldWhenAhead: false,
  },
  pitfighter: {
    key: "pitfighter",
    name: "Pit Fighter",
    range: "short",
    weights: weights(COVER.low, FLANK.high, "first", 0.5),
    heatCeiling: HOT,
    heatCeilingEngaged: HOT,
    ammo: MEASURED,
    melee: "first",
    jump: "reposition",
    yieldAt: 0.2,
    yieldWhenAhead: false,
  },
  gladiator: {
    key: "gladiator",
    name: "Gladiator",
    range: "short",
    weights: weights(COVER.low, FLANK.medium, "seeks", 0.3, { crowd: 1, ammo: 0 }),
    heatCeiling: OVERDRIVE,
    heatCeilingEngaged: OVERDRIVE,
    ammo: FREE,
    melee: "seeks",
    jump: "hitAndRun",
    yieldAt: 0,
    yieldWhenAhead: false,
  },
  dispossessed: {
    key: "dispossessed",
    name: "Dispossessed",
    range: "mediumLong",
    weights: weights(COVER.high, FLANK.low, "never", 1.5, { ammo: 0.5 }),
    heatCeiling: COLD,
    heatCeilingEngaged: COLD,
    ammo: MISER,
    melee: "never",
    jump: "reposition",
    yieldAt: 0.6,
    yieldWhenAhead: true,
  },
};

export const DOCTRINE_KEYS: readonly DoctrineKey[] = Object.keys(DOCTRINES) as DoctrineKey[];

export function isDoctrineKey(word: string): word is DoctrineKey {
  return Object.hasOwn(DOCTRINES, word);
}
