import { describe, expect, it } from "vitest";
import { battleModel, boardToText, GRID_GLYPHS, renderMap } from "../src/render.js";
import type { BattleState } from "../src/rules/game.js";
import { createBattle } from "../src/rules/game.js";

/** Flat battle text via the structured model (historic renderer shape). */
const renderBattle = (
  state: BattleState,
  overlay?: Readonly<Record<string, string>>,
  marks?: Readonly<Record<string, string>>,
): string => boardToText(battleModel(state, overlay, marks));

declare const console: { log: (message: string) => void };

describe("console renderer", () => {
  const farAway = { col: 9, row: 9 };

  function battleWith(primary: {
    id: string;
    model: string;
    position: { col: number; row: number };
  }): ReturnType<typeof createBattle> {
    return createBattle([
      { ...primary, team: 0, gunnery: 4, facing: "n" },
      { id: "far", model: "GRF-1N", team: 1, gunnery: 4, position: farAway, facing: "s" },
    ]);
  }

  it("draws hexes with unit ids and coordinates", () => {
    const state = battleWith({ id: "hbk", model: "HBK-4G", position: { col: 1, row: 2 } });
    const out = renderBattle(state);
    expect(out).toContain(`${GRID_GLYPHS.vertW}  hbk ${GRID_GLYPHS.vertE}`); // id centered in the 6-char belly
    expect(out).toContain(`${GRID_GLYPHS.edgeNW}0203${GRID_GLYPHS.edgeNE}`); // coord row /XXYY
  });

  it("staggers odd columns down half a hex", () => {
    const state = createBattle(
      [
        {
          id: "wvr",
          model: "WVR-6R",
          team: 0,
          gunnery: 4,
          position: { col: 1, row: 1 },
          facing: "n",
        },
        {
          id: "grf",
          model: "GRF-1N",
          team: 1,
          gunnery: 3,
          position: { col: 2, row: 1 },
          facing: "s",
        },
      ],
      { width: 3, height: 2 },
    );
    const lines = renderBattle(state).split("\n");
    // Column 1 (odd) starts two lines lower than column 2 (even): its
    // coordinate label lands exactly two rows beneath the neighbor's.
    const wvrAt = lines.findIndex((l) =>
      l.includes(`${GRID_GLYPHS.edgeNW}0202${GRID_GLYPHS.edgeNE}`),
    );
    const grfAt = lines.findIndex((l) =>
      l.includes(`${GRID_GLYPHS.edgeNW}0302${GRID_GLYPHS.edgeNE}`),
    );
    expect(wvrAt).toBeGreaterThan(-1);
    expect(grfAt).toBe(wvrAt - 2);
    // Column 1's shared edge sits flush against column 2's terrain row on
    // the same canvas line.
    expect(lines[grfAt]!.slice(13, 19)).toBe(`${GRID_GLYPHS.edgeNW}0302${GRID_GLYPHS.edgeNE}`);
    expect(lines[wvrAt - 1]!.slice(8, 12)).toBe(
      `${GRID_GLYPHS.edgeShared}\u2191${GRID_GLYPHS.edgeShared.repeat(2)}`,
    );
  });

  it("clips long ids and centers short ones in the 6-char belly", () => {
    const state = createBattle([
      {
        id: "wolverine",
        model: "WVR-6R",
        team: 0,
        gunnery: 4,
        position: { col: 1, row: 1 },
        facing: "n",
      },
      { id: "ab", model: "GRF-1N", team: 1, gunnery: 4, position: { col: 2, row: 1 }, facing: "s" },
    ]);
    const out = renderBattle(state);
    expect(out).toContain(`${GRID_GLYPHS.vertW} wolv ${GRID_GLYPHS.vertE}`); // clipped to 4 chars
    expect(out).toContain(`${GRID_GLYPHS.vertW}  ab  ${GRID_GLYPHS.vertE}`); // centered
    expect(out).not.toContain("wolverine");
  });

  it("caps outer edges with _ and overline, sharing ==== below", () => {
    const state = createBattle([
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: 2, row: 1 },
        facing: "n",
      },
      {
        id: "enf",
        model: "ENF-4R",
        team: 0,
        gunnery: 4,
        position: { col: 2, row: 2 },
        facing: "s",
      },
    ]);
    const lines = renderBattle(state).split("\n");
    const edgeAt = (y: number): string => lines[y]!.slice(14, 18); // column 2's edge cells
    expect(edgeAt(0)).toBe(GRID_GLYPHS.edgeTop.repeat(4)); // outer top edge
    expect(edgeAt(4)).toBe(`${GRID_GLYPHS.edgeShared}\u2191${GRID_GLYPHS.edgeShared.repeat(2)}`); // hbk faces n
    expect(edgeAt(8)).toBe(GRID_GLYPHS.edgeShared.repeat(4)); // shared by rows 2 and 3
    expect(edgeAt(12)).toBe(`${GRID_GLYPHS.edgeBottom.repeat(2)}\u2193${GRID_GLYPHS.edgeBottom}`); // enf faces s
  });

  it("zero-pads coordinates as fixed XXYY pairs", () => {
    const state = battleWith({ id: "cda", model: "CDA-3MA", position: { col: 5, row: 12 } });
    expect(renderBattle(state)).toContain(`${GRID_GLYPHS.edgeNW}0613${GRID_GLYPHS.edgeNE}`);
  });

  it("omits removed units from the map", () => {
    const state = battleWith({ id: "hbk", model: "HBK-4G", position: { col: 1, row: 1 } });
    state.units.hbk!.removed = true;
    const out = renderBattle(state);
    expect(out).not.toContain(`(${GRID_GLYPHS.vertW} hbk`);
    expect(out).toContain(`${GRID_GLYPHS.edgeNW}0202${GRID_GLYPHS.edgeNE}`); // hex still drawn, empty
  });

  it("derives board size from units and terrain when not given", () => {
    const state = createBattle(
      [
        {
          id: "enf",
          model: "ENF-4R",
          team: 0,
          gunnery: 4,
          position: { col: 1, row: 1 },
          facing: "n",
        },
        {
          id: "wvr",
          model: "WVR-6R",
          team: 1,
          gunnery: 4,
          position: { col: 1, row: 2 },
          facing: "s",
        },
      ],
      { terrain: [{ col: 9, row: 7, type: "lightWoods" }] },
    );
    const out = renderBattle(state);
    expect(out.split("\n").length).toBe(8 * 4 + 2 + 1); // rows*stride + stagger + closing border
    expect(out).toContain(`${GRID_GLYPHS.edgeNW}0202${GRID_GLYPHS.edgeNE}`);
    expect(out).toContain(`${GRID_GLYPHS.edgeNW}1008${GRID_GLYPHS.edgeNE}`);
    console.log(out);
  });

  it("stamps overlay glyphs into empty hexes but units win", () => {
    const state = battleWith({ id: "hbk", model: "HBK-4G", position: { col: 1, row: 2 } });
    const out = renderBattle(state, {
      "1,2": "u",
      "3,0": "W",
      "0,0": "w",
    });
    expect(out).toContain(`${GRID_GLYPHS.vertW}  hbk ${GRID_GLYPHS.vertE}`); // occupant beats overlay
    expect(out).toContain(`${GRID_GLYPHS.vertW}   W  ${GRID_GLYPHS.vertE}`);
    expect(out).toContain(`${GRID_GLYPHS.vertW}   w  ${GRID_GLYPHS.vertE}`);
    expect(out).not.toContain(`${GRID_GLYPHS.vertW}   u  ${GRID_GLYPHS.vertE}`);
  });

  it("marks mech facing at the matching hexside vertex", () => {
    const state = createBattle([
      { id: "a", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 0, row: 0 }, facing: "n" },
      { id: "b", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 0, row: 1 }, facing: "s" },
      { id: "c", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 1, row: 0 }, facing: "ne" },
      { id: "d", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 1, row: 1 }, facing: "sw" },
      { id: "e", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 2, row: 0 }, facing: "nw" },
      { id: "f", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 2, row: 1 }, facing: "se" },
    ]);
    const lines = renderBattle(state).split("\n");
    expect(lines[0]![3]).toBe("\u2191"); // n: top edge's 2nd char
    expect(lines[8]![4]).toBe("\u2193"); // s: bottom edge's 3rd char
    expect(lines[3]![12]).toBe("\u2197"); // ne: upper-right wall
    expect(lines[9]![7]).toBe("\u2199"); // sw: lower-left wall
    expect(lines[1]![13]).toBe("\u2196"); // nw: upper-left wall
    expect(lines[7]![18]).toBe("\u2198"); // se: lower-right wall
  });
});

