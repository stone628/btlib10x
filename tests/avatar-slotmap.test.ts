import { describe, expect, it } from "vitest";
import { SLOTS, type SlotId } from "../web/avatar.override";
import {
  AVATAR_ORIGIN,
  BOX_H,
  BOX_W,
  boxLines,
  cellPos,
  SLOT_MAP_COLS,
  SLOT_MAP_TEMPLATE,
  SLOT_PLACES,
  slotMapLines,
  withoutBoxes,
} from "../web/avatar.slotmap";

const AVATAR = ["╔════╗", "║⎧╭╮⎫║", "║╙()╜║", "║ ╜╙ ║", "╚════╝"];
const MIRROR: Record<string, string> = {
  "┌": "┐",
  "┐": "┌",
  "└": "┘",
  "┘": "└",
  "├": "┤",
  "┤": "├",
  "╔": "╗",
  "╗": "╔",
  "╚": "╝",
  "╝": "╚",
  "╢": "╟",
  "╟": "╢",
  "╣": "╠",
  "╠": "╣",
};
const chars = (s: string) => Array.from(s);

function glyphs(): Record<SlotId, string> {
  const out = {} as Record<SlotId, string>;
  for (const s of SLOTS) out[s.id] = s.id.toLowerCase()[1]!;
  return out;
}

describe("avatar slot map", () => {
  it("is a 36-column grid", () => {
    for (const line of SLOT_MAP_TEMPLATE) expect(chars(line)).toHaveLength(SLOT_MAP_COLS);
  });

  it("mirrors the left half onto the right", () => {
    for (const line of SLOT_MAP_TEMPLATE) {
      const c = chars(line);
      for (let i = 0; i < SLOT_MAP_COLS / 2; i++) {
        const l = c[i]!;
        const r = c[SLOT_MAP_COLS - 1 - i]!;
        if (/[A-Z?]/.test(l) || /[A-Z?]/.test(r)) continue; // labels read left to right
        expect(r, `${line} col ${i}`).toBe(MIRROR[l] ?? l);
      }
    }
  });

  it("puts each slot's label and ? inside its box", () => {
    for (const s of SLOTS) {
      const [top, mid] = boxLines(SLOT_MAP_TEMPLATE, s.id);
      expect(top, s.id).toContain(s.id);
      expect(chars(mid!)[2], s.id).toBe("?");
      expect(chars(mid!)[0], s.id).toMatch(/[│├┤]/);
    }
  });

  it("boxes do not overlap each other or the avatar", () => {
    const taken = new Set<string>();
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 6; c++) taken.add(`${AVATAR_ORIGIN.col + c},${AVATAR_ORIGIN.line + r}`);
    for (const s of SLOTS) {
      const { box } = SLOT_PLACES[s.id];
      for (let dy = 0; dy < BOX_H; dy++)
        for (let dx = 0; dx < BOX_W; dx++) {
          const k = `${box.col + dx},${box.line + dy}`;
          expect(taken.has(k), `${s.id} at ${k}`).toBe(false);
          taken.add(k);
        }
    }
  });

  it("fills the avatar and each slot's glyph", () => {
    const lines = slotMapLines(AVATAR, glyphs());
    expect(lines[2]).toContain("╢⎧╭╮⎫╟");
    expect(lines[3]).toContain("╣╙()╜╠");
    expect(lines[4]).toContain("║ ╜╙ ║");
    expect(boxLines(lines, "RH")[1]).toBe("│ h │");
    expect(boxLines(lines, "LT")[1]).toBe("│ t │");
  });

  it("points each slot at the avatar cell holding its part's character", () => {
    const lines = slotMapLines(AVATAR, glyphs());
    const data = ["╭╮", "⎧⎫", "()", "╙╜", "╜╙"];
    for (const s of SLOTS) {
      const p = cellPos(s.id);
      expect(chars(lines[p.line]!)[p.col], s.id).toBe(data[s.part]![s.side]);
    }
  });

  it("blanks box areas for the background layer", () => {
    const bg = withoutBoxes(SLOT_MAP_TEMPLATE);
    expect(bg.join("")).not.toMatch(/[A-Z?]/);
    expect(chars(bg[0]!)).toHaveLength(SLOT_MAP_COLS);
  });
});
