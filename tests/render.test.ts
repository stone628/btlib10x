import { describe, expect, it } from "vitest";
import type { MapDef } from "../src/index.js";
import type { BattleState } from "../src/rules/game.js";
import { createBattle, type TerrainHexDef, type UnitInit } from "../src/rules/game.js";
import type { BoardModel } from "../web/renderer.text.js";
import { battleModel, boardToText, GRID_GLYPHS, renderMap } from "../web/renderer.text.js";
import { makeBattleOptions } from "./helpers.js";

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
      { ...primary, team: 0, gunnery: 4, facing: "n" },
      { id: "far", model: "GRF-1N", team: 1, gunnery: 4, position: farAway, facing: "s" },
    ];
    return createBattle(units, makeBattleOptions(units, false));
  }

  it("draws hexes with unit ids and coordinates", () => {
    const state = battleWith({ id: "hbk", model: "HBK-4G", position: { col: 3, row: 4 } });
    const out = renderBattle(state);
    expect(out).toContain(`${GRID_GLYPHS.vertW}  hbk ${GRID_GLYPHS.vertE}`); // id centered in the 6-char belly
    expect(out).toContain(`${GRID_GLYPHS.edgeNW}0203${GRID_GLYPHS.edgeNE}`); // coord row /XXYY
  });

  it("staggers even columns down half a hex", () => {
    const units: UnitInit[] = [
      {
        id: "wvr",
        model: "WVR-6R",
        team: 0,
        gunnery: 4,
        position: { col: 3, row: 1 },
        facing: "n",
      },
      {
        id: "grf",
        model: "GRF-1N",
        team: 1,
        gunnery: 3,
        position: { col: 4, row: 1 },
        facing: "s",
      },
    ];
    const state = createBattle(units, { ...makeBattleOptions(units, false), width: 4, height: 2 });
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
    expect(lines[wvrAt - 1]!.slice(15, 16)).toBe("\u2191");
  });

  it("clips long ids and centers short ones in the 6-char belly", () => {
    const units: UnitInit[] = [
      {
        id: "wolverine",
        model: "WVR-6R",
        team: 0,
        gunnery: 4,
        position: { col: 3, row: 3 },
        facing: "n",
      },
      { id: "ab", model: "GRF-1N", team: 1, gunnery: 4, position: { col: 4, row: 3 }, facing: "s" },
    ];
    const state = createBattle(units, makeBattleOptions(units, false));
    const out = renderBattle(state);
    expect(out).toContain(`${GRID_GLYPHS.vertW} wolv ${GRID_GLYPHS.vertE}`); // clipped to 4 chars
    expect(out).toContain(`${GRID_GLYPHS.vertW}  ab  ${GRID_GLYPHS.vertE}`); // centered
    expect(out).not.toContain("wolverine");
  });

  it("caps outer edges with _ and overline, sharing ==== below", () => {
    const units: UnitInit[] = [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: 4, row: 3 },
        facing: "n",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 0,
        gunnery: 4,
        position: { col: 4, row: 4 },
        facing: "s",
      },
    ];
    const state = createBattle(units, { ...makeBattleOptions(units, false), width: 4, height: 4 });
    const lines = renderBattle(state).split("\n");
    // hbk at col 4 (even, staggered down 2). The '↑' sits at the shared edge
    // between row 2 and row 3 (canvas y=10). enf at col 4 row 4 (last row):
    // the '↓' sits at the bottom edge (canvas y=18). Slice positions
    // 20..24 target the right wall and interior of col 4's body.
    const edgeAt = (y: number): string => lines[y]!.slice(20, 24);
    expect(edgeAt(2)).toBe(GRID_GLYPHS.edgeTop.repeat(4));
    expect(edgeAt(10)).toBe(`${GRID_GLYPHS.edgeShared}\u2191${GRID_GLYPHS.edgeShared.repeat(2)}`);
    expect(edgeAt(18)).toBe(`${GRID_GLYPHS.edgeBottom.repeat(2)}\u2193${GRID_GLYPHS.edgeBottom}`);
  });

  it("zero-pads coordinates as fixed XXYY pairs", () => {
    const state = battleWith({ id: "cda", model: "CDA-3MA", position: { col: 7, row: 14 } });
    expect(renderBattle(state)).toContain(`${GRID_GLYPHS.edgeNW}0613${GRID_GLYPHS.edgeNE}`);
  });

  it("omits removed units from the map", () => {
    const state = battleWith({ id: "hbk", model: "HBK-4G", position: { col: 3, row: 3 } });
    state.units.hbk!.removed = true;
    const out = renderBattle(state);
    expect(out).not.toContain(`(${GRID_GLYPHS.vertW} hbk`);
    expect(out).toContain(`${GRID_GLYPHS.edgeNW}0202${GRID_GLYPHS.edgeNE}`); // hex still drawn, empty
  });

  it("helper sizes board to cover unit and terrain extents (engine no longer derives)", () => {
    const terrain: TerrainHexDef[] = [{ col: 11, row: 9, type: "lightWoods" }];
    const units: UnitInit[] = [
      {
        id: "enf",
        model: "ENF-4R",
        team: 0,
        gunnery: 4,
        position: { col: 3, row: 3 },
        facing: "n",
      },
      {
        id: "wvr",
        model: "WVR-6R",
        team: 1,
        gunnery: 4,
        position: { col: 3, row: 4 },
        facing: "s",
      },
    ];
    const state = createBattle(units, makeBattleOptions(units, false, terrain));
    const out = renderBattle(state);
    expect(out.split("\n").length).toBe(10 * 4 + 2 + 1); // rows*stride + stagger + closing border
    expect(out).toContain(`${GRID_GLYPHS.edgeNW}0303${GRID_GLYPHS.edgeNE}`);
    expect(out).toContain(`${GRID_GLYPHS.edgeNW}1109${GRID_GLYPHS.edgeNE}`);
    console.log(out);
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
      { id: "a", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 2, row: 2 }, facing: "n" },
      { id: "b", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 2, row: 3 }, facing: "s" },
      { id: "c", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 3, row: 2 }, facing: "ne" },
      { id: "d", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 3, row: 3 }, facing: "sw" },
      { id: "e", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 4, row: 2 }, facing: "nw" },
      { id: "f", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 4, row: 3 }, facing: "se" },
    ];
    const state = createBattle(units, makeBattleOptions(units, false));
    const out = renderBattle(state);
    // Each facing glyph has a distinct unicode codepoint; confirm the
    // output contains all six at some position.
    expect(out).toContain("\u2191"); // n
    expect(out).toContain("\u2193"); // s
    expect(out).toContain("\u2197"); // ne
    expect(out).toContain("\u2199"); // sw
    expect(out).toContain("\u2196"); // nw
    expect(out).toContain("\u2198"); // se
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
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: 3, row: 4 },
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
    ];
    const state = createBattle(units, makeBattleOptions(units, false));
    const out = renderBattle(state, undefined, { "4,1": "W" });
    expect(out).toContain(`${GRID_GLYPHS.vertW}  hbk ${GRID_GLYPHS.vertE}`);
    expect(out).toContain(`${GRID_GLYPHS.edgeSW} W0 ${GRID_GLYPHS.edgeSE}`);
  });

  it("draws battle terrain via the marks layer", () => {
    const units: UnitInit[] = [
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: 3, row: 3 },
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
    ];
    const state = createBattle(
      units,
      makeBattleOptions(units, false, [{ col: 1, row: 1, type: "lightWoods" }]),
    );
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
