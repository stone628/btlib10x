import type { TerrainHexDef } from "./core/types.js";
import type { BattleState } from "./rules/game.js";

/**
 * ASCII board renderer for console output.
 *
 * Every hex is drawn as
 *
 *     ---
 *    /???\
 *   <XX,YY>
 *    \   /
 *     ---
 *
 * where `???` is the occupying unit's id clipped/padded to 3 characters and
 * `XX,YY` is the space-aligned 1-based column,row (col right-aligned, row
 * left-aligned). Horizontal borders default to `---`; where two hexes share
 * an edge (the border is stamped twice) they render as `===`, suggesting
 * tightly packed hexes. Odd columns sit half a hex lower, mirroring the
 * odd-q flat-top grid.
 */

/** Glyphs drawn inside hexes by terrain type (see renderMap). */
export const TERRAIN_GLYPHS: Readonly<Record<string, string>> = {
  lightWoods: "w",
  heavyWoods: "W",
};

const HEX_WIDTH = 7;
/** Horizontal distance between column origins; lets diagonal edges interlock. */
const COL_STRIDE = 5;
const ROW_STRIDE = 4;
const STAGGER = 2;

function pad2(n: number): string {
  return String(n).padStart(2);
}

/** Fit text into the 3-char hex cell; ids clip right-aligned, glyphs center. */
function fitCell(text: string): string {
  if (text.length >= 3) return text.slice(0, 3);
  const left = Math.floor((3 - text.length) / 2);
  return text.padStart(text.length + left).padEnd(3);
}

interface BoardInput {
  readonly cols: number;
  readonly rows: number;
  /** `"col,row"` (engine coords) -> cell text; later keys win via caller merge. */
  readonly cells: Readonly<Record<string, string>>;
}

function drawBoard({ cols, rows, cells }: BoardInput): string {
  const canvasRows = rows * ROW_STRIDE + (cols >= 2 ? STAGGER : 0) + 1;
  const canvasCols = (cols - 1) * COL_STRIDE + HEX_WIDTH;
  const canvas: string[][] = Array.from({ length: canvasRows }, () =>
    Array.from({ length: canvasCols }, () => " "),
  );

  // Overlay stamping: spaces never erase glyphs already on the canvas, so
  // neighboring hexes' edges nest tightly.
  const stamp = (x: number, y: number, text: string): void => {
    const line = canvas[y];
    if (!line) return;
    for (let i = 0; i < text.length && x + i < line.length; i++) {
      const ch = text[i]!;
      if (ch !== " ") line[x + i] = ch;
    }
  };

  // Borders are `---` unless another border already occupies the cell, in
  // which case the shared edge becomes `===`.
  const stampBorder = (x: number, y: number): void => {
    const line = canvas[y];
    if (!line) return;
    for (let i = x + 2; i <= x + 4 && i < line.length; i++) {
      line[i] = line[i] === " " ? "-" : "=";
    }
  };

  for (let col = 0; col < cols; col++) {
    const baseY = col % 2 === 1 ? STAGGER : 0;
    for (let row = 0; row < rows; row++) {
      const y = baseY + row * ROW_STRIDE;
      const cell = cells[`${col},${row}`];
      stampBorder(col * COL_STRIDE, y);
      stamp(col * COL_STRIDE, y + 1, ` /${cell === undefined ? "   " : fitCell(cell)}\\ `);
      stamp(col * COL_STRIDE, y + 2, `<${pad2(col + 1)},${String(row + 1).padEnd(2)}>`);
      stamp(col * COL_STRIDE, y + 3, " \\   / ");
      stampBorder(col * COL_STRIDE, y + ROW_STRIDE);
    }
  }

  return canvas.map((line) => line.join("").trimEnd()).join("\n");
}

/**
 * Render a static map sheet from non-clear terrain hex definitions
 * (engine coordinates) at the given size. Terrain hexes draw their
 * {@link TERRAIN_GLYPHS} marker; everything else is clear ground.
 */
export function renderMap(
  terrain: readonly TerrainHexDef[],
  width: number,
  height: number,
): string {
  const cells: Record<string, string> = {};
  for (const { col, row, type } of terrain) {
    const glyph = TERRAIN_GLYPHS[type];
    if (glyph !== undefined) cells[`${col},${row}`] = glyph;
  }
  return drawBoard({
    cols: Math.max(1, width),
    rows: Math.max(1, height),
    cells,
  });
}

/**
 * Render a battle: unit ids take precedence over hex contents. Removed units
 * are omitted; board bounds default to the units + terrain extent. The
 * optional `overlay` maps `"col,row"` keys to short glyphs (up to 3 chars)
 * drawn inside empty hexes — e.g. terrain markers.
 */
export function renderBattle(
  state: BattleState,
  width?: number,
  height?: number,
  overlay?: Readonly<Record<string, string>>,
): string {
  let maxCol = 0;
  let maxRow = 0;
  for (const unit of Object.values(state.units)) {
    if (unit.removed) continue;
    maxCol = Math.max(maxCol, unit.position.col);
    maxRow = Math.max(maxRow, unit.position.row);
  }
  for (const key of Object.keys(state.terrain)) {
    const parts = key.split(",");
    const c = Number(parts[0]);
    const r = Number(parts[1]);
    if (!Number.isNaN(c)) maxCol = Math.max(maxCol, c);
    if (!Number.isNaN(r)) maxRow = Math.max(maxRow, r);
  }

  const cells: Record<string, string> = {};
  if (overlay !== undefined) Object.assign(cells, overlay);
  for (const unit of Object.values(state.units)) {
    if (!unit.removed) cells[`${unit.position.col},${unit.position.row}`] = unit.id;
  }

  return drawBoard({
    cols: Math.max(1, width ?? maxCol + 1),
    rows: Math.max(1, height ?? maxRow + 1),
    cells,
  });
}
