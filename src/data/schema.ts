import type { Location } from "../core/types.js";
import { isLocation } from "../core/types.js";

/**
 * Static definition of a bipedal BattleMech, transcribed from quick-start
 * record sheets. Armor is a flat hit-point value per location: overflow damage
 * transfers inward only once a location's armor reaches 0.
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
  readonly armor: Readonly<Record<Location, number>>;
  readonly weapons: readonly WeaponMount[];
  readonly source: string;
}

export interface WeaponMount {
  readonly weapon: string;
  readonly location: Location;
  /** Shots available; omit for weapons without ammunition. */
  readonly ammoShots?: number;
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

  const model = data["model"];
  if (typeof model !== "string" || model.length === 0) errors.push("model must be a non-empty string");

  const name = data["name"];
  if (typeof name !== "string" || name.length === 0) errors.push("name must be a non-empty string");

  const tonnage = requireNumber(data, "tonnage", errors);
  if (Number.isFinite(tonnage) && (tonnage < 10 || tonnage > 100)) errors.push("tonnage must be 10..100");

  const weightClass = data["weightClass"];
  if (
    weightClass !== "Light" &&
    weightClass !== "Medium" &&
    weightClass !== "Heavy" &&
    weightClass !== "Assault"
  ) {
    errors.push("weightClass must be Light|Medium|Heavy|Assault");
  }

  if (typeof data["techBase"] !== "string") errors.push("techBase must be a string");

  const walking = requireNumber(data, "walking", errors);
  const running = requireNumber(data, "running", errors);
  const jumping = requireNumber(data, "jumping", errors);
  if (
    Number.isFinite(walking) &&
    Number.isFinite(running) &&
    Number.isFinite(jumping)
  ) {
    if (!Number.isInteger(walking) || walking <= 0) errors.push("walking must be a positive integer");
    // Quick-start running rating is walking x1.5 rounded up.
    if (running !== Math.ceil(walking * 1.5)) {
      errors.push(`running must equal ceil(walking*1.5) = ${Math.ceil(walking * 1.5)} (quick-start convention)`);
    }
    if (!Number.isInteger(jumping) || jumping < 0) errors.push("jumping must be a non-negative integer");
  }

  const armorRaw = data["armor"];
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
      if (!isLocation(key)) errors.push(`armor.${key} is not a valid location`);
    }
  }

  const weapons = data["weapons"];
  if (!Array.isArray(weapons)) {
    errors.push("weapons must be an array");
  } else {
    for (const w of weapons) {
      if (!isRecord(w)) {
        errors.push("each weapon mount must be an object");
        continue;
      }
      if (typeof w["weapon"] !== "string") errors.push("weapon.weapon must be a string");
      if (typeof w["location"] !== "string" || !isLocation(w["location"])) {
        errors.push(`weapon.location ${JSON.stringify(w["location"])} is not a valid location`);
      }
      const shots = w["ammoShots"];
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
