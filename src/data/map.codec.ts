import { TERRAIN_TYPES, type TerrainType } from "../core/types";
import type { MapDefSrc } from "./map.schema";
import { decodeRelaxed, encodeRelaxed } from "./relaxed-json";

/**
 * Compact wire form of `MapDefSrc` for the unified catalog
 * (`data/btlib10x.jsonl`), symmetric with `mech.codec.ts`: short keys and a
 * terrain-type int enum over the closed `TERRAIN_TYPES` vocabulary.
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
  return { name: identity.name, width: identity.width, height: identity.height, terrain };
}
