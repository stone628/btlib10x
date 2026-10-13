import type { Location } from "../core/types";
import { LOCATIONS } from "../core/types";
import type { CritSlots, HeatSinkConfig, MechDef, RearArmorKey } from "./mech.schema";
import { CRIT_SOAK_NAMES, CRIT_STRUCTURE_NAMES, weightClassForTonnage } from "./mech.schema";
import { decodeRelaxed, encodeRelaxed } from "./relaxed-json";

/**
 * Compact wire form of a `MechDef` body for the packed catalog
 * (`data/btlib10x.jsonl`).
 *
 * Lines are relaxed JSON (`relaxed-json.ts`: unquoted identifier keys).
 * Short keys regardless of transport compression: object keys shrink to 1-2
 * chars and closed vocabularies (slot kinds, structure/soak names,
 * heat-sink type, locations) become small ints. Identity
 * (`model`/`name`/`techBase`/`tonnage`/`intro`, plus optional `clanName`/`callsign`) is NOT on
 * the wire — the manifest entry already carries it, so `decodeMechLine`
 * takes it as a second argument and each sheet is single-sourced.
 * `weightClass` is omitted too (restored with `weightClassForTonnage`).
 * Myomer rides as numeric `y` (1 = Standard, 2 = Triple Strength Myomer);
 * absent `y` on old v1 lines decodes as Standard.
 * Open vocabularies (chassis names, weapon names) are interned in the
 * catalog string table (line 0 of the JSONL file, a bare JSON string
 * array) and referenced on the wire as the numeric table index; the
 * manifest `n` and every weapon-name occurrence (`p[].w`, weapon/ammo
 * crit-slot `w`) use this form. Verbatim strings are rejected.
 *
 * `WIRE_VERSION` gates the format; `decodeMechLine` rejects anything else.
 * Table order below is wire-stable: `CRIT_STRUCTURE_NAMES` /
 * `CRIT_SOAK_NAMES` are append-only once packed lines exist.
 */
export const WIRE_VERSION = 1;

/** Shared string table: chassis names + weapon names, first-seen pack order. */
export type MechStringTable = readonly string[];

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

/** Myomer wire ids: 1 = Standard, 2 = Triple Strength Myomer. */
const MYOMER_IDS = { Standard: 1, "Triple Strength Myomer": 2 } as const;

const ID_MYOMERS = { 1: "Standard", 2: "Triple Strength Myomer" } as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(msg: string): never {
  throw new Error(`Invalid mech line: ${msg}`);
}

/**
 * Intern `value` in `strings` (first-seen order) and return its wire ref
 * (the table index). `strings` is mutated: encoders thread one shared array
 * across every sheet so indices are catalog-global.
 */
export function internString(strings: string[], value: string): number {
  let idx = strings.indexOf(value);
  if (idx < 0) {
    idx = strings.length;
    strings.push(value);
  }
  return idx;
}

/** Resolve a wire string ref: a numeric index into the table. */
export function resolveStringRef(strings: MechStringTable, raw: unknown, what: string): string {
  if (typeof raw !== "number" || !Number.isInteger(raw)) fail(`bad ${what} reference`);
  const value = strings[raw];
  if (value === undefined) fail(`${what} reference ${raw} out of range`);
  return value;
}

/** Identity half of a sheet: carried by the manifest entry, never the wire line. */
export interface MechIdentity {
  readonly model: string;
  readonly name: string;
  readonly techBase: string;
  readonly tonnage: number;
  readonly intro: number;
  readonly clanName?: string;
  readonly callsign?: string;
}

/** Encode a canonical `MechDef` into one minified JSONL line (identity omitted). Weapon names are interned in `strings` (mutated first-seen) and emitted as numeric indices. Wire mirror lives in `scripts/pack-catalog.mjs`. */
export function encodeMechDef(def: MechDef, strings: string[] = []): string {
  const armor: Record<string, number> = {};
  for (const [key, value] of Object.entries(def.armor)) {
    armor[LOC_CODES[key as Location | RearArmorKey]] = value as number;
  }
  const weapons = def.weapons.map((m) => ({
    w: internString(strings, m.weapon),
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
            w: internString(strings, slot.weapon),
            ...(slot.rearFacing === true && { r: 1 }),
          };
        case "ammo":
          return { k: KIND_IDS.ammo, w: internString(strings, slot.weapon) };
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
    y: MYOMER_IDS[def.myomer],
  };
  return encodeRelaxed(wire);
}

/**
 * Decode one packed wire line into a raw `MechDef`, combining it with the
 * manifest identity (the wire carries no `model`/`name`/`techBase`/
 * `tonnage`/`intro`). Weapon-name numeric refs resolve against `strings` (the
 * catalog line-0 table). Full rule
 * validation happens in `registerMech` via `validateMechDef`.
 */
export function decodeMechLine(
  line: string,
  identity: MechIdentity,
  strings: MechStringTable = [],
): MechDef {
  let parsed: unknown;
  try {
    parsed = decodeRelaxed(line);
  } catch {
    throw new Error("Invalid mech line: not JSON");
  }
  if (!isRecord(parsed) || parsed.v !== WIRE_VERSION) {
    throw new Error("Invalid mech line: expected a version 1 wire object");
  }
  const failUnless = (cond: boolean, msg: string): void => {
    if (!cond) fail(msg);
  };
  const { w, r, j, a, p, c, h } = parsed;
  failUnless(Number.isInteger(w), "bad walking");
  failUnless(Number.isInteger(r), "bad running");
  failUnless(Number.isInteger(j), "bad jumping");
  failUnless(isRecord(a), "bad armor");
  failUnless(Array.isArray(p), "bad weapons");
  failUnless(isRecord(c), "bad critSlots");
  failUnless(isRecord(h), "bad heatsink");
  if ("s" in parsed) fail("stale source key");
  // `y` (myomer) is optional so v1 lines packed before myomer existed still
  // decode; missing means Standard.
  const yRaw = (parsed as Record<string, unknown>).y;
  failUnless(yRaw === undefined || yRaw === 1 || yRaw === 2, "bad myomer");
  const myomer = ID_MYOMERS[(yRaw ?? 1) as 1 | 2];

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
    failUnless(typeof mount.w === "number" && loc !== undefined, "bad weapon mount");
    failUnless(
      mount.s === undefined || (Number.isInteger(mount.s) && (mount.s as number) > 0),
      "bad weapon shots",
    );
    return {
      weapon: resolveStringRef(strings, mount.w, "weapon"),
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
          failUnless(typeof slot.w === "number", "bad weapon slot");
          return {
            kind: "weapon" as const,
            weapon: resolveStringRef(strings, slot.w, "weapon slot"),
            ...(slot.r === 1 && { rearFacing: true as const }),
          };
        case KIND_IDS.ammo:
          failUnless(typeof slot.w === "number", "bad ammo slot");
          return {
            kind: "ammo" as const,
            weapon: resolveStringRef(strings, slot.w, "ammo slot"),
          };
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
    ...(identity.callsign !== undefined && { callsign: identity.callsign }),
    tonnage: identity.tonnage,
    intro: identity.intro,
    weightClass: weightClassForTonnage(identity.tonnage),
    techBase: identity.techBase,
    walking: w as number,
    running: r as number,
    jumping: j as number,
    armor: armor as MechDef["armor"],
    weapons,
    critSlots: critSlots as unknown as CritSlots,
    heatsink,
    myomer,
  };
}
