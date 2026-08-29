export { roll2D6, rollD6 } from "./core/dice.js";
export {
  bearing,
  hexDistance,
  isAdjacent,
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
export * from "./core/types.js";
export type {
  MapDef,
  MechDef,
  RearArmorKey,
  ResolvedArmor,
  ResolvedMechDef,
  WeaponMount,
} from "./data/index.js";
export {
  getMapDef,
  getMechDef,
  MAP_DEFS,
  MECH_DEFS,
  resolveMechDef,
  toEngineTerrain,
  validateMapDef,
  validateMechDef,
} from "./data/index.js";
export type { WeaponDef } from "./data/weapons.js";
export { getWeapon, WEAPONS } from "./data/weapons.js";
export * from "./rules/arcs.js";
export type { AttackResolution, HitGroup, WeaponAttackInput } from "./rules/attack.js";
export { resolveWeaponAttack } from "./rules/attack.js";
export * from "./rules/cluster.js";
export * from "./rules/damage.js";
export * from "./rules/fireability.js";
export * from "./rules/game.js";
export * from "./rules/hitlocation.js";
export * from "./rules/initiative.js";
export * from "./rules/internalStructure.js";
export * from "./rules/los.js";
export * from "./rules/movement.js";
export * from "./rules/tohit.js";
