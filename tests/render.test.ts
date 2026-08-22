import { describe, expect, it } from "vitest";
import { createBattle } from "../src/rules/game.js";
import { renderBattle } from "../src/render.js";

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

  it("draws a lone hex with unit id and coordinates", () => {
    const state = battleWith({ id: "hbk", model: "HBK-4G", position: { col: 0, row: 0 } });
    expect(renderBattle(state, 1, 1)).toBe(
      [
        "  ---",
        " /hbk\\",
        "< 1,1 >",
        " \\   /",
        "  ---",
      ].join("\n"),
    );
  });

  it("staggers odd columns down half a hex", () => {
    const state = createBattle([
      { id: "wvr", model: "WVR-6R", team: 0, gunnery: 4, position: { col: 0, row: 0 }, facing: "n" },
      { id: "grf", model: "GRF-1N", team: 1, gunnery: 3, position: { col: 1, row: 0 }, facing: "s" },
    ]);
    const lines = renderBattle(state, 2, 1).split("\n");
    // Column 1 starts two lines lower: its top border sits flush between
    // column 0's coordinate row and column 2's.
    expect(lines[2]).toBe("< 1,1 >---");
    expect(lines[3]).toContain("/grf");
    expect(lines[4]).toBe("  ---< 2,1 >");
  });

  it("clips long ids and pads short ones to 3 characters", () => {
    const state = createBattle([
      { id: "wolverine", model: "WVR-6R", team: 0, gunnery: 4, position: { col: 0, row: 0 }, facing: "n" },
      { id: "ab", model: "GRF-1N", team: 1, gunnery: 4, position: { col: 1, row: 0 }, facing: "s" },
    ]);
    const out = renderBattle(state);
    expect(out).toContain("/wol\\");
    expect(out).toContain("/ab \\");
    expect(out).not.toContain("wolverine");
  });

  it("turns shared horizontal edges into double rules", () => {
    const state = battleWith({ id: "hbk", model: "HBK-4G", position: { col: 0, row: 0 } });
    const lines = renderBattle(state, 1, 2).split("\n");
    expect(lines[0]).toBe("  ---"); // outer edge
    expect(lines[4]).toBe("  ==="); // shared by rows 1 and 2
    expect(lines[8]).toBe("  ---"); // outer edge
  });

  it("space-aligns 1-based coordinates (col right, row left)", () => {
    const state = battleWith({ id: "cda", model: "CDA-3MA", position: { col: 5, row: 12 } });
    expect(renderBattle(state)).toContain("< 6,13>");
  });

  it("omits removed units from the map", () => {
    const state = battleWith({ id: "hbk", model: "HBK-4G", position: { col: 0, row: 0 } });
    state.units["hbk"]!.removed = true;
    const out = renderBattle(state);
    expect(out).toContain(" /   \\");
    expect(out).not.toContain("/hbk");
  });

  it("derives board size from units and terrain when not given", () => {
    const state = createBattle(
      [
        { id: "enf", model: "ENF-4R", team: 0, gunnery: 4, position: { col: 0, row: 0 }, facing: "n" },
        { id: "wvr", model: "WVR-6R", team: 1, gunnery: 4, position: { col: 0, row: 1 }, facing: "s" },
      ],
      { terrain: { "9,7": "lightWoods" } },
    );
    const out = renderBattle(state);
    expect(out.split("\n").length).toBe(8 * 4 + 2 + 1); // rows*stride + stagger + closing border
    expect(out).toContain("< 1,1 >");
    expect(out).toContain("<10,8 >");
    console.log(out);
  });
});
