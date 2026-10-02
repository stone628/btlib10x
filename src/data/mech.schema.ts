import type { Location } from "../core/types";
import { isLocation, isTorso, LOCATIONS } from "../core/types";
import type { LocationValue, TorsoLocationValue } from "../rules/damage";
import { internalStructureForTonnage } from "../rules/internalStructure";
import { ammoDef } from "./ammo.schema";
import { type WeaponNameHolder, weaponDef } from "./weapon.schema";

/** Heat sink type: single = 1 heat/turn each, double = 2 heat/turn each. */
export type HeatSinkType = "single" | "double";

export const HEAT_SINK_TYPES: readonly HeatSinkType[] = ["single", "double"];

/**
 * Heat sink configuration, faithful to the record sheet / MTF `Heat Sinks:N
 * Type` header. `count` is the TOTAL number of heat sinks (engine-mounted plus
 * external). Per construction rules (TechManual "Additional Heat Sinks"), an
 * engine mounts `floor(walking * tonnage / 25)` sinks internally at no crit
 * cost; the rest occupy crit slots. Double heat sinks dissipate 2 heat per
 * turn each, single sinks 1.
 */
export interface HeatSinkConfig {
  readonly type: HeatSinkType;
  readonly count: number;
}

/** Rear torso armor keys carried inside `armor` as informational metadata. */
export type RearArmorKey = "centerTorsoRear" | "leftTorsoRear" | "rightTorsoRear";

const REAR_ARMOR_KEYS: readonly RearArmorKey[] = [
  "centerTorsoRear",
  "leftTorsoRear",
  "rightTorsoRear",
];

/**
 * Critical slot content. Each entry is a tagged member:
 *   - empty: unused space on the record sheet — the slot re-rolls during
 *     selection. Explicitly tagged (never `null`) so absent and empty are
 *     distinct.
 *   - weapon / ammo: tied to a catalog weapon (the linked `weaponIndex` is
 *     derived by `resolveMechDef` by matching `(location, weapon)` occurrence
 *     order against the `weapons` array).
 *   - structure: a fixed component from the official crit vocabulary
 *     (cockpit, sensors, lifeSupport, engine, gyro, heatSink, doubleHeatSink,
 *     jumpJet, shoulder, upperArmActuator, lowerArmActuator, handActuator,
 *     upperLegActuator, lowerLegActuator, footActuator, hip).
 *   - soak: occupies a slot but cannot take a critical hit (endo steel, CASE,
 *     ferro-fibrous, etc.) — the slot re-rolls during selection. `name` names
 *     the specific armor-tech component occupying the slot.
 */
export type CritSlot =
  | { readonly kind: "empty" }
  | { readonly kind: "weapon"; readonly weapon: string; readonly rearFacing?: boolean }
  | { readonly kind: "ammo"; readonly weapon: string }
  | { readonly kind: "structure"; readonly name: string }
  | { readonly kind: "soak"; readonly name: CritSoakName };

/** All structure component names recognized by the crit table. */
export const CRIT_STRUCTURE_NAMES = [
  "cockpit",
  "sensors",
  "lifeSupport",
  "engine",
  "gyro",
  "heatSink",
  "doubleHeatSink",
  "jumpJet",
  "shoulder",
  "upperArmActuator",
  "lowerArmActuator",
  "handActuator",
  "upperLegActuator",
  "lowerLegActuator",
  "footActuator",
  "targetingComputer",
  "hip",
] as const;

export type CritStructureName = (typeof CRIT_STRUCTURE_NAMES)[number];

/** All soak (armor-tech) component names recognized by the crit table. */
export const CRIT_SOAK_NAMES = ["endoSteel", "ferroFibrous", "case", "caseII"] as const;

export type CritSoakName = (typeof CRIT_SOAK_NAMES)[number];

export type CritSlots = Readonly<Record<Location, readonly CritSlot[]>>;

/** Per-location critical slot counts from the official record sheet. */
export const CRIT_SLOT_COUNTS: Readonly<Record<Location, number>> = {
  head: 6,
  centerTorso: 12,
  rightTorso: 12,
  leftTorso: 12,
  rightArm: 12,
  leftArm: 12,
  rightLeg: 6,
  leftLeg: 6,
};

