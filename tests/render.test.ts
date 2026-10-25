import { describe, expect, it } from "vitest";
import type { TerrainHexDef } from "../src/core/types";
import { hexKey } from "../src/core/types";
import { mapDef } from "../src/data/index";
import type { MapDef } from "../src/data/map.schema";
import { buildUnitInit, type createBattle } from "../src/rules/game/create";
import type { BattleState, UnitInit } from "../src/rules/game/types";
import {
  applyEdgeStyles,
  type BoardModel,
  battleModel,
  boardToChars,
  boardToSpans,
  boardToText,
  type Canvas,
  type CharStyle,
  CLUB_MARKER,
  CSS_GRID_GLYPHS,
  createBoardModel,
  eachHex,
  FACING_GLYPH,
  GRID_GLYPHS,
  makeCanvas,
  mapModel,
  renderMap,
  type Span,
  TEAM_STYLES,
} from "../web/terminal/renderer.text";
import { createTestBattle } from "./helpers/battle";

/** Flat battle text via the structured model (historic renderer shape). */
const renderBattle = (
  state: BattleState,
  overlay?: Readonly<Record<string, string>>,
  marks?: Readonly<Record<string, string>>,
): string => boardToText(battleModel(state, overlay, marks));

declare const console: { log: (message: string) => void };

