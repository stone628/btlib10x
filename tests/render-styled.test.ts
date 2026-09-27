import { describe, expect, it } from "vitest";
import { type MapDef, mapDef } from "../src/data/index";
import type { UnitInit } from "../src/rules/game";
import type { BoardModel, Canvas, CharStyle, Span } from "../web/renderer.text";
import {
  applyEdgeStyles,
  battleModel,
  boardToChars,
  boardToSpans,
  boardToText,
  eachHex,
  FACING_GLYPH,
  makeCanvas,
  mapModel,
  renderMap,
  TEAM_STYLES,
} from "../web/renderer.text";
import { createTestBattle } from "./helpers";

function spansText(spans: readonly Span[]): string {
  return spans.map((sp) => sp.text).join("");
}

describe("styled board model", () => {
  const beginner = mapDef("beginner");
  if (!beginner) throw new Error("missing beginner map");

  it("span text reproduces the flat rendering exactly (maps)", () => {
    const flat = renderMap(beginner);
    const spans = boardToSpans(mapModel(beginner));
    expect(spans.map(spansText).join("\n")).toBe(flat);
    // Cross-check against the independent text serializer too.
    expect(boardToText(mapModel(beginner))).toBe(flat);
  });

  it("span text reproduces the flat rendering exactly (battles)", () => {
    const units: UnitInit[] = [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 3, row: 4 },
        facing: "n",
      },
      {
        id: "grf",
        model: "GRF-1N",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 5, row: 3 },
        facing: "s",
      },
    ];
    const state = createTestBattle([{ col: 2, row: 2, type: "heavyWoods" }], units, false);
    const flat = boardToText(battleModel(state));
    expect(boardToText(battleModel(state))).toBe(flat);
    expect(boardToSpans(battleModel(state)).map(spansText).join("\n")).toBe(flat);
  });

  it("merges adjacent same-style runs and splits at style boundaries", () => {
    const units: UnitInit[] = [
      {
        id: "ab",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 2 },
        facing: "n",
      },
      {
        id: "cd",
        model: "GRF-1N",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 3, row: 2 },
        facing: "s",
      },
    ];
    const state = createTestBattle([], units, false);
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
    const units: UnitInit[] = [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 2 },
        facing: "n",
      },
      {
        id: "far",
        model: "GRF-1N",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 11, row: 11 },
        facing: "s",
      },
    ];
    const state = createTestBattle([{ col: 3, row: 3, type: "lightWoods" }], units, false);
    const model = battleModel(state);
    const woods = model.styles["3,3"];
    expect(woods).toEqual({ cls: "t-lightWoods" });
    expect(model.idStyles["2,2"]).toEqual(TEAM_STYLES[0]);

    const lines = boardToSpans(model);
    const team0 = lines.flat().find((sp) => sp.text.includes("hbk"));
    expect(team0?.style?.fg).toBe("cyan");

    // Team color touches only the id characters and the facing arrow: exactly
    // one cyan span each per board — parens, coords and walls stay unstyled.
    const cyan = lines.flat().filter((sp) => sp.style?.fg === "cyan");
    expect(cyan.map((sp) => sp.text)).toEqual([FACING_GLYPH.n, "hbk"]); // top edge renders first

    // Terrain tinting shows up in spans wherever the glyph is drawn;
    // mapModel derives its own marks, so use it for the glyph check.
    const tempMap: MapDef = {
      name: "temp",
      width: 2,
      height: 2,
      terrain: [{ col: 2, row: 2, type: "heavyWoods" }],
      legends: ["heavyWoods"],
    };
    const mapSpans = boardToSpans(mapModel(tempMap));
    const glyph = mapSpans.flat().filter((sp) => sp.style !== undefined && sp.text.includes("W"));
    expect(glyph.length).toBeGreaterThan(0);
    expect(glyph.every((sp) => sp.style?.cls === "t-heavyWoods")).toBe(true);
  });

  it("keeps terrain tint on grid rows under an occupying unit", () => {
    const units: UnitInit[] = [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 3, row: 2 },
        facing: "ne",
      },
      {
        id: "far",
        model: "GRF-1N",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 11, row: 11 },
        facing: "s",
      },
    ];
    const state = createTestBattle([{ col: 3, row: 2, type: "lightWoods" }], units, false);
    const model = battleModel(state);
    expect(model.styles["3,2"]).toEqual({ cls: "t-lightWoods" });
    expect(model.idStyles["3,2"]).toEqual(TEAM_STYLES[0]);

    // Column 3 is odd: not staggered (even columns are staggered down). In
    // 1-based coords, col 3 row 2 has its top label at canvas y = 0 + 1*4 = 4,
    // so the top label sits on line 5 of the spans.
    const spans = boardToSpans(model);
    const coordSpan = spans[5]!.find((sp) => sp.text.includes("0302"));
    expect(coordSpan?.style?.cls).toBe("t-lightWoods");
    const idLine = spans[6]!; // belly row of col 3 row 2
    const idSpan = idLine.find((sp) => sp.text === "hbk");
    expect(idSpan?.style?.fg).toBe("cyan");
    // The ne arrow sits on the terrain-tinted coord-row wall yet wears the
    // team color instead.
    const neArrow = spans.flat().find((sp) => sp.text === FACING_GLYPH.ne);
    expect(neArrow?.style?.fg).toBe("cyan");
  });

  it("tints reachable edges via edgeStyles (glyph where a facing sits, raw wall otherwise)", () => {
    const model: BoardModel = {
      cols: 2,
      rows: 2,
      anchorCol: 1,
      anchorRow: 1,
      cells: {
        "1,1": "ab",
        "2,2": "cd",
      },
      facings: { "1,1": "n" },
      edgeStyles: {
        "1,1:n": { fg: "cyan" },
        "2,2:se": { fg: "magenta" },
      },
      marks: {},
      elevations: {},
      styles: {},
      idStyles: {},
    };
    const spans = boardToSpans(model).flat();
    // The n edge of 1,1 is tinted, riding on the actor's facing glyph.
    const nEdge = spans.find((sp) => sp.text === FACING_GLYPH.n);
    expect(nEdge?.style?.fg).toBe("cyan");
    // The se edge of 2,2 is tinted even though no facing glyph is drawn there.
    const seEdge = spans.find((sp) => sp.style?.fg === "magenta");
    expect(seEdge).toBeDefined();
    expect(seEdge?.text).toBe("/");
  });

  it("explicit styles replace automatic ones entirely", () => {
    const units: UnitInit[] = [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 2 },
        facing: "n",
      },
      {
        id: "far",
        model: "GRF-1N",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 11, row: 11 },
        facing: "s",
      },
    ];
    const state = createTestBattle([{ col: 3, row: 2, type: "lightWoods" }], units, false);
    const override: Record<string, CharStyle> = {
      "0,0": { fg: "red", bold: true, italic: true, bg: "blue" },
    };
    const model = battleModel(state, undefined, undefined, override);
    expect(model.styles["0,0"]).toEqual(override["0,0"]);
    expect(model.styles["1,0"]).toBeUndefined();
    expect(Object.keys(model.styles)).toEqual(["0,0"]);
    // Explicit styles suppress automatic styling entirely — including team ids.
    expect(model.idStyles).toEqual({});
  });

  it("trims trailing whitespace exactly like the flat renderer", () => {
    const flatLines = renderMap(beginner).split("\n");
    const spanLines = boardToSpans(mapModel(beginner));
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
    const flat = renderMap(beginner);
    const chars = boardToChars(mapModel(beginner));
    const reconstructed = chars.map((line) => line.map((c) => c.text).join("")).join("\n");
    expect(reconstructed).toBe(flat);
  });

  it("boardToChars preserves styles from boardToSpans", () => {
    const units: UnitInit[] = [
      {
        id: "a",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 2 },
        facing: "n",
      },
      {
        id: "b",
        model: "CDA-3MA",
        team: 1,
        gunnery: 4,
        piloting: 5,
        position: { col: 4, row: 2 },
        facing: "s",
      },
    ];
    const state = createTestBattle([{ col: 2, row: 2, type: "heavyWoods" }], units, false);
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

describe("applyEdgeStyles layer", () => {
  it("tints hexside vertices on a synthetic canvas without touching characters", () => {
    const model: BoardModel = {
      cols: 2,
      rows: 1,
      anchorCol: 1,
      anchorRow: 1,
      cells: {},
      marks: {},
      elevations: {},
      facings: {},
      edgeStyles: {
        "1,1:n": { fg: "cyan" },
        "1,1:sw": { bg: "blue" },
        "1,1:se": { fg: "magenta" },
        "2,1:s": { fg: "green" },
      },
      styles: {},
      idStyles: {},
    };
    const canvas: Canvas = makeCanvas(model);
    for (const hex of eachHex(model)) applyEdgeStyles(canvas, hex);
    // Hex (1,1) is odd (un-staggered): origin at (0,0). Col 2 is even, so its
    // origin drops by STAGGER to (6,2).
    expect(canvas.styles[0]![3]).toEqual({ fg: "cyan" }); // 1,1:n  → (x+3, y+0)
    expect(canvas.styles[3]![1]).toEqual({ bg: "blue" }); // 1,1:sw → (x+1, y+3)
    expect(canvas.styles[3]![6]).toEqual({ fg: "magenta" }); // 1,1:se → (x+6, y+3)
    expect(canvas.styles[6]![10]).toEqual({ fg: "green" }); // 2,1:s  → (x+4, y+4)
    // Untinted vertices stay null.
    expect(canvas.styles[4]![4]).toBeNull(); // 1,1:s untouched
    expect(canvas.styles[0]![0]).toBeNull();
    // The pass is style-only: characters are never rewritten.
    expect(canvas.rows[0]![3]).toBe(" ");
    expect(canvas.rows[6]![10]).toBe(" ");
  });
});
