import { TERRAIN_TYPES, type TerrainType } from "../core/types";
import type { MapDefSrc } from "./map.schema";

/**
 * Compact wire form of `MapDefSrc` for the unified catalog
 * (`data/btlib10x.jsonl`), symmetric with `mech.codec.ts`: short keys and a
 * terrain-type int enum over the closed `TERRAIN_TYPES` vocabulary.
 * `WIRE_VERSION` stays 1 alongside the mech wire (nothing ever deployed).
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
  return JSON.stringify({
    v: MAP_WIRE_VERSION,
    n: src.name,
    w: src.width,
    h: src.height,
    t: src.terrain.map((hex) => ({
      c: hex.col,
      r: hex.row,
      t: (TERRAIN_TYPES as readonly string[]).indexOf(hex.type),
      ...(hex.level !== undefined && { l: hex.level }),
    })),
  });
}

/** Decode one packed map line into a raw `MapDefSrc`. Full validation happens in `registerMap(s)` via `validateMapDef`. */
export function decodeMapLine(line: string): MapDefSrc {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new Error("Invalid map line: not JSON");
  }
  if (!isRecord(parsed) || parsed.v !== MAP_WIRE_VERSION) {
    throw new Error("Invalid map line: expected a versioned map object");
  }
  const failUnless = (cond: boolean, msg: string): void => {
    if (!cond) fail(msg);
  };
  const { n, w, h, t } = parsed;
  failUnless(typeof n === "string" && n.length > 0, "missing name");
  failUnless(Number.isInteger(w) && (w as number) > 0, "bad width");
  failUnless(Number.isInteger(h) && (h as number) > 0, "bad height");
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
  return { name: n as string, width: w as number, height: h as number, terrain };
}
