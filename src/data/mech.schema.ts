import type { Location } from "../core/types.js";
import { isLocation, LOCATIONS } from "../core/types.js";
import { type InternalStructure, internalStructureForTonnage } from "../rules/internalStructure.js";
import { getWeaponOrThrow } from "./weapon.schema.js";

/** Torso locations that have a separate rear armor pool. */
export type TorsoLocation = "centerTorso" | "rightTorso" | "leftTorso";

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
  | { readonly kind: "weapon"; readonly weapon: string }
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
export const CRIT_SOAK_NAMES = ["endoSteel", "ferroFibrous", "case"] as const;

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
export type ResolvedCritSlot =
  | { readonly kind: "empty" }
  | { readonly kind: "weapon"; readonly weapon: string; readonly weaponIndex: number }
  | { readonly kind: "ammo"; readonly weapon: string; readonly weaponIndex: number }
  | {
      readonly kind: "structure";
      readonly name: string;
      /** Sibling slot index (1-based within the same location) of another slot that
       *  belongs to the same multi-slot component (e.g. double heat sink). For a
       *  single-slot component or the first slot of a multi-slot group, this is
       *  the slot's own index. */
      readonly group: readonly number[];
    }
  | { readonly kind: "soak"; readonly name: CritSoakName };

export type ResolvedCritSlots = Readonly<Record<Location, readonly ResolvedCritSlot[]>>;

/**
 * Static definition of a bipedal BattleMech as written in `src/data/mechs/*.json`,
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
  readonly armor: Readonly<Record<Location, number>> &
    Readonly<Partial<Record<RearArmorKey, number>>>;
  readonly weapons: readonly WeaponMount[];
  /**
   * Critical slot table per location, faithful to the record sheet (head/legs
   * = 6 slots, torso/arms = 12). Each entry is a tagged component; empty slots
   * are `{kind:"empty"}` (never `null`). Weapon and ammo entries are linked to
   * `weapons` by `(location, weapon)` occurrence order at resolve time.
   */
  readonly critSlots: CritSlots;
  readonly source: string;
}

export interface WeaponMount {
  readonly weapon: string;
  readonly location: Location;
  /** Shots available; omit for weapons without ammunition. */
  readonly shots?: number;
}

export type ResolvedArmor = Readonly<Record<Location, number>>;
export type ResolvedRearArmor = Readonly<Partial<Record<TorsoLocation, number>>>;

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
  readonly internalStructure: InternalStructure;
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
  const armor: Record<Location, number> = {} as Record<Location, number>;
  for (const loc of LOCATIONS) {
    armor[loc] = def.armor[loc];
  }
  const armorRear: Partial<Record<TorsoLocation, number>> = {};
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
    source: def.source,
  };
}

/**
 * Link weapon/ammo entries of one location's crit slot array to their 1-based
 * weapon indices, and group consecutive double-heat-sink slots.
 *
 * Multi-slot weapons (e.g. AC/20 = 10 slots) link every crit slot to the
 * same single mount in that location; the per-mount ammo schema likewise
 * pools all bins of a weapon into the single ammo-bearing mount. Two
 * *separate* mounts of the same weapon in the same location (e.g. two
 * Medium Lasers in Atlas's CT) get independent linking — slot 11
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
  for (const [k, mount] of Object.entries(weapons)) {
    if (mount.shots === undefined) continue;
    const idx = Number(k);
    const arr = ammoBearingByName.get(mount.weapon) ?? [];
    arr.push(idx);
    ammoBearingByName.set(mount.weapon, arr);
  }
  for (const arr of ammoBearingByName.values()) arr.sort((a, b) => a - b);
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
    const arr = ammoBearingByName.get(weaponName);
    if (!arr) {
      throw new Error(
        `crit slot is ammo for ${JSON.stringify(weaponName)} but no ammo-bearing mount of that weapon exists`,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNumber(obj: Record<string, unknown>, key: string, errors: string[]): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    errors.push(`${key} must be a finite number`);
    return NaN;
  }
  return v;
}

/**
 * Hand-rolled structural validator (zero-dependency policy).
 * Throws with all accumulated problems when `data` is not a valid MechDef.
 */
