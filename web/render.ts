// ---- Re-export from renderer.text.ts so callers only need `render.ts`. ----
// Everything value-level flows one way (render.ts → renderer.text.ts); the
// reverse edge (renderer.text.ts → render.ts) is type-only and erased at
// compile time, so there is no runtime module cycle.
import type { Facing } from "btlib10x";

export type { BoardRenderer, Canvas, HexContext } from "./renderer.text.js";
export {
  applyEdgeStyles,
  boardLegendText,
  boardToChars,
  boardToSpans,
  boardToText,
  cssGridRenderer,
  eachHex,
  GRID_GLYPHS,
  makeCanvas,
  styleClasses,
  TEAM_STYLES,
  textRenderer,
} from "./renderer.text.js";

import type { BoardRenderer } from "./renderer.text.js";
import { cssGridRenderer, textRenderer } from "./renderer.text.js";

// ---- common types ----

/** Named palette slots; the web layer maps these to CSS variables. */
export type ColorName = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" | "dim";

/** Per-character presentation hints for styled board output. */
export interface CharStyle {
  readonly fg?: ColorName | undefined;
  readonly bg?: ColorName | undefined;
  readonly bold?: boolean | undefined;
  readonly italic?: boolean | undefined;
  /** Web-only hook: raw CSS class (e.g. per-terrain scheme `t-lightWoods`). */
  readonly cls?: string | undefined;
}

/** A run of characters sharing one {@link CharStyle} within a board line. */
export interface Span {
  readonly text: string;
  readonly style?: CharStyle | undefined;
}

/**
 * Structured board: the flat text pieces plus optional per-hex style hints.
 * Keys are `"col,row"` in engine coordinates.
 */
export interface BoardModel {
  readonly cols: number;
  readonly rows: number;
  /** Absolute (1-based) column/row of the crop anchor. Hex at `(col,row)` renders at `(col - anchorCol, row - anchorRow)`. */
  readonly anchorCol: number;
  readonly anchorRow: number;
  /** Cell text drawn inside `/...\ ` (unit ids, overlay glyphs). */
  readonly cells: Readonly<Record<string, string>>;
  /** Glyphs drawn at the hex bottom center (e.g. terrain markers). */
  readonly marks: Readonly<Record<string, string>>;
  /** Per-hex ground elevation. */
  readonly elevations: Readonly<Record<string, number>>;
  /** Per-hex mech facing (`"col,row"` → {@link Facing}); drawn on the grid. */
  readonly facings: Readonly<Record<string, Facing>>;
  /**
   * Per-edge style keyed by `"col,row:facing"` — tints the grid edge where
   * that facing's arrow would be placed (e.g. team color on reachable hexes).
   */
  readonly edgeStyles: Readonly<Record<string, CharStyle>>;
  /** Style applied to a hex's characters: grid rows, belly parens and mark. */
  readonly styles: Readonly<Record<string, CharStyle>>;
  /** Style for just the occupant id inside `( )` (e.g. {@link TEAM_STYLES}). */
  readonly idStyles: Readonly<Record<string, CharStyle>>;
}

// ---- renderer supplier ----

const RENDERERS: Readonly<Record<string, BoardRenderer>> = {
  "css-grid": cssGridRenderer,
  text: textRenderer,
};

/** Return the named board renderer, or undefined if unknown. */
export function getBoardRenderer(name: string): BoardRenderer | undefined {
  return RENDERERS[name];
}

// ---- model builders (self-contained, re-exported from renderer.text.ts) ----

export {
  battleModel,
  mapModel,
  renderMap,
} from "./renderer.text.js";
