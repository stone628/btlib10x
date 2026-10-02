import type { Location } from "../core/types";
import { LOCATIONS } from "../core/types";
import type { CritSlots, HeatSinkConfig, MechDef, RearArmorKey } from "./mech.schema";
import { CRIT_SOAK_NAMES, CRIT_STRUCTURE_NAMES, weightClassForTonnage } from "./mech.schema";

/**
 * Compact wire form of a `MechDef` body for the packed catalog
 * (`data/btlib10x.jsonl`).
 *
 * Short keys regardless of transport compression: object keys shrink to 1-2
 * chars and closed vocabularies (slot kinds, structure/soak names,
 * heat-sink type, locations) become small ints. Identity
 * (`model`/`name`/`techBase`/`tonnage`, plus optional `clanName`) is NOT on
 * the wire — the manifest entry already carries it, so `decodeMechLine`
 * takes it as a second argument and each sheet is single-sourced.
 * `weightClass` is omitted too (restored with `weightClassForTonnage`).
 * Open vocabularies (weapon names, `source`) stay verbatim strings;
 * tokenising them would couple the wire to catalog contents.
 *
 * `WIRE_VERSION` gates the format; `decodeMechLine` rejects anything else.
 * Table order below is wire-stable: `CRIT_STRUCTURE_NAMES` /
 * `CRIT_SOAK_NAMES` are append-only once packed lines exist.
 */
export const WIRE_VERSION = 1;

/** Location (and rear-armor) keys; codes are stored on the wire. */
const LOC_CODES: Readonly<Record<Location | RearArmorKey, string>> = {
  head: "h",
  centerTorso: "C",
  rightTorso: "R",
  leftTorso: "L",
  rightArm: "a",
  leftArm: "A",
  rightLeg: "g",
  leftLeg: "G",
  centerTorsoRear: "c",
  rightTorsoRear: "r",
  leftTorsoRear: "l",
};

const CODE_LOCS: Readonly<Record<string, Location | RearArmorKey>> = Object.fromEntries(
  Object.entries(LOC_CODES).map(([loc, code]) => [code, loc]),
) as Readonly<Record<string, Location | RearArmorKey>>;

/** Slot-kind wire ids. */
const KIND_IDS = { empty: 0, weapon: 1, ammo: 2, structure: 3, soak: 4 } as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(msg: string): never {
  throw new Error(`Invalid mech line: ${msg}`);
}

/** Identity half of a sheet: carried by the manifest entry, never the wire line. */
export interface MechIdentity {
  readonly model: string;
  readonly name: string;
  readonly techBase: string;
  readonly tonnage: number;
  readonly clanName?: string;
}

/** Encode a canonical `MechDef` into one minified JSONL line (identity omitted). Wire mirror lives in `scripts/pack-catalog.mjs`. */
export function encodeMechDef(def: MechDef): string {
  const armor: Record<string, number> = {};
  for (const [key, value] of Object.entries(def.armor)) {
    armor[LOC_CODES[key as Location | RearArmorKey]] = value as number;
  }
  const weapons = def.weapons.map((m) => ({
    w: m.weapon,
    l: LOC_CODES[m.location],
    ...(m.shots !== undefined && { s: m.shots }),
    ...(m.rearFacing === true && { r: 1 }),
  }));
  const critSlots: Record<string, readonly unknown[]> = {};
  for (const loc of LOCATIONS) {
    critSlots[LOC_CODES[loc]] = def.critSlots[loc].map((slot) => {
      switch (slot.kind) {
        case "empty":
          return { k: KIND_IDS.empty };
        case "weapon":
          return {
            k: KIND_IDS.weapon,
            w: slot.weapon,
            ...(slot.rearFacing === true && { r: 1 }),
          };
        case "ammo":
          return { k: KIND_IDS.ammo, w: slot.weapon };
        case "structure":
          return {
            k: KIND_IDS.structure,
            n: (CRIT_STRUCTURE_NAMES as readonly string[]).indexOf(slot.name),
          };
        case "soak":
          return { k: KIND_IDS.soak, n: (CRIT_SOAK_NAMES as readonly string[]).indexOf(slot.name) };
        default:
          throw new Error(
            `encodeMechDef: unknown slot kind ${JSON.stringify((slot as { kind: string }).kind)}`,
          );
      }
    });
  }
  const wire: Record<string, unknown> = {
    v: WIRE_VERSION,
    w: def.walking,
    r: def.running,
    j: def.jumping,
    a: armor,
    p: weapons,
    c: critSlots,
    h: { t: def.heatsink.type === "double" ? 1 : 0, c: def.heatsink.count },
    s: def.source,
  };
  return JSON.stringify(wire);
}

