/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GLYPH_BLOCKS } from "../web/avatar/avatar.glyphs";
import {
  applyOverrides,
  BLANK,
  clearPart,
  formatOverrides,
  isAllowedGlyph,
  parseOverrides,
  partOverrides,
  SLOTS,
  type SlotId,
} from "../web/avatar/avatar.override";
import { parseFind } from "../web/avatar/avatar.picker";
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
} from "../web/avatar/avatar.slotmap";
import { buildAvatarQuery, parseAvatarQuery, parseGlyphParam } from "../web/avatar/avatar.url";

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

describe("avatar-override", () => {
  // head, shoulder, torso, arms, legs
  const PARTS = ["╭╮", "⎧⎫", "()", "╙╜", "╜╙"];

  describe("avatar overrides", () => {
    it("maps R slots to screen left (data[0]) and L slots to screen right", () => {
      expect(applyOverrides(PARTS, { RH: "A", LH: "B" })[0]).toBe("AB");
      expect(applyOverrides(PARTS, { RS: "A", LA: "B" })).toEqual(["╭╮", "A⎫", "()", "╙B", "╜╙"]);
      expect(applyOverrides(PARTS, { RT: "x", LL: "y" })).toEqual(["╭╮", "⎧⎫", "x)", "╙╜", "╜y"]);
    });

    it("has ten slots, two per part", () => {
      expect(SLOTS).toHaveLength(10);
      for (let part = 0; part < 5; part++) {
        expect(SLOTS.filter((s) => s.part === part).map((s) => s.side)).toEqual([0, 1]);
      }
    });

    it("layers the preview over saved overrides and can skip one part", () => {
      const ovr = { RH: "A", LT: "B" };
      expect(applyOverrides(PARTS, ovr, { slot: "RH", ch: "Z" })[0]).toBe("Z╮");
      expect(applyOverrides(PARTS, ovr, { slot: "RH", ch: "Z" }, 0)[0]).toBe("╭╮");
      expect(applyOverrides(PARTS, ovr, null, 0)[2]).toBe("(B");
    });

    it("clears only the given part", () => {
      expect(clearPart({ RH: "A", LH: "B", RA: "C" }, 0)).toEqual({ RA: "C" });
    });

    it("lists a part's overrides in slot order", () => {
      expect(
        partOverrides({ LA: "b", RA: "a", RH: "h" }, 3).map(([s, ch]) => `${s.id}${ch}`),
      ).toEqual(["RAa", "LAb"]);
    });

    it("only allows single glyphs the subset font has", () => {
      expect(isAllowedGlyph("☢")).toBe(true);
      expect(isAllowedGlyph("┢")).toBe(true);
      expect(isAllowedGlyph(BLANK)).toBe(true);
      expect(isAllowedGlyph("가")).toBe(false); // wide, not in font
      expect(isAllowedGlyph(" ")).toBe(false); // space-like, picker hides it
      expect(isAllowedGlyph("ab")).toBe(false);
      expect(isAllowedGlyph("")).toBe(false);
    });

    it("parses saved overrides, dropping unknown slots and bad glyphs", () => {
      expect(parseOverrides({ RH: "☢", XX: "a", LH: "가", RA: "ab", LA: 3, RL: " " })).toEqual({
        RH: "☢",
        RL: " ",
      });
      expect(parseOverrides(undefined)).toEqual({});
      expect(parseOverrides("RH")).toEqual({});
    });

    it("formats the export line in slot order, blank as its code point", () => {
      expect(formatOverrides({ LA: "⎬", RH: "☢", RL: BLANK })).toBe("RH=☢ LA=⎬ RL=U+0020");
      expect(formatOverrides({})).toBe("");
    });
  });

  describe("picker find box", () => {
    it("accepts a pasted character or U+XXXX", () => {
      expect(parseFind("☢")).toBe("☢");
      expect(parseFind(" U+2622 ")).toBe("☢");
      expect(parseFind("u+25a0")).toBe("■");
      expect(parseFind("U+26")).toBeNull();
      expect(parseFind("ab")).toBeNull();
    });
  });
});

