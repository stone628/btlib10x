import { describe, expect, it } from "vitest";
import { createBattle } from "../src/rules/game.js";
import { renderBattle, renderMap } from "../src/render.js";

declare const console: { log: (message: string) => void };

describe("console renderer", () => {
  const farAway = { col: 9, row: 9 };

  function battleWith(
    primary: { id: string; model: string; position: { col: number; row: number } },
  ): ReturnType<typeof createBattle> {
    return createBattle([
      { ...primary, team: 0, gunnery: 4, facing: "n" },
      { id: "far", model: "GRF-1N", team: 1, gunnery: 4, position: farAway, facing: "s" },
    ]);
  }

  it("draws hexes with unit ids and coordinates", () => {
    const state = battleWith({ id: "hbk", model: "HBK-4G", position: { col: 1, row: 2 } });
    const out = renderBattle(state);
    expect(out).toContain("/hbk\\");
    expect(out).toContain("< 2,3 >");
  });

  it("staggers odd columns down half a hex", () => {
    const state = createBattle([
      { id: "wvr", model: "WVR-6R", team: 0, gunnery: 4, position: { col: 1, row: 1 }, facing: "n" },
      { id: "grf", model: "GRF-1N", team: 1, gunnery: 3, position: { col: 2, row: 1 }, facing: "s" },
    ]);
    const lines = renderBattle(state, 3, 2).split("\n");
    // Column 1 (odd) starts two lines lower than column 2 (even): its
    // coordinate label lands exactly two rows beneath the neighbor's.
    const wvrAt = lines.findIndex((l) => l.includes("< 2,2 >"));
    const grfAt = lines.findIndex((l) => l.includes("< 3,2 >"));
    expect(wvrAt).toBeGreaterThan(-1);
    expect(grfAt).toBe(wvrAt - 2);
    // Column 1's shared edge nests flush against column 2's coordinate row
    // on the same canvas line.
    expect(lines[wvrAt - 2]!.slice(7, 10)).toBe("===");
    expect(lines[wvrAt - 2]!.slice(10)).toBe("< 3,2 >");
  });

  it("clips long ids and pads short ones to 3 characters", () => {
    const state = createBattle([
      { id: "wolverine", model: "WVR-6R", team: 0, gunnery: 4, position: { col: 1, row: 1 }, facing: "n" },
      { id: "ab", model: "GRF-1N", team: 1, gunnery: 4, position: { col: 2, row: 1 }, facing: "s" },
    ]);
    const out = renderBattle(state);
    expect(out).toContain("/wol\\");
    expect(out).toContain("/ab \\");
    expect(out).not.toContain("wolverine");
  });

  it("turns shared horizontal edges into double rules", () => {
    const state = createBattle([
      { id: "hbk", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 2, row: 1 }, facing: "n" },
      { id: "enf", model: "ENF-4R", team: 0, gunnery: 4, position: { col: 2, row: 2 }, facing: "s" },
    ]);
    const lines = renderBattle(state).split("\n");
    const dashAt = (y: number): string => lines[y]!.slice(12, 15); // column 2's border cells
    expect(dashAt(0)).toBe("---"); // outer edge
    expect(dashAt(4)).toBe("==="); // shared by rows 1 and 2
    expect(dashAt(8)).toBe("==="); // shared by rows 2 and 3
    expect(dashAt(12)).toBe("---"); // outer edge
  });

  it("space-aligns coordinates (col right, row left)", () => {
    const state = battleWith({ id: "cda", model: "CDA-3MA", position: { col: 5, row: 12 } });
    expect(renderBattle(state)).toContain("< 6,13>");
  });

  it("omits removed units from the map", () => {
    const state = battleWith({ id: "hbk", model: "HBK-4G", position: { col: 1, row: 1 } });
    state.units["hbk"]!.removed = true;
    const out = renderBattle(state);
    expect(out).not.toContain("/hbk");
    expect(out).toContain("< 2,2 >"); // hex still drawn, empty
  });

  it("derives board size from units and terrain when not given", () => {
    const state = createBattle(
      [
        { id: "enf", model: "ENF-4R", team: 0, gunnery: 4, position: { col: 1, row: 1 }, facing: "n" },
        { id: "wvr", model: "WVR-6R", team: 1, gunnery: 4, position: { col: 1, row: 2 }, facing: "s" },
      ],
      { terrain: [{ col: 9, row: 7, type: "lightWoods" }] },
    );
    const out = renderBattle(state);
    expect(out.split("\n").length).toBe(8 * 4 + 2 + 1); // rows*stride + stagger + closing border
    expect(out).toContain("< 2,2 >");
    expect(out).toContain("<10,8 >");
    console.log(out);
  });

  it("stamps overlay glyphs into empty hexes but units win", () => {
    const state = battleWith({ id: "hbk", model: "HBK-4G", position: { col: 1, row: 2 } });
    const out = renderBattle(state, undefined, undefined, {
      "1,2": "u",
      "3,0": "W",
      "0,0": "w",
    });
    expect(out).toContain("/hbk\\"); // occupant beats overlay
    expect(out).toContain("/ W \\");
    expect(out).toContain("/ w \\");
    expect(out).not.toContain("/ u \\");
  });
});

describe("map renderer", () => {
  it("draws terrain glyphs at the given size, ignoring clear ground", () => {
    const out = renderMap(
      [
        { col: 0, row: 0, type: "lightWoods" },
        { col: 2, row: 1, type: "heavyWoods" },
        { col: 1, row: 0, type: "clear" },
      ],
      3,
      2,
    );
    expect(out).toContain("/ w \\");
    expect(out).toContain("/ W \\");
    expect(out).not.toContain("???");
    expect(out.split("\n").length).toBe(2 * 4 + 2 + 1); // rows*stride + stagger + closing border
  });

  it("matches renderBattle output for the same terrain overlay", () => {
    const terrain = [
      { col: 0, row: 0, type: "lightWoods" },
      { col: 3, row: 2, type: "heavyWoods" },
    ] as const;
    const battle = createBattle(
      [
        { id: "a", model: "HBK-4G", team: 0, gunnery: 4, position: { col: 9, row: 9 }, facing: "n" },
        { id: "b", model: "GRF-1N", team: 1, gunnery: 4, position: { col: 9, row: 9 }, facing: "s" },
      ],
      { terrain: [...terrain] },
    );
    expect(renderMap([...terrain], 5, 4)).toBe(
      renderBattle(battle, 5, 4, {
        "0,0": "w",
        "3,2": "W",
      }),
    );
  });
});
