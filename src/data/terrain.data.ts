import { TERRAIN_TYPES, type TerrainType } from "../core/types";
import type { TerrainDef } from "./terrain.schema";

export const TERRAIN_DATA: ReadonlyMap<TerrainType, TerrainDef> = new Map<TerrainType, TerrainDef>(
  TERRAIN_TYPES.map((t) => [t, terrainData(t)]),
);

function buildSimpleTerrain(
  moveCost: number,
  screeningValue: number,
  terrainMod: number,
  ejectLandMod: number,
): TerrainDef {
  return {
    moveCost,
    screeningValue,
    terrainMod,
    partialCover: false,
    blocksTargeting: false,
    waterDepth: 0,
    ejectLandMod: (_) => ejectLandMod,
  };
}

function buildWaterTerrain(
  moveCost: number,
  waterDepth: number,
  blocksTargeting: boolean,
): TerrainDef {
  return {
    moveCost,
    screeningValue: 0,
    terrainMod: 0,
    partialCover: true,
    blocksTargeting,
    waterDepth,
    ejectLandMod: (_) => -1,
  };
}

function buildBuildingTerrain(moveCost: number): TerrainDef {
  return {
    moveCost,
    screeningValue: 0,
    terrainMod: 0,
    partialCover: true,
    blocksTargeting: false,
    waterDepth: 0,
    ejectLandMod: (level) => level,
  };
}

function terrainData(type: TerrainType): TerrainDef {
  switch (type) {
    case "clear":
      return buildSimpleTerrain(0, 0, 0, -2);
    case "lightWoods":
      return buildSimpleTerrain(1, 1, 1, 2);
    case "heavyWoods":
      return buildSimpleTerrain(2, 2, 2, 3);
    case "rough":
      return buildSimpleTerrain(1, 0, 0, 0);
    case "rubble":
      return buildSimpleTerrain(1, 0, 0, 0);
    case "pavement":
      return buildSimpleTerrain(0, 0, 0, -2);
    case "water1":
      return buildWaterTerrain(1, 1, false);
    case "water2":
      return buildWaterTerrain(3, 2, true);
    case "water3":
      return buildWaterTerrain(3, 3, true);
    case "lightBuilding":
      return buildBuildingTerrain(1);
    case "mediumBuilding":
      return buildBuildingTerrain(2);
    case "heavyBuilding":
      return buildBuildingTerrain(3);
    case "hardenedBuilding":
      return buildBuildingTerrain(4);
    default: {
      const unreachable: never = type;
      throw new Error(unreachable);
    }
  }
}