/**
 * A critical slot in the engine-facing layout: same as `CritSlot` but with the
 * 1-based `weaponIndex` linked to the `weapons` array, when the slot is a
 * weapon or an ammo bin. Empty slots are tagged `{kind:"empty"}`. DHS siblings
 * that share a multi-slot component expose a `group` id so a single hit
 * destroys the whole DHS and any further hit on a sibling re-rolls.
 */
export interface ResolvedCritWeaponSlot extends WeaponNameHolder {
  readonly kind: "weapon";
  readonly weapon: string;
  readonly weaponIndex: number;
}
export interface ResolvedCritAmmoSlot extends WeaponNameHolder {
  readonly kind: "ammo";
  readonly weapon: string;
  readonly weaponIndex: number;
}
export interface ResolvedCritStructure {
  readonly kind: "structure";
  readonly name: string;
  /** Sibling slot index (1-based within the same location) of another slot that
   *  belongs to the same multi-slot component (e.g. double heat sink). For a
   *  single-slot component or the first slot of a multi-slot group, this is
   *  the slot's own index. */
  readonly group: readonly number[];
}
export type ResolvedCritSlot =
  | { readonly kind: "empty" }
  | ResolvedCritWeaponSlot
  | ResolvedCritAmmoSlot
  | ResolvedCritStructure
  | { readonly kind: "soak"; readonly name: CritSoakName };

export type ResolvedCritSlots = Readonly<Record<Location, readonly ResolvedCritSlot[]>>;

/**
 * Static definition of a bipedal BattleMech as written in `src/data/mechs/*.ts`,
 * faithful to the source record sheet / MTF: torso locations hold FRONT armor,
 * and rear torso armor is stored alongside under `centerTorsoRear` /
 * `leftTorsoRear` / `rightTorsoRear`. This is the on-disk (JSON) schema.
 */
export interface MechDef {
  readonly model: string;
  readonly name: string;
  readonly tonnage: number;
  readonly weightClass: "Light" | "Medium" | "Heavy" | "Assault";
  readonly techBase: string;
  readonly walking: number;
  readonly running: number;
  readonly jumping: number;
  /**
   * Armor per location (torso = front only) plus optional rear torso values.
   * Convert to engine-facing flat armor with `resolveMechDef`.
   */
  readonly armor: Readonly<LocationValue> & Readonly<Partial<Record<RearArmorKey, number>>>;
  readonly weapons: readonly WeaponMount[];
  /**
   * Critical slot table per location, faithful to the record sheet (head/legs
   * = 6 slots, torso/arms = 12). Each entry is a tagged component; empty slots
   * are `{kind:"empty"}` (never `null`). Weapon and ammo entries are linked to
   * `weapons` by `(location, weapon)` occurrence order at resolve time.
   */
  readonly critSlots: CritSlots;
  /** Heat sink type and total count (engine-mounted + external). */
  readonly heatsink: HeatSinkConfig;
  readonly source: string;
}

export interface WeaponMount extends WeaponNameHolder {
  readonly weapon: string;
  readonly location: Location;
  /** Shots available; omit for weapons without ammunition. */
  readonly shots?: number;
  /** True when the weapon is mounted rear-facing (MTF `(R)` notation, torso
   *  locations only on a biped). Rear-facing weapons fire into the rear arc
   *  instead of the front arc (TW p.105). Default false. */
  readonly rearFacing?: boolean;
}

export type ResolvedArmor = Readonly<LocationValue>;
export type ResolvedRearArmor = Readonly<TorsoLocationValue>;

/**
 * Engine-facing 'Mech definition produced by `resolveMechDef`. Armor keeps the
 * MTF-faithful split: `armor` holds each location's FRONT hit-point value and
 * `armorRear` holds the three torso rear values. `internalStructure` is derived
 * from tonnage (standard TW table). Depleting a location's armor pool exposes
 * its internal structure before damage transfers inward.
 */
