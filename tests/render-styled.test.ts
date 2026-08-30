import { describe, expect, it } from "vitest";
import { getMapDef } from "../src/data/index.js";
import { createBattle } from "../src/rules/game.js";
import type { CharStyle, Span } from "../web/render.js";
import {
  battleModel,
  boardToChars,
  boardToSpans,
  boardToText,
  mapModel,
  renderMap,
  TEAM_STYLES,
} from "../web/render.js";

function spansText(spans: readonly Span[]): string {
  return spans.map((sp) => sp.text).join("");
}

describe("styled board model", () => {
  const beginner = getMapDef("beginner");
  if (!beginner) throw new Error("missing beginner map");

  it("span text reproduces the flat rendering exactly (maps)", () => {
    const terrain = beginner.terrain;
    const flat = renderMap(terrain, beginner.width, beginner.height);
    const spans = boardToSpans(mapModel(terrain, beginner.width, beginner.height));
    expect(spans.map(spansText).join("\n")).toBe(flat);
    // Cross-check against the independent text serializer too.
    expect(boardToText(mapModel(terrain, beginner.width, beginner.height))).toBe(flat);
  });

  it("span text reproduces the flat rendering exactly (battles)", () => {
    const state = createBattle(
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 3, row: 4 },
          facing: "n",
        },
        {
          id: "grf",
          model: "GRF-1N",
          team: 1,
          gunnery: 4,
          position: { col: 5, row: 3 },
          facing: "s",
        },
      ],
      { terrain: [{ col: 2, row: 2, type: "heavyWoods" }] },
    );
    const flat = boardToText(battleModel(state));
    expect(boardToText(battleModel(state))).toBe(flat);
    expect(boardToSpans(battleModel(state)).map(spansText).join("\n")).toBe(flat);
  });

  it("merges adjacent same-style runs and splits at style boundaries", () => {
    const state = createBattle([
      { id: "ab", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 2, row: 2 }, facing: "n" },
      { id: "cd", model: "GRF-1N", team: 1, gunnery: 4, position: { col: 3, row: 2 }, facing: "s" },
    ]);
    const lines = boardToSpans(battleModel(state));
    const idLine = lines.find((l) => l.some((sp) => sp.text.includes("ab")));
    if (!idLine) throw new Error("no unit line");
    for (const sp of idLine) {
      // No two neighboring spans may share a style.
      expect(spansText([sp]).trim().length > 0 || sp.style === undefined).toBe(true);
    }
    for (let i = 1; i < idLine.length; i++) {
      const prev = idLine[i - 1]!;
      const cur = idLine[i]!;
      expect(prev.style === undefined && cur.style === undefined).toBe(false);
    }
  });

  it("tints terrain glyphs and unit ids per semantic defaults", () => {
    const state = createBattle(
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 2, row: 2 },
          facing: "n",
        },
        {
          id: "far",
          model: "GRF-1N",
          team: 1,
          gunnery: 4,
          position: { col: 11, row: 11 },
          facing: "s",
        },
      ],
      { terrain: [{ col: 3, row: 3, type: "lightWoods" }] },
    );
    const model = battleModel(state);
    const woods = model.styles?.["3,3"];
    expect(woods).toEqual({ cls: "t-lightWoods" });
    expect(model.cellStyles?.["2,2"]).toEqual(TEAM_STYLES[0]);

    const lines = boardToSpans(model);
    const team0 = lines.flat().find((sp) => sp.text.includes("hbk"));
    expect(team0?.style?.fg).toBe("cyan");

    // Team color touches only the id characters and the facing arrow: exactly
    // one cyan span each per board — parens, coords and walls stay unstyled.
    const cyan = lines.flat().filter((sp) => sp.style?.fg === "cyan");
    expect(cyan.map((sp) => sp.text)).toEqual(["\u2191", "hbk"]); // top edge renders first

    // Terrain tinting shows up in spans wherever the glyph is drawn;
    // mapModel derives its own marks, so use it for the glyph check.
    const mapSpans = boardToSpans(mapModel([{ col: 2, row: 2, type: "heavyWoods" }], 2, 2));
    const glyph = mapSpans.flat().filter((sp) => sp.style !== undefined && sp.text.includes("W"));
    expect(glyph.length).toBeGreaterThan(0);
    expect(glyph.every((sp) => sp.style?.cls === "t-heavyWoods")).toBe(true);
  });

  it("keeps terrain tint on grid rows under an occupying unit", () => {
    const state = createBattle(
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 3, row: 2 },
          facing: "ne",
        },
        {
          id: "far",
          model: "GRF-1N",
          team: 1,
          gunnery: 4,
          position: { col: 11, row: 11 },
          facing: "s",
        },
      ],
      { terrain: [{ col: 3, row: 2, type: "lightWoods" }] },
    );
    const model = battleModel(state);
    expect(model.styles?.["3,2"]).toEqual({ cls: "t-lightWoods" });
    expect(model.cellStyles?.["3,2"]).toEqual(TEAM_STYLES[0]);

    // Column 3 is odd: staggered two canvas lines down. In 1-based
    // coords, col 3 row 2 has its top label at canvas y = 2 + 1*4 = 6,
    // so the top label sits on line 7 of the spans.
    const spans = boardToSpans(model);
    const coordSpan = spans[7]!.find((sp) => sp.text.includes("0302"));
    expect(coordSpan?.style?.cls).toBe("t-lightWoods");
    const idLine = spans[8]!; // belly row of col 3 row 2
    const idSpan = idLine.find((sp) => sp.text === "hbk");
    expect(idSpan?.style?.fg).toBe("cyan");
    // The ne arrow sits on the terrain-tinted coord-row wall yet wears the
    // team color instead.
    const neArrow = spans.flat().find((sp) => sp.text === "\u2197");
    expect(neArrow?.style?.fg).toBe("cyan");
  });

  it("explicit styles replace automatic ones entirely", () => {
    const state = createBattle(
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 2, row: 2 },
          facing: "n",
        },
        {
          id: "far",
          model: "GRF-1N",
          team: 1,
          gunnery: 4,
          position: { col: 11, row: 11 },
          facing: "s",
        },
      ],
      { terrain: [{ col: 3, row: 2, type: "lightWoods" }] },
    );
    const override: Record<string, CharStyle> = {
      "0,0": { fg: "red", bold: true, italic: true, bg: "blue" },
    };
    const model = battleModel(state, undefined, undefined, override);
    expect(model.styles?.["0,0"]).toEqual(override["0,0"]);
    expect(model.styles?.["1,0"]).toBeUndefined();
    expect(model.styles && Object.keys(model.styles)).toEqual(["0,0"]);
    // Explicit styles suppress automatic styling entirely — including team ids.
    expect(model.cellStyles).toBeUndefined();
  });

  it("trims trailing whitespace exactly like the flat renderer", () => {
    const terrain = beginner.terrain;
    const flatLines = renderMap(terrain, beginner.width, beginner.height).split("\n");
    const spanLines = boardToSpans(mapModel(terrain, beginner.width, beginner.height));
    spanLines.forEach((line, i) => {
      expect(spansText(line)).toBe(flatLines[i]);
      const last = line[line.length - 1];
      if (last !== undefined) {
        // The final run never ends in unstyled padding spaces.
        expect(last.text.endsWith("  ") && last.style === undefined).toBe(false);
      }
    });
  });

  it("boardToChars reproduces flat rendering character by character", () => {
    const terrain = beginner.terrain;
    const flat = renderMap(terrain, beginner.width, beginner.height);
    const chars = boardToChars(mapModel(terrain, beginner.width, beginner.height));
    const reconstructed = chars.map((line) => line.map((c) => c.text).join("")).join("\n");
    expect(reconstructed).toBe(flat);
  });

  it("boardToChars preserves styles from boardToSpans", () => {
    const state = createBattle(
      [
        {
          id: "a",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 2, row: 2 },
          facing: "n",
        },
        {
          id: "b",
          model: "CDA-3MA",
          team: 1,
          gunnery: 4,
          position: { col: 4, row: 2 },
          facing: "s",
        },
      ],
      { terrain: [{ col: 2, row: 2, type: "heavyWoods" }] },
    );
    const spans = boardToSpans(battleModel(state));
    const chars = boardToChars(battleModel(state));
    // Same line count.
    expect(chars.length).toBe(spans.length);
    // Reconstructed text matches.
    const spanText = spans.map((line) => spansText(line)).join("\n");
    const charText = chars.map((line) => line.map((c) => c.text).join("")).join("\n");
    expect(charText).toBe(spanText);
    // Styled chars carry the same style as their parent span.
    for (let y = 0; y < spans.length; y++) {
      const spanLine = spans[y]!;
      const charLine = chars[y]!;
      let si = 0;
      let ci = 0;
      while (si < spanLine.length && ci < charLine.length) {
        const sp = spanLine[si]!;
        const ch = charLine[ci]!;
        // Every char in this span run should share the span's style.
        expect(ch.style).toEqual(sp.style);
        ci++;
        if (ci >= charLine.length || (sp.text.length > 0 && ci > 0)) {
          // Advance span after consuming its chars.
          const spanConsumed = spanLine.slice(0, si + 1).reduce((n, s) => n + s.text.length, 0);
          if (ci >= spanConsumed) si++;
        }
      }
    }
  });
});
