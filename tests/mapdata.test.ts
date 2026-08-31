import { describe, expect, it } from "vitest";
import { getMapDef, listMapNames } from "../src/data/index.js";
import { type MapDef, validateMapDef } from "../src/data/mapschema.js";
import { createBattle } from "../src/rules/game.js";

const valid: MapDef = {
  name: "test-map",
  width: 5,
  height: 4,
  terrain: [
    { col: 3, row: 3, type: "lightWoods" },
    { col: 5, row: 4, type: "heavyWoods" },
  ],
};

describe("validateMapDef", () => {
  it("accepts a well-formed map", () => {
    expect(validateMapDef(valid)).toEqual(valid);
  });

  it("rejects non-object payloads", () => {
    for (const bad of [null, "map", 42, [{ col: 3, row: 3, type: "clear" }]]) {
      expect(() => validateMapDef(bad)).toThrow(/must be a JSON object/);
    }
  });

  it("rejects bad dimensions", () => {
    expect(() => validateMapDef({ ...valid, width: 0 })).toThrow(
      /width must be a positive integer/,
    );
    expect(() => validateMapDef({ ...valid, height: 2.5 })).toThrow(
      /height must be a positive integer/,
    );
  });

  it("rejects malformed terrain entries and unknown types", () => {
    expect(() => validateMapDef({ ...valid, terrain: "woods" })).toThrow(
      /terrain must be an array/,
    );
    expect(() =>
      validateMapDef({ ...valid, terrain: [{ col: 1.5, row: 1, type: "lightWoods" }] }),
    ).toThrow(/terrain\[0\].col must be an integer/);
    expect(() =>
      validateMapDef({ ...valid, terrain: [{ col: 3, row: 3, type: "water" }] }),
    ).toThrow(/is not clear\|lightWoods\|heavyWoods/);
    expect(() => validateMapDef({ ...valid, terrain: [42] })).toThrow(
      /terrain\[0\] must be an object/,
    );
  });

  it("enforces 1-based board bounds", () => {
    const errors = (terrain: unknown): string =>
      (() => {
        try {
          validateMapDef({ ...valid, terrain: terrain as MapDef["terrain"] });
          return "";
        } catch (e) {
          return (e as Error).message;
        }
      })();
    expect(errors([{ col: 0, row: 3, type: "clear" }])).toMatch(
      /col 0 outside board bounds 1\.\.5/,
    );
    expect(errors([{ col: 6, row: 3, type: "clear" }])).toMatch(
      /col 6 outside board bounds 1\.\.5/,
    );
    expect(errors([{ col: 3, row: 5, type: "clear" }])).toMatch(
      /row 5 outside board bounds 1\.\.4/,
    );
    // Boundary hexes are legal.
    expect(errors([{ col: 5, row: 4, type: "heavyWoods" }])).toBe("");
  });

  it("rejects duplicate hexes", () => {
    expect(() =>
      validateMapDef({
        ...valid,
        terrain: [
          { col: 1, row: 1, type: "lightWoods" },
          { col: 1, row: 1, type: "heavyWoods" },
        ],
      }),
    ).toThrow(/duplicates hex 1,1/);
  });

  it("accepts an optional non-negative integer `level` per hex", () => {
    const withLevel: MapDef = {
      name: "test-map",
      width: 5,
      height: 4,
      terrain: [
        { col: 3, row: 3, type: "clear", level: 2 },
        { col: 4, row: 3, type: "clear" },
      ],
    };
    expect(validateMapDef(withLevel)).toEqual(withLevel);
  });

  it("rejects malformed `level`", () => {
    expect(() =>
      validateMapDef({
        ...valid,
        terrain: [{ col: 3, row: 3, type: "clear", level: -1 }],
      }),
    ).toThrow(/level must be a non-negative integer/);
    expect(() =>
      validateMapDef({
        ...valid,
        terrain: [{ col: 3, row: 3, type: "clear", level: 1.5 }],
      }),
    ).toThrow(/level must be a non-negative integer/);
  });
});

describe("bundled maps", () => {
  it("loads both rulebook maps with expected dimensions and hex counts", () => {
    expect(listMapNames().sort()).toEqual(["beginner", "quickstart", "test"]);
    for (const name of ["beginner", "quickstart"]) {
      const map = getMapDef(name)!;
      expect(map.width).toBe(15);
      expect(map.height).toBe(16);
      expect(map.terrain.length).toBeGreaterThan(0);
      for (const h of map.terrain) {
        expect(h.col).toBeGreaterThanOrEqual(1);
        expect(h.col).toBeLessThanOrEqual(map.width);
        expect(h.row).toBeGreaterThanOrEqual(1);
        expect(h.row).toBeLessThanOrEqual(map.height);
      }
    }
    expect(getMapDef("beginner")!.terrain).toHaveLength(20);
    expect(getMapDef("quickstart")!.terrain).toHaveLength(31);
    expect(getMapDef("beginner")!.terrain[0]).toEqual({ col: 2, row: 5, type: "heavyWoods" });
  });

  it("is directly usable by createBattle (no conversion layer)", () => {
    expect(getMapDef("beginner")!.terrain[0]).toEqual({ col: 2, row: 5, type: "heavyWoods" });
    expect(() =>
      createBattle(
        [
          {
            id: "a",
            model: "HBK-4G",
            team: 0,
            gunnery: 4,
            position: { col: 2, row: 4 },
            facing: "se",
          },
          {
            id: "b",
            model: "GRF-1N",
            team: 1,
            gunnery: 3,
            position: { col: 10, row: 8 },
            facing: "nw",
          },
        ],
        { terrain: getMapDef("quickstart")!.terrain },
      ),
    ).not.toThrow();
  });
});