describe("console renderer", () => {
  const farAway = { col: 11, row: 11 };

  function battleWith(primary: {
    id: string;
    model: string;
    position: { col: number; row: number };
  }): ReturnType<typeof createBattle> {
    const units: UnitInit[] = [
      buildUnitInit(primary.id, primary.model, 1, primary.position, "n"),
      buildUnitInit("far", "GRF-1N", 2, farAway, "s"),
    ];
    return createTestBattle([], units, false);
  }

  it("draws hexes with unit ids and coordinates", () => {
    const state = battleWith({ id: "hbk", model: "HBK-4G", position: { col: 3, row: 4 } });
    const out = renderBattle(state);
    expect(out).toContain(`${GRID_GLYPHS.vertW}  hbk ${GRID_GLYPHS.vertE}`); // id centered in the 6-char belly
    expect(out).toContain(`${GRID_GLYPHS.edgeNW}0203${GRID_GLYPHS.edgeNE}`); // coord row /XXYY
  });

  it("staggers even columns down half a hex", () => {
    const units: UnitInit[] = [
      buildUnitInit("wvr", "WVR-6R", 1, { col: 3, row: 1 }, "n"),
      buildUnitInit("grf", "GRF-1N", 2, { col: 4, row: 1 }, "s", 3),
    ];
    const state = createTestBattle([], units, false, 4, 2);
    const lines = renderBattle(state).split("\n");
    // Odd-col labels sit at the top (canvas y=0), even-col labels at
    // canvas y=2 — so a same-row even column renders 2 canvas lines lower.
    const wvrAt = lines.findIndex((l) =>
      l.includes(`${GRID_GLYPHS.edgeNW}0301${GRID_GLYPHS.edgeNE}`),
    );
    const grfAt = lines.findIndex((l) =>
      l.includes(`${GRID_GLYPHS.edgeNW}0401${GRID_GLYPHS.edgeNE}`),
    );
    expect(wvrAt).toBeGreaterThan(-1);
    expect(grfAt).toBe(wvrAt + 2);
    // col 4 label lives at canvas x = (4-1)*6 + 1 = 19; slice(19, 25).
    expect(lines[grfAt]!.slice(19, 25)).toBe(`${GRID_GLYPHS.edgeNW}0401${GRID_GLYPHS.edgeNE}`);
    // wvr sits at col 3 (odd) row 1; its '↑' lives at the top edge of
    // the cell. The '↑' overwrites the top label's `0` digit at
    // canvas x = 15.
    expect(lines[wvrAt - 1]!.slice(15, 16)).toBe(FACING_GLYPH.n);
  });

  it("clips long ids and centers short ones in the 6-char belly", () => {
    const units: UnitInit[] = [
      buildUnitInit("wolverine", "WVR-6R", 1, { col: 3, row: 3 }, "n"),
      buildUnitInit("ab", "GRF-1N", 2, { col: 4, row: 3 }, "s"),
    ];
    const state = createTestBattle([], units, false);
    const out = renderBattle(state);
    expect(out).toContain(`${GRID_GLYPHS.vertW} wolv ${GRID_GLYPHS.vertE}`); // clipped to 4 chars
    expect(out).toContain(`${GRID_GLYPHS.vertW}  ab  ${GRID_GLYPHS.vertE}`); // centered
    expect(out).not.toContain("wolverine");
  });

  it("caps outer edges with _ and overline, sharing ==== below", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 4, row: 3 }, "n"),
      buildUnitInit("enf", "ENF-4R", 1, { col: 4, row: 4 }, "s"),
    ];
    const state = createTestBattle([], units, false, 4, 4);
    const lines = renderBattle(state).split("\n");
    // hbk at col 4 (even, staggered down 2). The '↑' sits at the shared edge
    // between row 2 and row 3 (canvas y=10). enf at col 4 row 4 (last row):
    // the '↓' sits at the bottom edge (canvas y=18). Slice positions
    // 20..24 target the right wall and interior of col 4's body.
    const edgeAt = (y: number): string => lines[y]!.slice(20, 24);
    expect(edgeAt(2)).toBe(GRID_GLYPHS.edgeTop.repeat(4));
    expect(edgeAt(10)).toBe(
      `${GRID_GLYPHS.edgeShared}${FACING_GLYPH.n}${GRID_GLYPHS.edgeShared.repeat(2)}`,
    );
    expect(edgeAt(18)).toBe(
      `${GRID_GLYPHS.edgeBottom.repeat(2)}${FACING_GLYPH.s}${GRID_GLYPHS.edgeBottom}`,
    );
  });

  it("zero-pads coordinates as fixed XXYY pairs", () => {
    const state = battleWith({ id: "cda", model: "CDA-3MA", position: { col: 7, row: 14 } });
    expect(renderBattle(state)).toContain(`${GRID_GLYPHS.edgeNW}0613${GRID_GLYPHS.edgeNE}`);
  });

  it("omits removed units from the map", () => {
    const state = battleWith({ id: "hbk", model: "HBK-4G", position: { col: 3, row: 3 } });
    state.units.hbk!.removed = "destroyed";
    const out = renderBattle(state);
    expect(out).not.toContain(`(${GRID_GLYPHS.vertW} hbk`);
    expect(out).toContain(`${GRID_GLYPHS.edgeNW}0202${GRID_GLYPHS.edgeNE}`); // hex still drawn, empty
  });

  it("helper sizes board to cover unit and terrain extents (engine no longer derives)", () => {
    const terrain: TerrainHexDef[] = [{ col: 11, row: 9, type: "lightWoods" }];
    const units: UnitInit[] = [
      buildUnitInit("enf", "ENF-4R", 1, { col: 3, row: 3 }, "n"),
      buildUnitInit("wvr", "WVR-6R", 2, { col: 3, row: 4 }, "s"),
    ];
    const state = createTestBattle(terrain, units, false);
    const out = renderBattle(state);
    expect(out.split("\n").length).toBe(10 * 4 + 2 + 1); // rows*stride + stagger + closing border
    expect(out).toContain(`${GRID_GLYPHS.edgeNW}0303${GRID_GLYPHS.edgeNE}`);
    expect(out).toContain(`${GRID_GLYPHS.edgeNW}1109${GRID_GLYPHS.edgeNE}`);
  });

  it("stamps overlay glyphs into empty hexes but units win", () => {
    const state = battleWith({ id: "hbk", model: "HBK-4G", position: { col: 3, row: 4 } });
    const out = renderBattle(state, {
      "3,4": "u",
      "4,1": "W",
      "1,1": "w",
    });
    expect(out).toContain(`${GRID_GLYPHS.vertW}  hbk ${GRID_GLYPHS.vertE}`); // occupant beats overlay
    expect(out).not.toContain(`${GRID_GLYPHS.vertW}   u  ${GRID_GLYPHS.vertE}`);
    expect(out).toContain(`${GRID_GLYPHS.vertW}   W  ${GRID_GLYPHS.vertE}`);
    expect(out).toContain(`${GRID_GLYPHS.vertW}   w  ${GRID_GLYPHS.vertE}`);
  });

  it("marks mech facing at the matching hexside vertex", () => {
    const units: UnitInit[] = [
      buildUnitInit("a", "HBK-4G", 1, { col: 2, row: 2 }, "n"),
      buildUnitInit("b", "HBK-4G", 1, { col: 2, row: 3 }, "s"),
      buildUnitInit("c", "HBK-4G", 1, { col: 3, row: 2 }, "ne"),
      buildUnitInit("d", "HBK-4G", 1, { col: 3, row: 3 }, "sw"),
      buildUnitInit("e", "HBK-4G", 1, { col: 4, row: 2 }, "nw"),
      buildUnitInit("f", "HBK-4G", 1, { col: 4, row: 3 }, "se"),
    ];
    const state = createTestBattle([], units, false);
    const out = renderBattle(state);
    // Each facing glyph has a distinct unicode codepoint; confirm the
    // output contains all six at some position.
    expect(out).toContain(FACING_GLYPH.n); // n
    expect(out).toContain(FACING_GLYPH.s); // s
    expect(out).toContain(FACING_GLYPH.ne); // ne
    expect(out).toContain(FACING_GLYPH.sw); // sw
    expect(out).toContain(FACING_GLYPH.nw); // nw
    expect(out).toContain(FACING_GLYPH.se); // se
  });
});

