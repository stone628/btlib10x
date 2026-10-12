/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GLYPH_BLOCKS } from "../web/avatar.glyphs";

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