/**
 * Decode one packed wire line into a raw `MechDef`, combining it with the
 * manifest identity (the wire carries no `model`/`name`/`techBase`/
 * `tonnage`). Full rule validation happens in `registerMech` via
 * `validateMechDef`.
 */
export function decodeMechLine(line: string, identity: MechIdentity): MechDef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new Error("Invalid mech line: not JSON");
  }
  if (!isRecord(parsed) || parsed.v !== WIRE_VERSION) {
    throw new Error("Invalid mech line: expected a version 1 wire object");
  }
  const failUnless = (cond: boolean, msg: string): void => {
    if (!cond) fail(msg);
  };
  const { w, r, j, a, p, c, h, s } = parsed;
  failUnless(Number.isInteger(w), "bad walking");
  failUnless(Number.isInteger(r), "bad running");
  failUnless(Number.isInteger(j), "bad jumping");
  failUnless(isRecord(a), "bad armor");
  failUnless(Array.isArray(p), "bad weapons");
  failUnless(isRecord(c), "bad critSlots");
  failUnless(isRecord(h), "bad heatsink");
  failUnless(typeof s === "string", "missing source");

  const armor: Record<string, number> = {};
  for (const [code, value] of Object.entries(a as Record<string, unknown>)) {
    const loc = CODE_LOCS[code];
    failUnless(loc !== undefined && Number.isInteger(value), `bad armor key ${code}`);
    armor[loc as string] = value as number;
  }
  const weapons = (p as readonly unknown[]).map((raw) => {
    failUnless(isRecord(raw), "bad weapon mount");
    const mount = raw as Record<string, unknown>;
    const loc = CODE_LOCS[mount.l as string];
    failUnless(typeof mount.w === "string" && loc !== undefined, "bad weapon mount");
    failUnless(
      mount.s === undefined || (Number.isInteger(mount.s) && (mount.s as number) > 0),
      "bad weapon shots",
    );
    return {
      weapon: mount.w as string,
      location: loc as Location,
      ...(mount.s !== undefined && { shots: mount.s as number }),
      ...(mount.r === 1 && { rearFacing: true as const }),
    };
  });
  const critSlots: Record<string, readonly unknown[]> = {};
  for (const loc of LOCATIONS) {
    const rawSlots = (c as Record<string, unknown>)[LOC_CODES[loc]];
    failUnless(Array.isArray(rawSlots), `bad critSlots for ${loc}`);
    critSlots[loc] = (rawSlots as readonly unknown[]).map((raw) => {
      failUnless(isRecord(raw), "bad crit slot");
      const slot = raw as Record<string, unknown>;
      switch (slot.k) {
        case KIND_IDS.empty:
          return { kind: "empty" } as const;
        case KIND_IDS.weapon:
          failUnless(typeof slot.w === "string", "bad weapon slot");
          return {
            kind: "weapon" as const,
            weapon: slot.w as string,
            ...(slot.r === 1 && { rearFacing: true as const }),
          };
        case KIND_IDS.ammo:
          failUnless(typeof slot.w === "string", "bad ammo slot");
          return { kind: "ammo" as const, weapon: slot.w as string };
        case KIND_IDS.structure: {
          const name = CRIT_STRUCTURE_NAMES[slot.n as number];
          failUnless(typeof name === "string", "bad structure slot");
          return { kind: "structure" as const, name };
        }
        case KIND_IDS.soak: {
          const name = CRIT_SOAK_NAMES[slot.n as number];
          failUnless(typeof name === "string", "bad soak slot");
          return { kind: "soak" as const, name };
        }
        default:
          return fail("bad crit slot kind");
      }
    });
  }
  const hsType = (h as Record<string, unknown>).t;
  failUnless(hsType === 0 || hsType === 1, "bad heatsink type");
  const hsCount = (h as Record<string, unknown>).c;
  failUnless(Number.isInteger(hsCount), "bad heatsink count");
  const heatsink: HeatSinkConfig = {
    type: hsType === 1 ? "double" : "single",
    count: hsCount as number,
  };
  return {
    model: identity.model,
    name: identity.name,
    ...(identity.clanName !== undefined && { clanName: identity.clanName }),
    tonnage: identity.tonnage,
    weightClass: weightClassForTonnage(identity.tonnage),
    techBase: identity.techBase,
    walking: w as number,
    running: r as number,
    jumping: j as number,
    armor: armor as MechDef["armor"],
    weapons,
    critSlots: critSlots as unknown as CritSlots,
    heatsink,
    source: s as string,
  };
}