describe("map renderer", () => {
  it("draws terrain glyphs at the hex bottom center, ignoring clear ground", () => {
    const tempMap: MapDef = {
      name: "temp",
      width: 3,
      height: 2,
      terrain: [
        { col: 1, row: 1, type: "lightWoods" },
        { col: 3, row: 2, type: "heavyWoods" },
        { col: 2, row: 1, type: "clear" },
      ],
      legends: ["lightWoods", "heavyWoods", "clear"],
    };
    const out = renderMap(tempMap);
    expect(out).toContain(`${GRID_GLYPHS.edgeSW} w0 ${GRID_GLYPHS.edgeSE}`);
    expect(out).toContain(`${GRID_GLYPHS.edgeSW} W0 ${GRID_GLYPHS.edgeSE}`);
    expect(out).not.toContain("???");
    expect(out.split("\n").length).toBe(2 * 4 + 2 + 1);
  });

  it("keeps unit ids in the center cell while terrain marks sit at the bottom", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 3, row: 4 }, "n"),
      buildUnitInit("far", "GRF-1N", 2, { col: 11, row: 11 }, "s"),
    ];
    const state = createTestBattle([], units, false);
    const out = renderBattle(state, undefined, { "4,1": "W" });
    expect(out).toContain(`${GRID_GLYPHS.vertW}  hbk ${GRID_GLYPHS.vertE}`);
    expect(out).toContain(`${GRID_GLYPHS.edgeSW} W0 ${GRID_GLYPHS.edgeSE}`);
  });

  it("draws battle terrain via the marks layer", () => {
    const units: UnitInit[] = [
      buildUnitInit("hbk", "HBK-4G", 1, { col: 3, row: 3 }, "n"),
      buildUnitInit("far", "GRF-1N", 2, { col: 11, row: 11 }, "s"),
    ];
    const state = createTestBattle([{ col: 1, row: 1, type: "lightWoods" }], units, false);
    const out = renderBattle(state, undefined, { "1,1": "w" });
    expect(out).toContain(`${GRID_GLYPHS.vertW}  hbk ${GRID_GLYPHS.vertE}`);
    expect(out).toContain(`${GRID_GLYPHS.edgeSW} w0 ${GRID_GLYPHS.edgeSE}`);
  });

  it("renders a cropped sub-region via anchorCol/anchorRow and omits out-of-crop hexes", () => {
    const model: BoardModel = {
      cols: 3,
      rows: 2,
      anchorCol: 3,
      anchorRow: 4,
      cells: {
        "3,4": "aa",
        "5,5": "bb",
        "9,9": "zz", // outside the crop
      },
      facings: { "3,4": "n" },
      marks: {},
      elevations: {},
      edgeStyles: {},
      styles: {},
      idStyles: {},
      clubs: {},
    };
    const out = boardToText(model);
    // In-crop hexes are drawn.
    expect(out).toContain(`${GRID_GLYPHS.edgeNW}0304${GRID_GLYPHS.edgeNE}`);
    expect(out).toContain(`${GRID_GLYPHS.edgeNW}0505${GRID_GLYPHS.edgeNE}`);
    // The out-of-crop hex (9,9) is never drawn.
    expect(out).not.toContain("0909");
    // Full-coordinate labels outside the crop are absent too.
    expect(out).not.toContain("0101");
  });
});

