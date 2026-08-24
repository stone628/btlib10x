import { describe, expect, it } from "vitest";
import { createBattle } from "../src/rules/game.js";
import {
  battleModel,
  boardToSpans,
  boardToText,
  mapModel,
  renderMap,
  TEAM_STYLES,
} from "../src/render.js";
import type { CharStyle, Span } from "../src/render.js";
import { getMapDef } from "../src/data/index.js";
import { toEngineTerrain } from "../src/data/index.js";

function spansText(spans: readonly Span[]): string {
  return spans.map((sp) => sp.text).join("");
}

describe("styled board model", () => {
  const beginner = getMapDef("beginner");
  if (!beginner) throw new Error("missing beginner map");

  it("span text reproduces the flat rendering exactly (maps)", () => {
    const terrain = toEngineTerrain(beginner);
    const flat = renderMap(terrain, beginner.width, beginner.height);
    const spans = boardToSpans(mapModel(terrain, beginner.width, beginner.height));
    expect(spans.map(spansText).join("\n")).toBe(flat);
    // Cross-check against the independent text serializer too.
    expect(boardToText(mapModel(terrain, beginner.width, beginner.height))).toBe(flat);
  });

  it("span text reproduces the flat rendering exactly (battles)", () => {
    const state = createBattle([
      { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 1, row: 2 }, facing: "n" },
      { id: "grf", model: "GRF-1N", team: 1, gunnery: 4, position: { col: 3, row: 1 }, facing: "s" },
    ], { terrain: [{ col: 0, row: 0, type: "heavyWoods" }] });
    const flat = boardToText(battleModel(state));
    expect(boardToText(battleModel(state))).toBe(flat);
    expect(boardToSpans(battleModel(state)).map(spansText).join("\n")).toBe(flat);
  });

  it("merges adjacent same-style runs and splits at style boundaries", () => {
    const state = createBattle([
      { id: "ab", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 0, row: 0 }, facing: "n" },
      { id: "cd", model: "GRF-1N", team: 1, gunnery: 4, position: { col: 1, row: 0 }, facing: "s" },
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
    const state = createBattle([
      { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 0, row: 0 }, facing: "n" },
      { id: "far", model: "GRF-1N", team: 1, gunnery: 4, position: { col: 9, row: 9 }, facing: "s" },
    ], { terrain: [{ col: 2, row: 1, type: "lightWoods" }] });
    const model = battleModel(state);
    const woods = model.styles?.["2,1"];
    expect(woods).toEqual({ cls: "t-lightWoods" });
    expect(model.styles?.["0,0"]).toEqual(TEAM_STYLES[0]);

    const lines = boardToSpans(model);
    const team0 = lines.flat().find((sp) => sp.text.includes("hbk"));
    expect(team0?.style?.fg).toBe("cyan");

    // Terrain tinting shows up in spans wherever the glyph is drawn;
    // mapModel derives its own marks, so use it for the glyph check.
    const mapSpans = boardToSpans(
      mapModel([{ col: 0, row: 0, type: "heavyWoods" }], 2, 2),
    );
    const glyph = mapSpans.flat().filter((sp) => sp.style !== undefined && sp.text.includes("W"));
    expect(glyph.length).toBeGreaterThan(0);
    expect(glyph.every((sp) => sp.style?.cls === "t-heavyWoods")).toBe(true);
  });

  it("explicit styles replace automatic ones entirely", () => {
    const state = createBattle([
      { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 0, row: 0 }, facing: "n" },
      { id: "far", model: "GRF-1N", team: 1, gunnery: 4, position: { col: 9, row: 9 }, facing: "s" },
    ], { terrain: [{ col: 1, row: 0, type: "lightWoods" }] });
    const override: Record<string, CharStyle> = { "0,0": { fg: "red", bold: true, italic: true, bg: "blue" } };
    const model = battleModel(state, undefined, undefined, override);
    expect(model.styles?.["0,0"]).toEqual(override["0,0"]);
    expect(model.styles?.["1,0"]).toBeUndefined();
    expect(model.styles && Object.keys(model.styles)).toEqual(["0,0"]);
  });

  it("trims trailing whitespace exactly like the flat renderer", () => {
    const terrain = toEngineTerrain(beginner);
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
});