export interface ResolvedMechDef {
  readonly model: string;
  readonly name: string;
  readonly tonnage: number;
  readonly weightClass: "Light" | "Medium" | "Heavy" | "Assault";
  readonly techBase: string;
  readonly walking: number;
  readonly running: number;
  readonly jumping: number;
  /** Front armor per location (torso = front only). */
  readonly armor: ResolvedArmor;
  /** Rear torso armor; only the three torso locations carry values. */
  readonly armorRear: ResolvedRearArmor;
  /** Internal structure per location, derived from tonnage. */
  readonly internalStructure: LocationValue;
  /**
   * Weapons keyed by their 1-based index (dense 1..N). Distinct from
   * `MechDef.weapons`, which is the JSON-array form; `resolveMechDef` re-keys.
   * Iteration via `Object.values` / `Object.keys` yields ascending order per
   * ES2020+ integer-keyed property semantics — matches the on-disk array order.
   */
  readonly weapons: Record<number, WeaponMount>;
  /**
   * Critical slot table with `weaponIndex` linked to the keys in `weapons` and
   * multi-slot components (DHS) marked with their full group of slot indices.
   */
  readonly critSlots: ResolvedCritSlots;
  /** Heat sink type and total count (engine-mounted + external). */
  readonly heatsink: HeatSinkConfig;
  readonly source: string;
}

/**
 * Convert a raw `MechDef` into the engine-facing `ResolvedMechDef`, keeping the
 * front/rear armor split intact (no summing) and deriving internal structure.
 * Weapon/ammo crit slots are linked to the `weapons` map by matching
 * `(location, weapon)` occurrence order; consecutive double-heat-sink slots
 * are grouped so a single hit destroys the whole DHS and sibling slots only
 * soak.
 */
export function resolveMechDef(def: MechDef): ResolvedMechDef {
  const armor: LocationValue = {} as LocationValue;
  for (const loc of LOCATIONS) {
    armor[loc] = def.armor[loc];
  }
  const armorRear: TorsoLocationValue = {} as TorsoLocationValue;
  for (const [loc, key] of [
    ["centerTorso", "centerTorsoRear"],
    ["rightTorso", "rightTorsoRear"],
    ["leftTorso", "leftTorsoRear"],
  ] as const) {
    const v = def.armor[key];
    if (v !== undefined) armorRear[loc] = v;
  }
  const weapons: Record<number, WeaponMount> = {};
  def.weapons.forEach((mount, i) => {
    weapons[i + 1] = mount;
  });
  const critSlots: Record<Location, ResolvedCritSlot[]> = {} as Record<
    Location,
    ResolvedCritSlot[]
  >;
  for (const loc of LOCATIONS) {
    critSlots[loc] = resolveLocationCrits(def.critSlots[loc], weapons, loc);
  }
  return {
    model: def.model,
    name: def.name,
    tonnage: def.tonnage,
    weightClass: def.weightClass,
    techBase: def.techBase,
    walking: def.walking,
    running: def.running,
    jumping: def.jumping,
    armor,
    armorRear,
    internalStructure: internalStructureForTonnage(def.tonnage),
    weapons,
    critSlots,
    heatsink: def.heatsink,
    source: def.source,
  };
}

/**
 * Link weapon/ammo entries of one location's crit slot array to their 1-based
 * weapon indices, and group consecutive double-heat-sink slots.
 *
 * Multi-slot weapons (e.g. AC/20 = 10 slots) link every crit slot to the
 * same single mount in that location. Ammo bins pool by weapon name: when a
 * shots-bearing mount exists, every bin of that weapon shares its index
 * (the per-bin depletion model in `src/rules/ammo.ts`); otherwise the bins
 * fall back to any mount of the weapon, loaded at the ammo table's per-bin
 * capacity. Two *separate* mounts of the same weapon in the same location
 * (e.g. two Medium Lasers in Atlas's CT) get independent linking — slot 11
 * destroys ML #1, slot 12 destroys ML #2.
 */