describe("club marker", () => {
  const clubMap: MapDef = {
    name: "club",
    width: 2,
    height: 1,
    terrain: [{ col: 1, row: 1, type: "lightWoods" }],
    legends: ["lightWoods"],
  };
  const hexesWithClub = (hexes: string[]): string =>
    boardToText(createBoardModel({ map: clubMap, units: null, reachable: null, clubHexes: hexes }));

  it("stamps the marker left of the terrain mark and the bare level digit", () => {
    const out = hexesWithClub([hexKey({ col: 1, row: 1 }), hexKey({ col: 2, row: 1 })]);
    expect(out).toContain(`${GRID_GLYPHS.edgeSW}${CLUB_MARKER}w0 ${GRID_GLYPHS.edgeSE}`);
    expect(out).toContain(`${GRID_GLYPHS.edgeSW}${CLUB_MARKER} 0 ${GRID_GLYPHS.edgeSE}`);
  });

  it("renders byte-identical output when no hex holds a club", () => {
    const plain = boardToText(
      createBoardModel({ map: clubMap, units: null, reachable: null, clubHexes: null }),
    );
    expect(hexesWithClub([])).toBe(plain);
    expect(plain).not.toContain(CLUB_MARKER);
  });
});

describe("css-grid glyphs", () => {
  const map: MapDef = { name: "glyphs", width: 2, height: 3, terrain: [], legends: [] };
  const model = createBoardModel({ map, units: null, reachable: null, clubHexes: null });

  // Reference art: outer edges `⧽--⧼`, shared edges `⧽==⧼`, `╱ ╲` diagonals
  // and `⧼ ⧽` belly walls. Coordinate labels / elevation digits are blanked.
  it("matches the reference 2x3 layout", () => {
    const skeleton = boardToChars(model, CSS_GRID_GLYPHS)
      .map((l) =>
        l
          .map((sp) => sp.text)
          .join("")
          .replace(/[0-9]/g, " ")
          .trimEnd(),
      )
      .join("\n");
    expect(skeleton).toBe(
      [
        "  ⧽--⧼",
        " ╱    ╲",
        "⧼      ⧽⧽--⧼",
        " ╲    ╱╱    ╲",
        "  ⧽==⧼⧼      ⧽",
        " ╱    ╲╲    ╱",
        "⧼      ⧽⧽==⧼",
        " ╲    ╱╱    ╲",
        "  ⧽==⧼⧼      ⧽",
        " ╱    ╲╲    ╱",
        "⧼      ⧽⧽==⧼",
        " ╲    ╱╱    ╲",
        "  ⧽--⧼⧼      ⧽",
        "       ╲    ╱",
        "        ⧽--⧼",
      ].join("\n"),
    );
  });

  it("leaves the flat text renderer on the classic glyphs", () => {
    const text = boardToText(model);
    expect(text.split("\n")[0]).toBe(`  ${GRID_GLYPHS.edgeTop.repeat(4)}`);
    expect(text).toContain(`${GRID_GLYPHS.edgeNW}0101${GRID_GLYPHS.edgeNE}`);
    expect(text).not.toContain(CSS_GRID_GLYPHS.edgeNW);
  });
});