export function validateMechDef(data: unknown): MechDef {
  const errors: string[] = [];
  if (!isRecord(data)) {
    throw new Error("MechDef must be a JSON object");
  }

  const model = data.model;
  if (typeof model !== "string" || model.length === 0)
    errors.push("model must be a non-empty string");

  const name = data.name;
  if (typeof name !== "string" || name.length === 0) errors.push("name must be a non-empty string");

  const tonnage = requireNumber(data, "tonnage", errors);
  if (Number.isFinite(tonnage) && (tonnage < 10 || tonnage > 100))
    errors.push("tonnage must be 10..100");

  const weightClass = data.weightClass;
  if (
    weightClass !== "Light" &&
    weightClass !== "Medium" &&
    weightClass !== "Heavy" &&
    weightClass !== "Assault"
  ) {
    errors.push("weightClass must be Light|Medium|Heavy|Assault");
  }

  if (typeof data.techBase !== "string") errors.push("techBase must be a string");

  const walking = requireNumber(data, "walking", errors);
  const running = requireNumber(data, "running", errors);
  const jumping = requireNumber(data, "jumping", errors);
  if (Number.isFinite(walking) && Number.isFinite(running) && Number.isFinite(jumping)) {
    if (!Number.isInteger(walking) || walking <= 0)
      errors.push("walking must be a positive integer");
    // Quick-start running rating is walking x1.5 rounded up.
    if (running !== Math.ceil(walking * 1.5)) {
      errors.push(
        `running must equal ceil(walking*1.5) = ${Math.ceil(walking * 1.5)} (quick-start convention)`,
      );
    }
    if (!Number.isInteger(jumping) || jumping < 0)
      errors.push("jumping must be a non-negative integer");
  }

  const armorRaw = data.armor;
  if (!isRecord(armorRaw)) {
    errors.push("armor must be an object keyed by location");
  } else {
    for (const loc of [
      "head",
      "centerTorso",
      "rightTorso",
      "leftTorso",
      "rightArm",
      "leftArm",
      "rightLeg",
      "leftLeg",
    ]) {
      const v = armorRaw[loc];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        errors.push(`armor.${loc} must be a non-negative integer`);
      }
    }
    for (const key of Object.keys(armorRaw)) {
      if (REAR_ARMOR_KEYS.includes(key as RearArmorKey)) {
        const v = armorRaw[key];
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
          errors.push(`armor.${key} must be a non-negative integer`);
        }
      } else if (!isLocation(key)) {
        errors.push(`armor.${key} is not a valid location`);
      }
    }
  }

  const weapons = data.weapons;
  if (!Array.isArray(weapons)) {
    errors.push("weapons must be an array");
  } else {
    for (const w of weapons) {
      if (!isRecord(w)) {
        errors.push("each weapon mount must be an object");
        continue;
      }
      if (typeof w.weapon !== "string") errors.push("weapon.weapon must be a string");
      if (typeof w.location !== "string" || !isLocation(w.location)) {
        errors.push(`weapon.location ${JSON.stringify(w.location)} is not a valid location`);
      }
      const shots = w.shots;
      if (shots !== undefined && shots !== null) {
        if (typeof shots !== "number" || !Number.isInteger(shots) || shots <= 0) {
          errors.push("weapon.shots must be a positive integer");
        }
      }
    }
  }

  const critSlots = data.critSlots;
  if (!isRecord(critSlots)) {
    errors.push("critSlots must be an object keyed by location");
  } else {
    for (const loc of LOCATIONS) {
      const arr = critSlots[loc];
      const expected = CRIT_SLOT_COUNTS[loc];
      if (!Array.isArray(arr)) {
        errors.push(`critSlots.${loc} must be an array of length ${expected}`);
        continue;
      }
      if (arr.length !== expected) {
        errors.push(`critSlots.${loc} must have exactly ${expected} entries (got ${arr.length})`);
        continue;
      }
      for (let i = 0; i < arr.length; i++) {
        const slot = arr[i];
        if (slot === null) {
          errors.push(
            `critSlots.${loc}[${i}] must not be null; use {"kind":"empty"} for an empty slot`,
          );
          continue;
        }
        if (!isRecord(slot)) {
          errors.push(`critSlots.${loc}[${i}] must be a slot object`);
          continue;
        }
        const kind = slot.kind;
        if (kind === "empty") {
          // ok
        } else if (kind === "weapon") {
          if (typeof slot.weapon !== "string") {
            errors.push(`critSlots.${loc}[${i}].weapon must be a string`);
            continue;
          }
          try {
            getWeaponOrThrow(slot.weapon);
          } catch {
            errors.push(
              `critSlots.${loc}[${i}].weapon ${JSON.stringify(slot.weapon)} is not a known weapon`,
            );
          }
        } else if (kind === "ammo") {
          if (typeof slot.weapon !== "string") {
            errors.push(`critSlots.${loc}[${i}].weapon must be a string`);
            continue;
          }
          try {
            getWeaponOrThrow(slot.weapon);
          } catch {
            errors.push(
              `critSlots.${loc}[${i}].weapon ${JSON.stringify(slot.weapon)} is not a known weapon`,
            );
          }
        } else if (kind === "structure") {
          if (
            typeof slot.name !== "string" ||
            !(CRIT_STRUCTURE_NAMES as readonly string[]).includes(slot.name)
          ) {
            errors.push(
              `critSlots.${loc}[${i}].name ${JSON.stringify(slot.name)} is not a known structure component`,
            );
          }
        } else if (kind === "soak") {
          if (
            typeof slot.name !== "string" ||
            !(CRIT_SOAK_NAMES as readonly string[]).includes(slot.name)
          ) {
            errors.push(
              `critSlots.${loc}[${i}].name ${JSON.stringify(slot.name)} is not a known soak component`,
            );
          }
        } else {
          errors.push(
            `critSlots.${loc}[${i}].kind ${JSON.stringify(kind)} must be empty|weapon|ammo|structure|soak`,
          );
        }
      }
      // Linkage check: a crit-slot weapon reference must resolve to at least
      // one weapon mount of that name anywhere on the 'Mech (multi-slot
      // weapons legitimately occupy several slots for a single mount, so we
      // do not bound the count). Ammo bins pool by weapon name and need at
      // least one ammo-bearing mount anywhere on the 'Mech.
      if (Array.isArray(weapons)) {
        const mountNames = new Set<string>();
        const ammoBearingNames = new Set<string>();
        for (const w of weapons) {
          if (isRecord(w) && typeof w.weapon === "string") {
            mountNames.add(w.weapon);
            if (typeof w.shots === "number") ammoBearingNames.add(w.weapon);
          }
        }
        for (let i = 0; i < arr.length; i++) {
          const slot = arr[i];
          if (!isRecord(slot)) continue;
          if (slot.kind === "weapon" && typeof slot.weapon === "string") {
            if (!mountNames.has(slot.weapon)) {
              errors.push(
                `critSlots.${loc}[${i}] references weapon ${JSON.stringify(slot.weapon)} but no mount of that weapon is declared`,
              );
            }
          } else if (slot.kind === "ammo" && typeof slot.weapon === "string") {
            if (!ammoBearingNames.has(slot.weapon)) {
              errors.push(
                `critSlots.${loc}[${i}] is ammo for ${JSON.stringify(slot.weapon)} but no ammo-bearing mount of that weapon exists`,
              );
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid MechDef (${String(model ?? "?")}):\n  - ${errors.join("\n  - ")}`);
  }

  return data as unknown as MechDef;
}
