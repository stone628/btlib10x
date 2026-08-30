import type { Location } from "../core/types.js";
import { isLocation, LOCATIONS } from "../core/types.js";
import { type InternalStructure, internalStructureForTonnage } from "../rules/internalStructure.js";

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
  readonly source: string;
}

export interface WeaponMount {
  readonly weapon: string;
  readonly location: Location;
  /** Shots available; omit for weapons without ammunition. */
  readonly ammoShots?: number;
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
  readonly source: string;
}

/**
 * Convert a raw `MechDef` into the engine-facing `ResolvedMechDef`, keeping the
 * front/rear armor split intact (no summing) and deriving internal structure.
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
    source: def.source,
  };
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
      const shots = w.ammoShots;
      if (shots !== undefined && shots !== null) {
        if (typeof shots !== "number" || !Number.isInteger(shots) || shots <= 0) {
          errors.push("weapon.ammoShots must be a positive integer");
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid MechDef (${String(model ?? "?")}):\n  - ${errors.join("\n  - ")}`);
  }

  return data as unknown as MechDef;
}