describe("single-column reachable crop", () => {
  const map: MapDef = { name: "crop", width: 6, height: 6, terrain: [], legends: [] };
  const cropAt = (col: number, row: number): string[] =>
    boardToText(
      createBoardModel({
        map,
        units: null,
        reachable: { team: 1, revealed: [{ hex: { col, row }, facing: "n", path: [] }] },
        clubHexes: null,
      }),
    ).split("\n");

  // Regression: a zero-MP standup on an even column cropped to one hex drew
  // only its top half (the even-column stagger pushed it past the canvas).
  it.each([
    [4, 3],
    [3, 3],
  ])("draws the whole hex at (%i,%i)", (col, row) => {
    const lines = cropAt(col, row);
    expect(lines[0]?.trim()).toBe(GRID_GLYPHS.edgeTop.repeat(4));
    expect(
      lines.some((l) => l.includes(GRID_GLYPHS.edgeSW) && l.includes(GRID_GLYPHS.edgeSE)),
    ).toBe(true);
    expect(lines.at(-1)?.trim()).toBe(GRID_GLYPHS.edgeBottom.repeat(4));
  });
});

describe("render-styled", () => {
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
        buildUnitInit("hbk", "HBK-4G", 1, { col: 3, row: 4 }, "n"),
        buildUnitInit("grf", "GRF-1N", 2, { col: 5, row: 3 }, "s"),
      ];
      const state = createTestBattle([{ col: 2, row: 2, type: "heavyWoods" }], units, false);
      const flat = boardToText(battleModel(state));
      expect(boardToText(battleModel(state))).toBe(flat);
      expect(boardToSpans(battleModel(state)).map(spansText).join("\n")).toBe(flat);
    });

    it("merges adjacent same-style runs and splits at style boundaries", () => {
      const units: UnitInit[] = [
        buildUnitInit("ab", "HBK-4G", 1, { col: 2, row: 2 }, "n"),
        buildUnitInit("cd", "GRF-1N", 2, { col: 3, row: 2 }, "s"),
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
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "n"),
        buildUnitInit("far", "GRF-1N", 2, { col: 11, row: 11 }, "s"),
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
        buildUnitInit("hbk", "HBK-4G", 1, { col: 3, row: 2 }, "ne"),
        buildUnitInit("far", "GRF-1N", 2, { col: 11, row: 11 }, "s"),
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
        clubs: {},
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
        buildUnitInit("hbk", "HBK-4G", 1, { col: 2, row: 2 }, "n"),
        buildUnitInit("far", "GRF-1N", 2, { col: 11, row: 11 }, "s"),
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
        buildUnitInit("a", "HBK-4G", 1, { col: 2, row: 2 }, "n"),
        buildUnitInit("b", "CDA-3MA", 2, { col: 4, row: 2 }, "s"),
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
        clubs: {},
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

  describe("club marker style", () => {
    it("carries t-club and keeps span text equal to flat text", () => {
      const map: MapDef = {
        name: "club",
        width: 1,
        height: 1,
        terrain: [{ col: 1, row: 1, type: "lightWoods" }],
        legends: ["lightWoods"],
      };
      const model = createBoardModel({
        map,
        units: null,
        reachable: null,
        clubHexes: [hexKey({ col: 1, row: 1 })],
      });
      const lines = boardToSpans(model);
      expect(lines.map(spansText).join("\n")).toBe(boardToText(model));
      const spans = lines.flat();
      const club = spans.find((sp) => sp.text === CLUB_MARKER);
      expect(club?.style?.cls).toBe("t-club");
      const mark = spans.find((sp) => sp.text.includes("w"));
      expect(mark?.style?.cls).toBe("t-lightWoods");
    });
  });
});
