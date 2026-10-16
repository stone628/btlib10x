import {
  isLimb,
  type LimbLocation,
  type Location,
  TERRAIN_TYPES,
  type TerrainType,
} from "../core/types";
import type { MapClubSrc, MapDefSrc, MapWreckageSrc } from "./map.schema";
import { CODE_LOCS, LOC_CODES } from "./mech.codec";
import { decodeRelaxed, encodeRelaxed } from "./relaxed-json";

/**
 * Compact wire form of `MapDefSrc` for the unified catalog
 * (`data/btlib10x.jsonl`), symmetric with `mech.codec.ts`: short keys and a
 * terrain-type int enum over the closed `TERRAIN_TYPES` vocabulary. Clubs
 * (`c`, limb as its mech-wire `LOC_CODES` code) and wreckage (`w`) are
 * optional keys, omitted when empty; their `m` is the plain model string,
 * not a string-table index, since a map may name a 'Mech from another pack.
 * `WIRE_VERSION` stays 1 alongside the mech wire (nothing ever deployed).
 * Identity (`name`/`width`/`height`) is NOT on the wire — the manifest entry
 * already carries it, so `decodeMapLine` takes it as a second argument.
 */
export const MAP_WIRE_VERSION = 1;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(msg: string): never {
  throw new Error(`Invalid map line: ${msg}`);
}

/** Encode a canonical map source into one minified JSONL line. Wire mirror lives in `scripts/pack-catalog.mjs`. */
export function encodeMapDef(src: MapDefSrc): string {
  return encodeRelaxed({
    v: MAP_WIRE_VERSION,
    t: src.terrain.map((hex) => ({
      c: hex.col,
      r: hex.row,
      t: (TERRAIN_TYPES as readonly string[]).indexOf(hex.type),
      ...(hex.level !== undefined && { l: hex.level }),
    })),
    ...(src.clubs !== undefined &&
      src.clubs.length > 0 && {
        c: src.clubs.map((e) => ({
          c: e.col,
          r: e.row,
          m: e.model,
          l: LOC_CODES[e.limb],
        })),
      }),
    ...(src.wreckage !== undefined &&
      src.wreckage.length > 0 && {
        w: src.wreckage.map((e) => ({ c: e.col, r: e.row, m: e.model })),
      }),
  });
}

/** Identity half of a map: carried by the manifest entry, never the wire line. */
export interface MapIdentity {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

/** Decode one packed map line into a raw `MapDefSrc`, combining it with the manifest identity. Full validation happens in `registerMap(s)` via `validateMapDef`. */
export function decodeMapLine(line: string, identity: MapIdentity): MapDefSrc {
  let parsed: unknown;
  try {
    parsed = decodeRelaxed(line);
  } catch {
    throw new Error("Invalid map line: not JSON");
  }
  if (!isRecord(parsed) || parsed.v !== MAP_WIRE_VERSION) {
    throw new Error("Invalid map line: expected a versioned map object");
  }
  const failUnless = (cond: boolean, msg: string): void => {
    if (!cond) fail(msg);
  };
  const { t } = parsed;
  failUnless(Array.isArray(t), "bad terrain");
  const terrain = (t as readonly unknown[]).map((raw) => {
    failUnless(isRecord(raw), "bad terrain hex");
    const hex = raw as Record<string, unknown>;
    const type = TERRAIN_TYPES[hex.t as number];
    failUnless(Number.isInteger(hex.c) && Number.isInteger(hex.r), "bad terrain hex coords");
    failUnless(typeof type === "string", "bad terrain hex type");
    failUnless(
      hex.l === undefined || (Number.isInteger(hex.l) && (hex.l as number) >= 0),
      "bad terrain hex level",
    );
    return {
      col: hex.c as number,
      row: hex.r as number,
      type: type as TerrainType,
      ...(hex.l !== undefined && { level: hex.l as number }),
    };
  });
  const placed = (raw: unknown, what: string): { col: number; row: number; model: string } => {
    failUnless(isRecord(raw), `bad ${what}`);
    const e = raw as Record<string, unknown>;
    failUnless(Number.isInteger(e.c) && Number.isInteger(e.r), `bad ${what} coords`);
    failUnless(typeof e.m === "string", `bad ${what} model`);
    return { col: e.c as number, row: e.r as number, model: e.m as string };
  };
  const { c, w } = parsed;
  failUnless(c === undefined || Array.isArray(c), "bad clubs");
  failUnless(w === undefined || Array.isArray(w), "bad wreckage");
  const clubs = ((c ?? []) as readonly unknown[]).map((raw): MapClubSrc => {
    const at = placed(raw, "club");
    const code = (raw as Record<string, unknown>).l;
    const limb = typeof code === "string" ? CODE_LOCS[code] : undefined;
    failUnless(limb !== undefined && isLimb(limb as Location), "bad club limb");
    return { ...at, limb: limb as LimbLocation };
  });
  const wreckage = ((w ?? []) as readonly unknown[]).map(
    (raw): MapWreckageSrc => placed(raw, "wreckage"),
  );
  return {
    name: identity.name,
    width: identity.width,
    height: identity.height,
    terrain,
    ...(clubs.length > 0 && { clubs }),
    ...(wreckage.length > 0 && { wreckage }),
  };
}
