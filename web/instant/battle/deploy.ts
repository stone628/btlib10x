/**
 * Starting positions (TW p. 256, docs/INSTANT.md "Deployment"): both sides roll 2D6, the higher
 * result chooses a home map edge and the other side gets the opposite one.
 * Units enter along their home edge. The engine has no off-map units, so each
 * unit is placed on a home-edge hex before turn 1 and that first placement is
 * free (house rule).
 */
import type { Facing, HexCoord, MapDef, Rng, TerrainType } from "btlib10x";
import { createRng } from "../rng";

export type Edge = "north" | "south" | "west" | "east";
export const EDGES: readonly Edge[] = ["north", "south", "west", "east"];

export function oppositeEdge(e: Edge): Edge {
  return e === "north" ? "south" : e === "south" ? "north" : e === "west" ? "east" : "west";
}

/** Facing into the map from an edge. */
export function inwardFacing(e: Edge): Facing {
  return e === "north" ? "s" : e === "south" ? "n" : e === "west" ? "se" : "nw";
}

export function edgeHexes(map: Pick<MapDef, "width" | "height">, e: Edge): HexCoord[] {
  const out: HexCoord[] = [];
  if (e === "north" || e === "south") {
    const row = e === "north" ? 1 : map.height;
    for (let col = 1; col <= map.width; col++) out.push({ col, row });
  } else {
    const col = e === "west" ? 1 : map.width;
    for (let row = 1; row <= map.height; row++) out.push({ col, row });
  }
  return out;
}

export interface RollOff {
  readonly rolls: readonly (readonly [number, number])[];
  /** Side that chooses the home edge. */
  readonly winner: 1 | 2;
}

/** The set-up stream is salted off the seed, so the battle dice stay untouched. */
const SETUP_SALT = 0x5e7c0ff;

export function setupRng(seed: number): Rng {
  return createRng((seed ^ SETUP_SALT) >>> 0);
}

/** 2D6 each, ties re-rolled (TW p. 256). */
export function rollOff(rng: Rng): RollOff {
  const rolls: [number, number][] = [];
  for (;;) {
    const a = rng.d6() + rng.d6();
    const b = rng.d6() + rng.d6();
    rolls.push([a, b]);
    if (a !== b) return { rolls, winner: a > b ? 1 : 2 };
  }
}

function terrainAt(map: MapDef, hex: HexCoord): TerrainType {
  return map.terrain.find((h) => h.col === hex.col && h.row === hex.row)?.type ?? "clear";
}

/** Hexes a unit may be placed on: on the edge and unoccupied. Deep water is legal but last. */
export function placeable(map: MapDef, edge: Edge, occupied: ReadonlySet<string>): HexCoord[] {
  return edgeHexes(map, edge).filter((h) => !occupied.has(`${h.col},${h.row}`));
}

const PREFERENCE: Partial<Record<TerrainType, number>> = {
  lightWoods: 2,
  heavyWoods: 3,
  rough: 1,
  water2: -5,
  water3: -6,
};

/** Spread `count` units evenly along the edge, nudging toward cover and away from deep water. */
export function autoPlace(
  map: MapDef,
  edge: Edge,
  count: number,
  occupied: ReadonlySet<string>,
): HexCoord[] {
  const free = placeable(map, edge, occupied);
  const out: HexCoord[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < count && free.length > 0; i++) {
    const ideal = ((i + 0.5) / count) * free.length;
    let best: HexCoord | null = null;
    let bestScore = -Infinity;
    free.forEach((h, idx) => {
      const k = `${h.col},${h.row}`;
      if (taken.has(k)) return;
      const score = (PREFERENCE[terrainAt(map, h)] ?? 0) - Math.abs(idx + 0.5 - ideal);
      if (score > bestScore) {
        bestScore = score;
        best = h;
      }
    });
    if (best === null) break;
    const b: HexCoord = best;
    taken.add(`${b.col},${b.row}`);
    out.push(b);
  }
  return out;
}
