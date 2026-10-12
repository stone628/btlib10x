import { SLOTS, type SlotId } from "./avatar.override";

/**
 * The slot map: the final avatar with a labelled box per override slot,
 * wired to the avatar cell it controls. `?` marks where each box shows its
 * slot's glyph; the avatar interior (4×3 cells) is filled from the composed
 * avatar. The right half mirrors the left around the avatar's centre.
 */
export const SLOT_MAP_TEMPLATE: readonly string[] = [
  "    ┌─RH┬────────┐┌────────┬LH─┐    ",
  "    │ ? │┌─RS┐ ╔═╧╧═╗ ┌LS─┐│ ? │    ",
  "    └───┘│ ? ├─╢    ╟─┤ ? │└───┘    ",
  "┌─RA┐    └───┘╔╣    ╠╗└───┘    ┌LA─┐",
  "│ ? ├┬─RT╤════╝║    ║╚════╤LT─┬┤ ? │",
  "└───┘│ ? │┌─RL┐╚═╤╤═╝┌LL─┐│ ? │└───┘",
  "     └───┘│ ? ├──┘└──┤ ? │└───┘     ",
  "          └───┘      └───┘          ",
];

export const SLOT_MAP_COLS = 36;
export const SLOT_MAP_ROWS = SLOT_MAP_TEMPLATE.length;

/** Top-left of the 6×5 avatar box in the map. */
export const AVATAR_ORIGIN = { col: 15, line: 1 } as const;

export interface SlotPlace {
  /** Top-left corner of the slot's 5×3 box. */
  box: { col: number; line: number };
  /** The avatar interior cell it controls (1-based inside the border). */
  cell: { col: number; row: number };
}

export const BOX_W = 5;
export const BOX_H = 3;

export const SLOT_PLACES: Record<SlotId, SlotPlace> = {
  RH: { box: { col: 4, line: 0 }, cell: { col: 2, row: 1 } },
  LH: { box: { col: 27, line: 0 }, cell: { col: 3, row: 1 } },
  RS: { box: { col: 9, line: 1 }, cell: { col: 1, row: 1 } },
  LS: { box: { col: 22, line: 1 }, cell: { col: 4, row: 1 } },
  RA: { box: { col: 0, line: 3 }, cell: { col: 1, row: 2 } },
  LA: { box: { col: 31, line: 3 }, cell: { col: 4, row: 2 } },
  RT: { box: { col: 5, line: 4 }, cell: { col: 2, row: 2 } },
  LT: { box: { col: 26, line: 4 }, cell: { col: 3, row: 2 } },
  RL: { box: { col: 10, line: 5 }, cell: { col: 2, row: 3 } },
  LL: { box: { col: 21, line: 5 }, cell: { col: 3, row: 3 } },
};

/** Map position of a slot's avatar cell. */
export function cellPos(id: SlotId): { col: number; line: number } {
  const { cell } = SLOT_PLACES[id];
  return { col: AVATAR_ORIGIN.col + cell.col, line: AVATAR_ORIGIN.line + cell.row };
}

/**
 * The map as text: the avatar interior copied from `avatar` (the 5 lines of
 * `composeSelectedAvatar`) and each box's `?` replaced by its slot's glyph.
 */
export function slotMapLines(
  avatar: readonly string[],
  glyphs: Readonly<Record<SlotId, string>>,
): string[] {
  const grid = SLOT_MAP_TEMPLATE.map((l) => Array.from(l));
  for (let row = 1; row <= 3; row++) {
    const src = Array.from(avatar[row] ?? "");
    for (let col = 1; col <= 4; col++) {
      const line = grid[AVATAR_ORIGIN.line + row];
      if (line !== undefined) line[AVATAR_ORIGIN.col + col] = src[col] ?? " ";
    }
  }
  for (const s of SLOTS) {
    const { box } = SLOT_PLACES[s.id];
    const line = grid[box.line + 1];
    if (line !== undefined) line[box.col + 2] = glyphs[s.id];
  }
  return grid.map((l) => l.join(""));
}

/** The 3 text lines of one slot's box, cut from rendered map lines. */
export function boxLines(lines: readonly string[], id: SlotId): string[] {
  const { box } = SLOT_PLACES[id];
  return lines.slice(box.line, box.line + BOX_H).map((l) =>
    Array.from(l)
      .slice(box.col, box.col + BOX_W)
      .join(""),
  );
}

/** Map lines with every box area blanked, for the background text layer. */
export function withoutBoxes(lines: readonly string[]): string[] {
  const grid = lines.map((l) => Array.from(l));
  for (const s of SLOTS) {
    const { box } = SLOT_PLACES[s.id];
    for (let dy = 0; dy < BOX_H; dy++) {
      const line = grid[box.line + dy];
      if (line === undefined) continue;
      for (let dx = 0; dx < BOX_W; dx++) line[box.col + dx] = " ";
    }
  }
  return grid.map((l) => l.join(""));
}
