import { describe, expect, it } from "vitest";
import {
  blocksTargeting,
  costToEnter,
  hasPartialCover,
  screeningPoints,
  terrainMoveCost,
  terrainTargetMod,
} from "../src/core/terrain";
import { TERRAIN_TYPES, type TerrainType } from "../src/core/types";
import { allTerrainDefs } from "../src/data/terrain.schema";

describe("terrain catalog integrity", () => {
  it("defines every TerrainType with a catalog entry", () => {
    const catalog = allTerrainDefs();
    for (const t of TERRAIN_TYPES) {
      expect(catalog.has(t), `missing catalog entry for ${t}`).toBe(true);
    }
  });

  it("does not define unknown terrain types beyond TERRAIN_TYPES", () => {
    const catalog = allTerrainDefs();
    for (const key of catalog.keys()) {
      expect(TERRAIN_TYPES).toContain(key as (typeof TERRAIN_TYPES)[number]);
    }
  });

  it("engine helpers match the catalog for every terrain type", () => {
    const catalog = allTerrainDefs();
    for (const [type, def] of catalog) {
      const t = type as (typeof TERRAIN_TYPES)[number];
      expect(terrainMoveCost(t), `${type}.moveCost`).toBe(def.moveCost);
      expect(screeningPoints(t), `${type}.screening`).toBe(def.screeningValue);
      expect(terrainTargetMod(t), `${type}.targetMod`).toBe(def.terrainMod);
    }
  });

  it("flags partial cover and targeting restrictions correctly", () => {
    const catalog = allTerrainDefs();
    for (const [type, def] of catalog) {
      const t = type as (typeof TERRAIN_TYPES)[number];
      expect(hasPartialCover(t)).toBe(def.partialCover === true);
      expect(blocksTargeting(t)).toBe(def.blocksTargeting === true);
    }
  });
});

describe("costToEnter", () => {
  it("costs the base 1 MP plus the terrain surcharge", () => {
    expect(costToEnter("clear")).toBe(1);
    expect(costToEnter("rough")).toBe(2);
    expect(costToEnter("heavyWoods")).toBe(3);
    expect(costToEnter("pavement")).toBe(1);
  });
});

describe("core rulebook terrain values", () => {
  it("wood types provide screening and to-hit modifiers", () => {
    expect(screeningPoints("lightWoods")).toBe(1);
    expect(screeningPoints("heavyWoods")).toBe(2);
    expect(terrainTargetMod("lightWoods")).toBe(1);
    expect(terrainTargetMod("heavyWoods")).toBe(2);
  });

  it("clear / rough / rubble / pavement provide no screening or to-hit mod", () => {
    for (const t of ["clear", "rough", "rubble", "pavement"] as const) {
      expect(screeningPoints(t)).toBe(0);
      expect(terrainTargetMod(t)).toBe(0);
    }
  });

  it("water1 grants partial cover (no standalone target mod)", () => {
    expect(terrainTargetMod("water1")).toBe(0);
    expect(hasPartialCover("water1")).toBe(true);
  });

  it("water2 and water3 block targeting in/out", () => {
    expect(blocksTargeting("water2")).toBe(true);
    expect(blocksTargeting("water3")).toBe(true);
    expect(blocksTargeting("water1")).toBe(false);
  });

  it("building types grant partial cover and have escalating MP costs", () => {
    const costs: Partial<Record<TerrainType, number>> = {
      lightBuilding: 1,
      mediumBuilding: 2,
      heavyBuilding: 3,
      hardenedBuilding: 4,
    };
    for (const type of Object.keys(costs) as TerrainType[]) {
      expect(terrainMoveCost(type)).toBe(costs[type]);
      expect(hasPartialCover(type)).toBe(true);
    }
  });
});
