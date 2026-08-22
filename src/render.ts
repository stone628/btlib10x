import type { BattleState } from "./rules/game.js";

/**
 * ASCII map renderer for console output.
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
 * odd-q flat-top grid. Removed units are omitted.
 */
const HEX_WIDTH = 7;
/** Horizontal distance between column origins; lets diagonal edges interlock. */
const COL_STRIDE = 5;
const ROW_STRIDE = 4;
const STAGGER = 2;

function pad2(n: number): string {
  return String(n).padStart(2);
}

export function renderBattle(state: BattleState, width?: number, height?: number): string {
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

  const cols = Math.max(1, width ?? maxCol + 1);
  const rows = Math.max(1, height ?? maxRow + 1);

  const occupants = new Map<string, string>();
  for (const unit of Object.values(state.units)) {
    if (unit.removed) continue;
    occupants.set(`${unit.position.col},${unit.position.row}`, unit.id);
  }

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
      const raw = occupants.get(`${col},${row}`);
      const id = raw === undefined ? "   " : raw.padEnd(3).slice(0, 3);
      stampBorder(col * COL_STRIDE, y);
      stamp(col * COL_STRIDE, y + 1, ` /${id}\\ `);
      stamp(col * COL_STRIDE, y + 2, `<${pad2(col + 1)},${String(row + 1).padEnd(2)}>`);
      stamp(col * COL_STRIDE, y + 3, " \\   / ");
      stampBorder(col * COL_STRIDE, y + ROW_STRIDE);
    }
  }

  return canvas.map((line) => line.join("").trimEnd()).join("\n");
}