describe("avatar-url", () => {
  const PARTS = [
    { key: "head", names: ["sr", "sq"] },
    { key: "shoulder", names: ["no", "rn"] },
    { key: "torso", names: ["rs", "bt"] },
    { key: "arms", names: ["ss", "pr"] },
    { key: "legs", names: ["ss", "sf"] },
  ];

  describe("avatar URL params", () => {
    it("returns null when no avatar params are present", () => {
      expect(parseAvatarQuery("", PARTS)).toBeNull();
      expect(parseAvatarQuery("?foo=1", PARTS)).toBeNull();
    });

    it("reads variants by name, defaulting the parts it leaves out", () => {
      const s = parseAvatarQuery("?head=sq&torso=bt", PARTS)!;
      expect(s.idx).toEqual([1, 0, 1, 0, 0]);
      expect(s.ovr).toEqual({});
    });

    it("reads overrides as hex code points or literal characters", () => {
      const s = parseAvatarQuery(`?rh=2622&la=23AC&rl=0020&lt=${encodeURIComponent("☢")}`, PARTS)!;
      expect(s.ovr).toEqual({ RH: "☢", LA: "⎬", RL: " ", LT: "☢" });
    });

    it("ignores unknown variants and glyphs the font lacks", () => {
      const s = parseAvatarQuery("?head=zz&rh=ac00&lh=ab&ra=2622", PARTS)!;
      expect(s.idx[0]).toBe(0);
      expect(s.ovr).toEqual({ RA: "☢" });
      expect(s.ignored).toEqual(["head=zz", "rh=ac00", "lh=ab"]);
    });

    it("keeps an override next to a variant param for the same part", () => {
      expect(parseAvatarQuery("?torso=bt&rt=2622", PARTS)!.ovr).toEqual({ RT: "☢" });
    });

    it("round-trips through buildAvatarQuery", () => {
      const q = buildAvatarQuery(PARTS, [1, 1, 0, 1, 0], { RH: "☢", LL: " " });
      expect(q).toBe("head=sq&shoulder=rn&torso=rs&arms=pr&legs=ss&rh=2622&ll=0020");
      const s = parseAvatarQuery(`?${q}`, PARTS)!;
      expect(s.idx).toEqual([1, 1, 0, 1, 0]);
      expect(s.ovr).toEqual({ RH: "☢", LL: " " });
    });

    it("parses single glyph values", () => {
      expect(parseGlyphParam("2")).toBe("2");
      expect(parseGlyphParam("110000")).toBeNull();
      expect(parseGlyphParam("")).toBeNull();
    });
  });
});

describe("avatar-glyphs", () => {
  const CSS = readFileSync(new URL("../web/bt10x.css", import.meta.url), "utf8");

  function fontRange(): Set<number> {
    const m = /unicode-range:([^;]+);/.exec(CSS);
    const out = new Set<number>();
    for (const part of m![1]!.split(",")) {
      const [lo, hi] = part.trim().replace(/^U\+/, "").split("-");
      const a = Number.parseInt(lo!, 16);
      const b = hi === undefined ? a : Number.parseInt(hi, 16);
      for (let cp = a; cp <= b; cp++) out.add(cp);
    }
    return out;
  }

  describe("avatar glyph list", () => {
    it("only offers glyphs the subset font maps", () => {
      const font = fontRange();
      for (const block of GLYPH_BLOCKS)
        for (const [lo, hi] of block.ranges)
          for (let cp = lo; cp <= hi; cp++)
            expect(font.has(cp), `${block.name} U+${cp.toString(16)}`).toBe(true);
    });

    it("hides spaces and controls", () => {
      for (const block of GLYPH_BLOCKS)
        for (const [lo, hi] of block.ranges)
          for (let cp = lo; cp <= hi; cp++)
            expect(String.fromCodePoint(cp), `U+${cp.toString(16)}`).not.toMatch(/[\p{Z}\p{C}]/u);
    });

    it("has distinct, non-empty groups", () => {
      const names = GLYPH_BLOCKS.map((b) => b.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain("Box Drawing");
      for (const b of GLYPH_BLOCKS) expect(b.ranges.length).toBeGreaterThan(0);
    });
  });
});
