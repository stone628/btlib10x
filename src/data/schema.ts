import type { Location } from "../core/types.js";
import { isLocation, LOCATIONS } from "../core/types.js";

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
  readonly armor: Readonly<Record<Location, number>> & Readonly<Partial<Record<RearArmorKey, number>>>;
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

/**
 * Engine-facing 'Mech definition produced by `resolveMechDef`. Armor is a flat
 * hit-point value per location: torso armor sums front + rear, overflow damage
 * transfers inward only once a location's armor reaches 0. No rear keys survive.
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
  readonly armor: ResolvedArmor;
  readonly weapons: readonly WeaponMount[];
  readonly source: string;
}

/**
 * Convert a raw `MechDef` into the engine-facing `ResolvedMechDef`, summing the
 * rear torso values into their front locations and dropping the rear keys.
 */
export function resolveMechDef(def: MechDef): ResolvedMechDef {
  const armor: Record<Location, number> = {} as Record<Location, number>;
  for (const loc of LOCATIONS) {
    armor[loc] = def.armor[loc];
  }
  armor.centerTorso += def.armor.centerTorsoRear ?? 0;
  armor.rightTorso += def.armor.rightTorsoRear ?? 0;
  armor.leftTorso += def.armor.leftTorsoRear ?? 0;
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
    weapons: def.weapons,
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
