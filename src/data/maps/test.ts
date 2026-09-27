import type { MapDefSrc } from "../map.schema";

const def: MapDefSrc = {
  name: "test",
  width: 7,
  height: 7,
  terrain: [
    {
      col: 4,
      row: 3,
      type: "heavyWoods",
    },
    {
      col: 5,
      row: 3,
      type: "lightWoods",
    },
    {
      col: 5,
      row: 4,
      type: "lightWoods",
    },
    {
      col: 6,
      row: 4,
      type: "lightWoods",
    },
  ],
} as const satisfies MapDefSrc;

export default def;