function resolveLocationCrits(
  rawSlots: readonly CritSlot[],
  weapons: Record<number, WeaponMount>,
  loc: Location,
): ResolvedCritSlot[] {
  // Weapons mounted in this location, by weapon name, in ascending index
  // order. Each crit slot consumes the next available mount so two
  // separate weapons of the same type (e.g. two Medium Lasers) get
  // independent linking.
  const localByName: Map<string, number[]> = new Map();
  for (const [k, mount] of Object.entries(weapons)) {
    if (mount.location !== loc) continue;
    const idx = Number(k);
    const arr = localByName.get(mount.weapon) ?? [];
    arr.push(idx);
    localByName.set(mount.weapon, arr);
  }
  for (const arr of localByName.values()) arr.sort((a, b) => a - b);
  const localCursors = new Map<string, number>();

  // Ammo-bearing mounts, by weapon name, in ascending index order.
  const ammoBearingByName: Map<string, number[]> = new Map();
  // Every mount, by weapon name, also in ascending index order (fallback for
  // ammo bins of weapons that declare no shots).
  const allByName: Map<string, number[]> = new Map();
  for (const [k, mount] of Object.entries(weapons)) {
    const idx = Number(k);
    const arr = (allByName.get(mount.weapon) ?? []).concat(idx);
    allByName.set(mount.weapon, arr);
    if (mount.shots === undefined) continue;
    const ammoArr = ammoBearingByName.get(mount.weapon) ?? [];
    ammoArr.push(idx);
    ammoBearingByName.set(mount.weapon, ammoArr);
  }
  for (const arr of ammoBearingByName.values()) arr.sort((a, b) => a - b);
  for (const arr of allByName.values()) arr.sort((a, b) => a - b);
  const ammoCursors = new Map<string, number>();

  const nextLocal = (weaponName: string): number => {
    const arr = localByName.get(weaponName);
    if (!arr) {
      throw new Error(
        `crit slot references weapon ${JSON.stringify(weaponName)} in ${loc} but no such weapon mount exists in that location`,
      );
    }
    const cursor = localCursors.get(weaponName) ?? 0;
    const idx = arr[cursor % arr.length]!;
    localCursors.set(weaponName, cursor + 1);
    return idx;
  };

  const nextAmmo = (weaponName: string): number => {
    let arr = ammoBearingByName.get(weaponName);
    if (arr === undefined) arr = allByName.get(weaponName);
    if (arr === undefined || arr.length === 0) {
      throw new Error(
        `crit slot is ammo for ${JSON.stringify(weaponName)} but no mount of that weapon exists`,
      );
    }
    const cursor = ammoCursors.get(weaponName) ?? 0;
    const idx = arr[cursor % arr.length]!;
    ammoCursors.set(weaponName, cursor + 1);
    return idx;
  };

  // Intermediate: keep weapon/ammo/structure/soak as a flat tagged union.
  // Structure entries temporarily lack `group`; the second pass fills it in.
  type Intermediate =
    | { readonly kind: "empty" }
    | { readonly kind: "weapon"; readonly weapon: string; readonly weaponIndex: number }
    | { readonly kind: "ammo"; readonly weapon: string; readonly weaponIndex: number }
    | { readonly kind: "structure"; readonly name: string; readonly group?: readonly number[] }
    | { readonly kind: "soak"; readonly name: CritSoakName };
  const out: Intermediate[] = [];
  for (const slot of rawSlots) {
    if (slot.kind === "empty") {
      out.push({ kind: "empty" });
    } else if (slot.kind === "weapon") {
      out.push({ kind: "weapon", weapon: slot.weapon, weaponIndex: nextLocal(slot.weapon) });
    } else if (slot.kind === "ammo") {
      out.push({ kind: "ammo", weapon: slot.weapon, weaponIndex: nextAmmo(slot.weapon) });
    } else if (slot.kind === "structure") {
      out.push({ kind: "structure", name: slot.name });
    } else {
      out.push({ kind: "soak", name: slot.name });
    }
  }

  // Second pass: assign `group` to every structure entry. Consecutive
  // doubleHeatSink slots share a run-length group; every other structure
  // slot gets a singleton (its own 1-based index), so the field is uniform.
  const isStructure = (s: Intermediate): s is Extract<Intermediate, { kind: "structure" }> =>
    s.kind === "structure";
  const finalizeRun = (start: number, end: number) => {
    const runIndices: number[] = [];
    for (let j = start; j < end; j++) runIndices.push(j + 1);
    for (let j = start; j < end; j++) {
      const cur = out[j];
      if (cur && isStructure(cur)) {
        out[j] = { kind: "structure", name: cur.name, group: runIndices };
      }
    }
  };
  let runStart = -1;
  for (let i = 0; i <= out.length; i++) {
    const s = i < out.length ? out[i] : undefined;
    const isDhs = s !== undefined && isStructure(s) && s.name === "doubleHeatSink";
    if (isDhs && runStart < 0) runStart = i;
    else if (!isDhs && runStart >= 0) {
      finalizeRun(runStart, i);
      runStart = -1;
    }
  }
  // Non-DHS structure slots encountered without a run-open: set a singleton group.
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    if (s && isStructure(s) && s.group === undefined) {
      out[i] = { kind: "structure", name: s.name, group: [i + 1] };
    }
  }

  return out as ResolvedCritSlot[];
}

