import { describe, expect, it } from "vitest";
import { listMapNames, mapDef } from "../src/data/index";
import { type MapDef, type MapDefSrc, validateMapDef } from "../src/data/map.schema";
import type { UnitInit } from "../src/rules/game";
import { createTestBattle } from "./helpers";

const valid: MapDefSrc = {
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
    expect(() => validateMapDef(valid)).not.toThrow();
  });

  it("rejects bad dimensions", () => {
    expect(() => validateMapDef({ ...valid, width: 0 } as MapDef)).toThrow(
      /width must be a positive integer/,
    );
    expect(() => validateMapDef({ ...valid, height: 2.5 } as MapDef)).toThrow(
      /height must be a positive integer/,
    );
  });

  it("rejects malformed terrain entries and unknown types", () => {
    expect(() =>
      validateMapDef({
        ...valid,
        terrain: [{ col: 1.5, row: 1, type: "lightWoods" }],
      } as MapDefSrc),
    ).toThrow(/terrain\[0\].col must be an integer/);
  });

  it("enforces 1-based board bounds", () => {
    const errors = (terrain: MapDefSrc["terrain"]): string =>
      (() => {
        try {
          validateMapDef({ ...valid, terrain });
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
      legends: ["clear"],
    };
    expect(() => validateMapDef(withLevel)).not.toThrow();
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
    expect(listMapNames().sort()).toEqual(["beginner", "quickstart", "test", "testground"]);
    for (const name of ["beginner", "quickstart"]) {
      const map = mapDef(name)!;
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
    expect(mapDef("beginner")!.terrain).toHaveLength(20);
    expect(mapDef("quickstart")!.terrain).toHaveLength(31);
    expect(mapDef("beginner")!.terrain[0]).toEqual({ col: 2, row: 5, type: "heavyWoods" });
  });

  it("is directly usable by createBattle (no conversion layer)", () => {
    expect(mapDef("beginner")!.terrain[0]).toEqual({ col: 2, row: 5, type: "heavyWoods" });
    const quickstart = mapDef("quickstart")!;
    const units: UnitInit[] = [
      {
        id: "a",
        model: "HBK-4G",
        team: 0,
        gunnery: 4,
        piloting: 5,
        position: { col: 2, row: 4 },
        facing: "se",
      },
      {
        id: "b",
        model: "GRF-1N",
        team: 1,
        gunnery: 3,
        piloting: 5,
        position: { col: 10, row: 8 },
        facing: "nw",
      },
    ];
    expect(() =>
      createTestBattle(quickstart.terrain, units, false, quickstart.width, quickstart.height),
    ).not.toThrow();
  });
});
