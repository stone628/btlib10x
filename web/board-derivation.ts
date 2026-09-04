import type { HexGrid, TerrainHexDef } from "btlib10x";
import type { CharStyle } from "./render.js";
import { TERRAIN_GLYPHS, TERRAIN_STYLES } from "./renderer.text.js";

/**
 * Derive per-terrain `CharStyle` keyed by `"col,row"` (non-clear cells only)
 * from a flat `HexCell[]` grid.
 */
export function deriveTerrainStyles(grid: HexGrid): Record<string, CharStyle> | undefined {
  const m: Record<string, CharStyle> = {};
  const cells = grid.cells;
  const width = grid.width;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (cell.terrain !== "clear") {
      const key = `${(i % width) + 1},${Math.floor(i / width) + 1}`;
      const st = TERRAIN_STYLES[cell.terrain];
      if (st !== undefined) m[key] = st;
    }
  }
  return Object.keys(m).length > 0 ? m : undefined;
}

/**
 * Derive terrain mark glyphs keyed by `"col,row"` (non-clear cells only)
 * from a flat `HexCell[]` grid.
 */
export function deriveTerrainMarks(grid: HexGrid): Record<string, string> | undefined {
  const m: Record<string, string> = {};
  const cells = grid.cells;
  const width = grid.width;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (cell.terrain === "clear") continue;
    const key = `${(i % width) + 1},${Math.floor(i / width) + 1}`;
    const g = TERRAIN_GLYPHS[cell.terrain];
    if (g !== undefined) m[key] = g;
  }
  return Object.keys(m).length > 0 ? m : undefined;
}

/**
 * Derive non-zero elevation entries keyed by `"col,row"` from a flat
 * `HexCell[]` grid.
 */
export function deriveElevations(grid: HexGrid): Record<string, number> | undefined {
  const m: Record<string, number> = {};
  const cells = grid.cells;
  const width = grid.width;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (cell.level !== 0) {
      m[`${(i % width) + 1},${Math.floor(i / width) + 1}`] = cell.level;
    }
  }
  return Object.keys(m).length > 0 ? m : undefined;
}

/**
 * Derive terrain mark glyphs keyed by `"col,row"` from
 * {@link TerrainHexDef} entries (map display).
 */
export function deriveMapMarks(
  terrain: readonly TerrainHexDef[],
): Record<string, string> | undefined {
  const m: Record<string, string> = {};
  for (const { col, row, type } of terrain) {
    const glyph = TERRAIN_GLYPHS[type];
    if (glyph !== undefined) m[`${col},${row}`] = glyph;
  }
  return Object.keys(m).length > 0 ? m : undefined;
}

/**
 * Derive per-terrain `CharStyle` keyed by `"col,row"` from
 * {@link TerrainHexDef} entries (map display).
 */
export function deriveMapStyles(
  terrain: readonly TerrainHexDef[],
): Record<string, CharStyle> | undefined {
  const m: Record<string, CharStyle> = {};
  for (const { col, row, type } of terrain) {
    const st = TERRAIN_STYLES[type];
    if (st !== undefined) m[`${col},${row}`] = st;
  }
  return Object.keys(m).length > 0 ? m : undefined;
}