/**
 * Validate a typed MechDef against Total Warfare rules. TypeScript enforces
 * the structural shape at compile time; this catches runtime logical
 * inconsistencies (movement ratings, armor values, crit-slot counts, heat
 * sink reconciliation, weapon/ammo linkage).
 */
export function validateMechDef(def: MechDef): MechDef {
  const errors: string[] = [];

  const { tonnage, walking, running, jumping, techBase } = def;

  if (tonnage < 10 || tonnage > 100) errors.push("tonnage must be 10..100");

  if (!Number.isInteger(walking) || walking <= 0) errors.push("walking must be a positive integer");
  if (running !== Math.ceil(walking * 1.5)) {
    errors.push(
      `running must equal ceil(walking*1.5) = ${Math.ceil(walking * 1.5)} (quick-start convention)`,
    );
  }
  if (!Number.isInteger(jumping) || jumping < 0)
    errors.push("jumping must be a non-negative integer");

  for (const loc of [
    "head",
    "centerTorso",
    "rightTorso",
    "leftTorso",
    "rightArm",
    "leftArm",
    "rightLeg",
    "leftLeg",
  ] as const) {
    const v = def.armor[loc];
    if (!Number.isInteger(v) || v < 0) {
      errors.push(`armor.${loc} must be a non-negative integer`);
    }
  }
  for (const key of Object.keys(def.armor)) {
    if (REAR_ARMOR_KEYS.includes(key as RearArmorKey)) {
      const v = (def.armor as Record<string, number | undefined>)[key];
      if (v === undefined || !Number.isInteger(v) || v < 0) {
        errors.push(`armor.${key} must be a non-negative integer`);
      }
    } else if (!isLocation(key)) {
      errors.push(`armor.${key} is not a valid location`);
    }
  }

  for (const w of def.weapons) {
    if (!isLocation(w.location)) {
      errors.push(`weapon.location ${JSON.stringify(w.location)} is not a valid location`);
    }
    if (w.rearFacing === true && !isTorso(w.location)) {
      errors.push(`weapon.rearFacing is only valid on torso mounts, got ${w.location}`);
    }
    if (w.shots !== undefined) {
      if (!Number.isInteger(w.shots) || w.shots <= 0) {
        errors.push("weapon.shots must be a positive integer");
      } else {
        const ammo = ammoDef(w.weapon);
        if (ammo !== undefined) {
          if (w.shots % ammo.shotsPerBin === 0) continue;
          if (w.shots === Math.floor(ammo.shotsPerBin / 2)) continue;
          errors.push(
            `weapon.shots for ${JSON.stringify(w.weapon)} must be a multiple of its ammo bin capacity (${ammo.shotsPerBin})`,
          );
        }
      }
    }
  }

  const mountNames = new Set(def.weapons.map((w) => w.weapon));

  for (const loc of LOCATIONS) {
    const arr = def.critSlots[loc];
    const expected = CRIT_SLOT_COUNTS[loc];
    if (arr.length !== expected) {
      errors.push(`critSlots.${loc} must have exactly ${expected} entries (got ${arr.length})`);
      continue;
    }
    for (let i = 0; i < arr.length; i++) {
      const slot = arr[i];
      if (!slot) continue;
      switch (slot.kind) {
        case "weapon": {
          if (weaponDef(slot.weapon) === undefined) {
            errors.push(
              `critSlots.${loc}[${i}].weapon ${JSON.stringify(slot.weapon)} is not a known weapon`,
            );
          }
          if (!mountNames.has(slot.weapon)) {
            errors.push(
              `critSlots.${loc}[${i}] references weapon ${JSON.stringify(slot.weapon)} but no mount of that weapon is declared`,
            );
          }
          break;
        }
        case "ammo": {
          if (weaponDef(slot.weapon) === undefined) {
            errors.push(
              `critSlots.${loc}[${i}].weapon ${JSON.stringify(slot.weapon)} is not a known weapon`,
            );
          }
          if (ammoDef(slot.weapon) === undefined) {
            errors.push(
              `critSlots.${loc}[${i}].weapon ${JSON.stringify(slot.weapon)} has no ammo definition`,
            );
          }
          if (!mountNames.has(slot.weapon)) {
            errors.push(
              `critSlots.${loc}[${i}] is ammo for ${JSON.stringify(slot.weapon)} but no mount of that weapon exists`,
            );
          }
          break;
        }
        case "structure": {
          if (!(CRIT_STRUCTURE_NAMES as readonly string[]).includes(slot.name)) {
            errors.push(
              `critSlots.${loc}[${i}].name ${JSON.stringify(slot.name)} is not a known structure component`,
            );
          }
          break;
        }
        case "soak": {
          if (!(CRIT_SOAK_NAMES as readonly string[]).includes(slot.name)) {
            errors.push(
              `critSlots.${loc}[${i}].name ${JSON.stringify(slot.name)} is not a known soak component`,
            );
          }
          break;
        }
      }
    }
  }

  // Heat sink reconciliation: engine mounts floor(walking * tonnage / 25)
  // sinks internally; the rest occupy crit slots (single = 1 slot each,
  // double = grouped in runs of 3 IS / 2 Clan).
  {
    const { heatsink } = def;
    if (!Number.isInteger(heatsink.count) || heatsink.count < 10) {
      errors.push("heatsink.count must be an integer >= 10");
    }
    const width = techBase === "Clan" ? 2 : 3;
    let external = 0;
    let mixed = false;
    for (const loc of LOCATIONS) {
      const arr = def.critSlots[loc];
      let run = 0;
      for (const slot of arr) {
        if (slot.kind === "structure" && slot.name === "doubleHeatSink") {
          run += 1;
          if (heatsink.type === "single") mixed = true;
          continue;
        }
        if (run > 0 && run % width !== 0) {
          errors.push(
            `heatsink: ${loc} double heat sink run length ${run} not divisible by ${width}`,
          );
        }
        external += Math.floor(run / width);
        run = 0;
        if (slot.kind === "structure" && slot.name === "heatSink") {
          external += 1;
          if (heatsink.type === "double") mixed = true;
        }
      }
      if (run > 0 && run % width !== 0) {
        errors.push(
          `heatsink: ${loc} double heat sink run length ${run} not divisible by ${width}`,
        );
      }
      external += Math.floor(run / width);
    }
    if (mixed) {
      errors.push("heatsink: heatSink and doubleHeatSink crit slots cannot be mixed");
    }
    const internal = Math.floor((walking * tonnage) / 25);
    const expectedExternal = Math.max(0, heatsink.count - internal);
    if (external !== expectedExternal) {
      errors.push(
        `heatsink.count ${heatsink.count} needs ${expectedExternal} external sink(s) (engine holds ${internal}); crit slots hold ${external}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid MechDef (${def.model}):\n  - ${errors.join("\n  - ")}`);
  }

  return def;
}
