import { TERRAIN_TYPES, type TerrainType } from "../core/types";
import type { TerrainDef } from "./terrain.schema";

export const TERRAIN_DATA: ReadonlyMap<TerrainType, TerrainDef> = new Map<TerrainType, TerrainDef>(
  TERRAIN_TYPES.map((t) => [t, terrainData(t)]),
);

function terrainData(type: TerrainType): TerrainDef {
  switch (type) {
    case "clear":
      return { moveCost: 0, screeningValue: 0, terrainMod: 0 };
    case "lightWoods":
      return { moveCost: 1, screeningValue: 1, terrainMod: 1 };
    case "heavyWoods":
      return { moveCost: 2, screeningValue: 2, terrainMod: 2 };
    case "rough":
      return { moveCost: 1, screeningValue: 0, terrainMod: 0 };
    case "rubble":
      return { moveCost: 1, screeningValue: 0, terrainMod: 0 };
    case "pavement":
      return { moveCost: 0, screeningValue: 0, terrainMod: 0 };
    case "water1":
      return { moveCost: 1, screeningValue: 0, terrainMod: 0, partialCover: true, waterDepth: 1 };
    case "water2":
      return {
        moveCost: 3,
        screeningValue: 0,
        terrainMod: 0,
        partialCover: true,
        waterDepth: 2,
        blocksTargeting: true,
      };
    case "water3":
      return {
        moveCost: 3,
        screeningValue: 0,
        terrainMod: 0,
        partialCover: true,
        waterDepth: 3,
        blocksTargeting: true,
      };
    case "lightBuilding":
      return { moveCost: 1, screeningValue: 0, terrainMod: 0, partialCover: true };
    case "mediumBuilding":
      return { moveCost: 2, screeningValue: 0, terrainMod: 0, partialCover: true };
    case "heavyBuilding":
      return { moveCost: 3, screeningValue: 0, terrainMod: 0, partialCover: true };
    case "hardenedBuilding":
      return { moveCost: 4, screeningValue: 0, terrainMod: 0, partialCover: true };
    default: {
      const unreachable: never = type;
      throw new Error(unreachable);
    }
  }
}
