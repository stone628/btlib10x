export * from "./core/types.js";
export { rollD6, roll2D6 } from "./core/dice.js";
export {
  bearing,
  hexDistance,
  lineHexes,
  neighbor,
  neighbors,
  sameHex,
} from "./core/hex.js";
export {
  costToEnter,
  MP_PER_FACING_CHANGE,
  MP_TO_ENTER_HEX,
  terrainMoveCost,
  woodsPoints,
} from "./core/terrain.js";

export { getMechDef, MECH_DEFS, validateMechDef } from "./data/index.js";
export type { MechDef, WeaponMount } from "./data/schema.js";
export { getMapDef, MAP_DEFS, toEngineTerrain, validateMapDef } from "./data/index.js";
export type { MapDef } from "./data/index.js";
export { getWeapon, WEAPONS } from "./data/weapons.js";
export type { WeaponDef } from "./data/weapons.js";

export * from "./rules/initiative.js";
export * from "./rules/movement.js";
export * from "./rules/los.js";
export * from "./rules/arcs.js";
export * from "./rules/tohit.js";
export * from "./rules/hitlocation.js";
export * from "./rules/cluster.js";
export * from "./rules/damage.js";
export type { AttackResolution, HitGroup, WeaponAttackInput } from "./rules/attack.js";
export { resolveWeaponAttack } from "./rules/attack.js";
export * from "./rules/game.js";
export { renderBattle } from "./render.js";