describe("map renderer", () => {
  it("draws terrain glyphs at the hex bottom center, ignoring clear ground", () => {
    const out = renderMap(
      [
        { col: 0, row: 0, type: "lightWoods" },
        { col: 2, row: 1, type: "heavyWoods" },
        { col: 1, row: 0, type: "clear" },
      ],
      3,
      2,
    );
    expect(out).toContain(`${GRID_GLYPHS.edgeSW} w0 ${GRID_GLYPHS.edgeSE}`);
    expect(out).toContain(`${GRID_GLYPHS.edgeSW} W0 ${GRID_GLYPHS.edgeSE}`);
    expect(out).not.toContain("???");
    expect(out.split("\n").length).toBe(2 * 4 + 2 + 1); // rows*stride + stagger + closing border
  });

  it("keeps unit ids in the center cell while terrain marks sit at the bottom", () => {
    const state = createBattle([
      {
        id: "hbk",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        position: { col: 1, row: 2 },
        facing: "n",
      },
      {
        id: "far",
        model: "GRF-1N",
        team: 1,
        gunnery: 4,
        position: { col: 9, row: 9 },
        facing: "s",
      },
    ]);
    const out = renderBattle(state, undefined, { "3,0": "W" });
    expect(out).toContain(`${GRID_GLYPHS.vertW}  hbk ${GRID_GLYPHS.vertE}`);
    expect(out).toContain(`${GRID_GLYPHS.edgeSW} W0 ${GRID_GLYPHS.edgeSE}`);
  });

  it("draws battle terrain via the marks layer", () => {
    const state = createBattle(
      [
        {
          id: "hbk",
          model: "HBK-4G",
          team: 0,
          gunnery: 4,
          position: { col: 1, row: 1 },
          facing: "n",
        },
        {
          id: "far",
          model: "GRF-1N",
          team: 1,
          gunnery: 4,
          position: { col: 9, row: 9 },
          facing: "s",
        },
      ],
      { terrain: [{ col: 0, row: 0, type: "lightWoods" }] },
    );
    const out = renderBattle(state, undefined, { "0,0": "w" });
    expect(out).toContain(`${GRID_GLYPHS.vertW}  hbk ${GRID_GLYPHS.vertE}`);
    expect(out).toContain(`${GRID_GLYPHS.edgeSW} w0 ${GRID_GLYPHS.edgeSE}`);
  });
});
