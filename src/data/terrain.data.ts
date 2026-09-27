import type { TerrainDef } from "./terrain.schema";

export const TERRAIN_DATA: ReadonlyMap<string, TerrainDef> = new Map<string, TerrainDef>([
  ["clear", { moveCost: 0, screeningValue: 0, terrainMod: 0 }],
  ["lightWoods", { moveCost: 1, screeningValue: 1, terrainMod: 1 }],
  ["heavyWoods", { moveCost: 2, screeningValue: 2, terrainMod: 2 }],
  ["rough", { moveCost: 1, screeningValue: 0, terrainMod: 0 }],
  ["rubble", { moveCost: 1, screeningValue: 0, terrainMod: 0 }],
  ["pavement", { moveCost: 0, screeningValue: 0, terrainMod: 0 }],
  ["water1", { moveCost: 1, screeningValue: 0, terrainMod: 0, partialCover: true }],
  [
    "water2",
    { moveCost: 3, screeningValue: 0, terrainMod: 0, partialCover: true, blocksTargeting: true },
  ],
  [
    "water3",
    { moveCost: 3, screeningValue: 0, terrainMod: 0, partialCover: true, blocksTargeting: true },
  ],
  ["lightBuilding", { moveCost: 1, screeningValue: 0, terrainMod: 0, partialCover: true }],
  ["mediumBuilding", { moveCost: 2, screeningValue: 0, terrainMod: 0, partialCover: true }],
  ["heavyBuilding", { moveCost: 3, screeningValue: 0, terrainMod: 0, partialCover: true }],
  ["hardenedBuilding", { moveCost: 4, screeningValue: 0, terrainMod: 0, partialCover: true }],
]);
