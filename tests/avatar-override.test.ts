import { describe, expect, it } from "vitest";
import {
  applyOverrides,
  BLANK,
  clearPart,
  formatOverrides,
  isAllowedGlyph,
  parseOverrides,
  partOverrides,
  SLOTS,
} from "../web/avatar/avatar.override";
import { parseFind } from "../web/avatar/avatar.picker";

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
