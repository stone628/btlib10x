# btlib10x API Reference

Zero-dependency TypeScript library implementing a **subset of BattleTech
Total Warfare rules** (bipedal 'Mechs only). All rule functions are pure and
deterministic given an injected RNG (`interface Rng { d6(): number }`).
Everything below is exported from the package root (`btlib10x`).

**Coordinates are 1-based** throughout: hex columns/rows, map bounds, terrain,
and unit positions all use the mapsheet labels (`cols 1..width`,
`rows 1..height`). There is no 0-based convention and no conversion layer.

**Surface is explicit.** `src/index.ts` uses `export { … }` lists, not
`export *`. Anything not listed below is an engine-internal helper and is not
considered public API. If you need a helper that isn't listed, import it
directly from its source module.

## Core

### Types (`core/types.ts`)

| Type | Values |
| --- | --- |
| `Facing` | `"n" \| "ne" \| "se" \| "s" \| "sw" \| "nw"` (hexside; clockwise from north) |
| `TerrainType` | `"clear" \| "lightWoods" \| "heavyWoods" \| "rough" \| "rubble" \| "pavement" \| "water1" \| "water2" \| "water3" \| "lightBuilding" \| "mediumBuilding" \| "heavyBuilding" \| "hardenedBuilding"` |
| `HexCoord` | `{ col: number; row: number }` (1-based odd-q, flat-top) |
| `HexCell` | `{ terrain: TerrainType; level: number }` (per-cell terrain + elevation) |
| `TerrainHexDef` | `{ col: number; row: number; type: TerrainType; level?: number }` (map data + setup; level optional, default 0) |
| `MoveMode` | `"standStill" \| "walk" \| "run" \| "jump" \| "prone"` |
| `Location` | `"head" \| "centerTorso" \| "rightTorso" \| "leftTorso" \| "rightArm" \| "leftArm" \| "rightLeg" \| "leftLeg"` |
| `WreckState` | `{ unitId: string; level: 1 \| 2 }` (ejected/pilot-killed obstacle) |
| `Rng` | `{ d6(): number }` — inject into every rules call |

`FACINGS` lists `Facing` in clockwise order; `isFacing(v)` validates runtime
values; `rotateFacing(f, steps)` / `oppositeFacing(f)` handle rotation.
`LOCATIONS` lists all locations; `isLocation(s)` narrows a string;
`TERRAIN_TYPES` lists every `TerrainType`; `isTerrainType(v)` validates one.

### Dice (`core/dice.ts`)

- `rollD6(rng): number` (uniform 1..6)
- `roll2D6(rng): number` (sum of two)
- `D2D6_MIN = 2`, `D2D6_MAX = 12`, `D2D6_AUTO_SUCCESS = 2`, `D2D6_FUMBLE = 12`

### Hex geometry (`core/hex.ts`)

- `neighbor(hex, facing): HexCoord`, `neighbors(hex): HexCoord[]`,
  `isAdjacent(a, b)`
- `hexDistance(a, b): number`, `sameHex(a, b): boolean`
- `lineHexes(from, to): HexCoord[]` — center-to-center trace excluding both endpoints
- `bearing(from, to): Facing` — approximate sector toward `to` (undefined when identical)
- `bearingExact(from, to): Facing` — strict sector; throws when the target is
  centered on the source
- `Bearing` — type alias used by `bearingExact`'s return

### Locations (`core/locations.ts`)

- `TORSO_LOCATIONS` — readonly tuple `["centerTorso", "rightTorso", "leftTorso"]`
- `isArm(loc)`, `isLeg(loc)`, `isLimb(loc)`, `isTorso(loc)` — boolean predicates
- `shoulderOf(loc)` — side-torso that backs an arm location

### Terrain (`core/terrain.ts`)

Terrain properties (move surcharge, screening value, target to-hit modifier,
partial-cover and targeting-restriction flags) are data-driven from the
catalog in `src/data/terrain.json` (`TerrainDef` in `terrain.schema.ts`); the
helpers below read that catalog.

- `terrainMoveCost(t): number` surcharge; `costToEnter(t): number` (= 1 + surcharge)
- `screeningPoints(t): number` LOS-screening points per intervening hex;
  `woodsPoints` is the same value under its alias
- `terrainTargetMod(t): number` to-hit modifier when the target is inside the
  hex (e.g. light/heavyWoods +1/+2; water1 is 0 — partial cover, see below)
- `hasPartialCover(t): boolean`, `blocksTargeting(t): boolean` (water2/3
  block LOS in/out)
- `costToClimb(fromLevel, toLevel): number` (+1 per level changed, up or down)
- `cellAt(grid, hex): HexCell | undefined` — grid cell lookup
- `MP_PER_FACING_CHANGE = 1`, `MP_PER_LEVEL_CLIMB = 1`, `MP_TO_ENTER_HEX = 1`
- `HexGrid` — the typed grid shape consumed by `cellAt` / LOS rules

Also exported from `src/data/terrain.schema.ts`:

- `getTerrainDef(type): TerrainDef | undefined`,
  `getAllTerrainDefs(): ReadonlyMap<string, TerrainDef>` (read-only catalog)
- `TerrainDef` type: `{ moveCost, screeningValue, terrainMod, partialCover?, blocksTargeting? }`

## Data

### Weapon catalog (`data/weapon.schema.ts`)

```ts
interface WeaponDef {
  readonly name: string;
  readonly short: number;
  readonly medium: number;
  readonly long: number;          // max hexes per bracket
  readonly minRange?: number;     // closer-than-minimum-range penalty
  readonly damage?: number;       // direct fire
  readonly missiles?: number;     // cluster column (LRM/SRM)
  readonly missileDamage?: 1 | 2;
  readonly variableDamage?: readonly [number, number, number]; // V-code per bracket
  readonly pulse?: boolean;       // P-code (-2 to-hit)
  readonly antiInfantry?: boolean;
  readonly rapidFireShots?: number; // R-code max shots
  readonly streak?: boolean;      // SRM-Streak: full tube on success, no cluster roll
  readonly heat?: number;         // heat generated per shot
  readonly category: WeaponCategory; // "MISSILE" | "BALLISTIC" | "ENERGY"
}
```

- `getWeaponDefFor(h: WeaponNameHolder): WeaponDef` (throws on unknown names)
- `getAllWeaponDefs(): WeaponDef[]`
- `listWeaponNames(): string[]`
- `WeaponNameHolder` — minimal interface (`{ weapon: string }`) accepted by
  the `…For` lookup helpers
- `WeaponCategory` — `"MISSILE" | "BALLISTIC" | "ENERGY"`

### Ammo catalog (`data/ammo.schema.ts`)

- `AmmoDef` — per-bin ammo record (damage-per-shot, shots-per-bin)
- `AmmoNameHolder` — `{ weapon: string }` for lookup helpers
- `getAmmoDefFor(h): AmmoDef` (throws on unknown)
- `getAllAmmo(): readonly AmmoDef[]`
- `listAmmoWeapons(): string[]`
- `getShotsPerBinFor(h): number | undefined`

### 'Mech definitions (`data/mech.schema.ts`, `data/index.ts`)

The on-disk form is `MechDef` (written in `src/data/mechs/*.json`). It is
validated by `validateMechDef`, then resolved into the engine-facing
`ResolvedMechDef` by `resolveMechDef`.

```ts
interface MechDef {
  model: string; name: string; tonnage: number;   // 10..100
  weightClass: "Light" | "Medium" | "Heavy" | "Assault";
  techBase: string;
  walking: number; running: number; jumping: number; // running === ceil(walking*1.5)
  armor: Readonly<LocationValue> &
    Readonly<Partial<Record<"centerTorsoRear"|"leftTorsoRear"|"rightTorsoRear", number>>>;
  weapons: readonly WeaponMount[];
  critSlots: CritSlots;       // required; per-location table, see below
  heatsink: HeatSinkConfig;   // { type: "single"|"double"; count: number }
  source: string;
}
```

```ts
interface WeaponMount { weapon: string; location: Location; shots?: number }
```

Critical slots are a per-location table faithful to the record sheet:

```ts
type CritSlot =
  | { kind: "empty" }                             // re-rolls during crit selection
  | { kind: "weapon"; weapon: string }
  | { kind: "ammo"; weapon: string }
  | { kind: "structure"; name: CritStructureName }
  | { kind: "soak"; name: CritSoakName };         // endoSteel / ferroFibrous / case / caseII

type CritSlots = Readonly<Record<Location, readonly CritSlot[]>>;
```

Per-location slot counts (`CRIT_SLOT_COUNTS`): head/legs = 6, torso/arms = 12.
Structure names (`CRIT_STRUCTURE_NAMES`): cockpit, sensors, lifeSupport,
engine, gyro, heatSink, doubleHeatSink, jumpJet, shoulder, upperArmActuator,
lowerArmActuator, handActuator, upperLegActuator, lowerLegActuator,
footActuator, targetingComputer, hip. Soak names (`CRIT_SOAK_NAMES`):
endoSteel, ferroFibrous, case, caseII.

The engine-facing resolution keeps front and rear armor as **separate pools**
and derives internal structure:

```ts
interface ResolvedMechDef {
  model: string; name: string; tonnage: number;
  weightClass: ...; techBase: string;
  walking: number; running: number; jumping: number;
  armor: ResolvedArmor;                                // front armor only
  armorRear: ResolvedRearArmor;                        // 3 torso rear values
  internalStructure: LocationValue;                    // derived from tonnage
  weapons: Record<number, WeaponMount>;                // re-keyed 1..N (1-based)
  critSlots: ResolvedCritSlots;                        // weaponIndex-linked
  heatsink: HeatSinkConfig;
  source: string;
}
```

`ResolvedCritSlot` mirrors `CritSlot` but links weapon/ammo slots to their
1-based `weaponIndex` in `weapons`, and gives multi-slot structure components
(DHS) a `group` of sibling slot indices so one hit destroys the whole DHS.

- `getMechDef(model: string): ResolvedMechDef | undefined`
- `getMechDefFor(h: MechModelHolder): ResolvedMechDef` (throws on unknown)
- `getAllMechDefs(): ResolvedMechDef[]`
- `getUnitTonnage(h: MechModelHolder): number`
- `validateMechDef(def: MechDef): void` — hand-rolled validator; throws with
  all problems listed
- `resolveMechDef(def: MechDef): ResolvedMechDef`
- `MechModelHolder` — `{ model: string }` accepted by `…For` helpers
- `RearArmorKey` — `"centerTorsoRear" | "leftTorsoRear" | "rightTorsoRear"`
- `CRIT_SLOT_COUNTS`, `CRIT_STRUCTURE_NAMES`, `CRIT_SOAK_NAMES`

Bundled sheets: AS7-D (Atlas), BSW-X1, BZK-F3, CDA-3MA (Cicada), ENF-4R
(Enforcer), GRF-1N (Griffin), HBK-4G (Hunchback), HER-5SA (Hermes II),
MC-MKII-2 (Mad Cat Mk II), TW-Prime (Mad Cat), WHK-Prime (Masakari),
WVR-6R (Wolverine). See `docs/MTF.md` to add more.

### Battle maps (`data/map.schema.ts`, `data/index.ts`)

```ts
interface MapDef {
  name: string;
  width: number;    // cols 1..width (rulebook mapsheet labels)
  height: number;   // rows 1..height
  terrain: TerrainHexDef[];  // non-clear hexes only (level optional)
}
```

- `getMapDef(name: string): MapDef | undefined`
- `getMapDefFor(h: MapNameHolder): MapDef` (throws on unknown)
- `getAllMapDefs(): MapDef[]`
- `listMapNames(): string[]`
- `validateMapDef(def: MapDefSrc): void` — checks shape, integer coords,
  terrain type, 1-based bounds, duplicate hexes, and optional non-negative
  `level`; throws with all problems listed
- `MapNameHolder` — `{ mapName: string | null }` accepted by `getMapDefFor`

Bundled maps: `beginner`, `quickstart`, `test`, `testground`.

Map coordinates are already 1-based and match the engine directly, so there
is **no** `toEngineTerrain` conversion function anymore.

## Rules

### Initiative (`rules/initiative.ts`)

- `rollInitiative(teams: readonly number[], rng): InitiativeResult` — free
  function: 2D6 per team, ties reroll all
- `InitiativeResult` — `{ rolls: Record<number, number>; winnerTeam: number }`

### Heat (`rules/heat.ts`)

Heat is a public subsystem. Constants: `HEAT_CAP = 50`,
`AMMO_EXPLOSION_START_HEAT = 19`. Helpers:

- `engineInternalSinks(def): number` — engine-mounted sinks (excludes DHS)
- `dhsCritWidth(def): number` — slot width of the DHS chain
- `movementHeat(mode, mpSpent): number`
- `engineHitHeat(destroyedEngineSlots): number`
- `heatSinksOperational(def, critSlotsDestroyed): number`
- `heatDissipation(def, critSlotsDestroyed): number`
- `heatDissipationMax(def): number`
- `toHitHeatModifier(heat): number`
- `toHitHeatModifierWithThreshold(heat): { toHit: number; threshold: number }`
- `movementMpPenalty(heat): number`
- `movementMpPenaltyWithThreshold(heat): { penalty: number; threshold: number }`
- `effectiveMoveBudget(mode, movement, heat): number`
- `shutdownAvoid(heat): number`
- `shutdownAvoidWithThreshold(heat): { avoid: number; threshold: number }`
- `ammoExplosionAvoid(heat): number`
- `ammoExplosionAvoidWithThreshold(heat): { avoid: number; threshold: number }`
- `heatScaleEffects(heat): HeatScaleEffects`
- `largestAmmoBin(def, bins): LargestAmmoBin | null`
- `HeatScaleEffects`, `LargestAmmoBin` — return shapes

### Heat phase (`rules/game.ts` `resolveHeatPhase`)

Per TW p.159, the heat scale updates once at the heat phase: own heat
(movement + weapon + posture + engine crit, summed into `unit.heatPending`
during their producing phases) lands on the scale, dissipation subtracts,
and the result is the new `unit.heat`. The shutdown/restart and ammo-
explosion checks then read `max(startHeat, endHeat)` (the worst the scale
reached between phase entry and phase exit). Peak within the heat phase
has no separate meaning.

Engine crit heat is skipped for any non-online unit (`shutdown !== "not"`)
per TW p.160: *"even engine criticals generate no extra heat while shut
down."* Voluntary `manual` and pending `starting` shutdowns generate no
own heat at all.

The involuntary shutdown / restart roll convention is `roll >= avoid` =
success, matching the voluntary startup path and the ammo-explosion
check. The previous `roll <= avoid = fail` convention was off-by-one.

`unit.heat` is the previous-turn end value during the movement and weapon
attack phases. Own heat generated this turn does not affect to-hit or MP
budget until the heat phase runs.

### Movement (`rules/movement.ts`)

- `maxMovePoints(mode, walking, running, jumping)`
- `attackerMovementModifier(mode)` → 0/+1/+2/+3
- `targetMovementModifier(hexesEntered, jumped, immobile?=false)` → 0…+7 (+1
  jump bonus), or flat −4 when `immobile` (shut down / both legs destroyed)
- `facingChangeCost(facings)`
- `isForwardStep(from, to, facing)`, `isBackwardStep(from, to, facing)`
- `canPassThroughHex(occupantTeam, moverTeam)` — friends yes, enemies no
- `canEndMoveInHex(occupantTeam, moverTeam)` — never end on anyone
- `reachableLandings(start, startFacing, options): RevealedLanding[]` —
  enumerates every (hex, facing) reachable within the mode's MP budget, each
  with a movement `path` (`F` forward / `B` back / `R`/`L` turn). Ground
  charges 1 MP per turn and 1+terrain+1-per-level-changed per step (jump
  treats turns as free and ignores elevation). `ReachabilityOptions` includes
  `wreckAt?: (hex) => boolean`: hexes holding a wreck are excluded from
  landings and cannot be passed through.

Constants: `JUMP_MP_PER_HEX = 1`, `TARGET_IMMOBILE_MOD = -4`,
`TARGET_JUMP_BONUS = 1`, `FORWARD_LEVEL_CHANGE_MAX = 2`,
`BACKWARD_LEVEL_CHANGE_MAX = 0`.

Types: `MoveFragment` (`"F" | "B" | "R" | "L" | "J" | "U"`),
`MovePathStep`, `RevealedLanding`, `ReachabilityOptions`.

### Line of sight (`rules/los.ts`)

- `interveningHexes(from, to): HexCoord[]`
- `losWoodsPoints(terrains): number`, `losBlocked(points): boolean` (≥3 blocks)
- `losWoodsPointsBetween(grid, from, to): number`
- `interveningTerrains(grid, from, to): TerrainType[]`
- `losBlockedByWater(grid, from, to)` — true when either endpoint hex is
  water2/water3 (units cannot fire into or out of depth-2+ water)
- `losBlockedByElevation(grid, from, to)` — draws a real-valued ray from
  attacker to target LOS level (hex level + 1); an intervening hex blocks iff
  its own LOS level exceeds the ray's height at its center
- `losBlockedByBuilding(grid, from, to)`
- `losBlockedByWreck(grid, from, to, wrecks?)` — true when a level-2 wreck
  hex lies strictly between the endpoints (independent of elevation)
- `losClear(grid, from, to, wrecks?)` — true when screening, water,
  elevation, and wreck LOS checks are all clear

### Buildings (`rules/building.ts`)

- `BuildingType` — `"light" | "medium" | "heavy" | "hardened"`
- `BuildingState` — `{ cf: number; type: BuildingType }`
- `buildingTypeOf(terrain): BuildingType | undefined`
- `isBuildingTerrain(terrain): boolean`
- `buildingAt(grid, hex): BuildingState | undefined`
- `createBuildingState(type): BuildingState` — initial CF from the sub-type
  (light 15 / medium 40 / heavy 90 / hardened 150)
- `initialCf(type): number` — bare lookup of the initial CF value
- `applyBuildingDamage(state, damage): BuildingState` (CF clamped at 0)
- `isCollapsed(state): boolean` (CF ≤ 0)
- `collapseToRubble(cell)` — mutates a building hex cell to `"rubble"`

In the battle engine (`rules/game.ts`), `createBattle` initializes
`BattleState.buildings["col,row"]` for each building hex in `terrain`.
`damageBuildingAt(state, hex, damage)` drains a building's CF, collapses it
to rubble on reaching 0 (emitting a `buildingCollapsed` event), and returns
the event (or `null` when the hex has no building). Weapon damage that lands
on a unit standing in a building hex is automatically applied to that
building's CF during attack resolution.

### Arcs (`rules/arcs.ts`)

- `Arc` — `"front" | "rear" | "leftSide" | "rightSide"`
- `isInFrontArc(facing, bearingToTarget)` — front three hexsides only
- `classifyArc(facing, bearingToTarget): Arc`
- `classifyArcWithBoundary(facing, bearingToTarget): Arc` — boundary-aware
  variant used by the engine
- `weaponCanFireIntoArc(weapon, arc): boolean` — arc eligibility for a
  weapon mount
- `effectiveFacingForTwist(attackerFacing, weaponMount)` — torso-twist
  override (per-weapon facing override is not yet wired; returns the
  attacker facing)

Every accepted attack classifies its target into an arc at declaration time
(`declareAttacks` records it on the `AttackDecl`); the arc drives the
side/rear hit-location tables and the front/rear armor pool.

### To-hit (`rules/tohit.ts`)

```ts
computeToHit({
  gunnery, attackerMovement, targetHexesMoved, targetJumped, targetImmobile?,
  targetPartialCover?, targetTerrain, interveningWoods, distance, weapon,
  attackerLevel?, targetLevel?,
}): ToHitBreakdown
```

GATOR stack: gunnery + attacker move + target move + terrain + range bracket
(S 0 / M +2 / L +4) + pulse (−2) + minimum-range penalty; auto-hit ≤ 2,
auto-miss > 12. `targetImmobile` (shut down or both legs destroyed) sets
`targetMod` to −4.
`targetPartialCover` (target in water1/building hex with attacker not higher)
adds +1 to `terrainMod`; the caller also maps leg hit-location rolls to
cover strikes. `damageForBracket(weapon, bracket)` resolves plain/V damage
values. `proneTargetModifier(distance)` returns a bonus to hit prone
adjacent targets. `ToHitBreakdown` carries the individual mods,
`rangeBracket`, `automatic`, and `outOfRange`. `RangeBracket` is
`"short" | "medium" | "long"`. `AttackModifiers` is the argument shape.

### Hit location & clusters (`rules/hitlocation.ts`, `rules/cluster.ts`)

- `HIT_LOCATION_TABLE`, `LEFT_SIDE_TABLE`, `RIGHT_SIDE_TABLE` — readonly
  records keyed by 2D6 roll
- `hitLocation(roll2d6): Location` — 2 CT · 3-4 RA · 5 RL · 6 RT · 7 CT ·
  8 LT · 9 LL · 10-11 LA · 12 head
- `hitLocationForArc(arc, roll2d6): Location` — uses `LEFT_SIDE_TABLE` /
  `RIGHT_SIDE_TABLE` for side arcs; front and rear share `HIT_LOCATION_TABLE`
- `clusterHits(missiles, roll)` — full TW p. 116 table, weapon-size columns
  2–30 plus 40 (missiles and rapid-fire shots share it); `CLUSTER_COLUMNS`
  and `CLUSTER_TABLE` are the underlying data
- `groupMissiles(total, lotSize)` — LRM lots of five

### Internal structure (`rules/internalStructure.ts`)

- `internalStructureForTonnage(tonnage): Record<Location, number>` —
  standard TW table (20–100t in 5t rows), head always 3
- `HEAD_STRUCTURE = 3`, `STANDARD_INTERNAL_STRUCTURE` — the underlying table

### Damage (`rules/damage.ts`)

Layered damage state:

```ts
interface UnitDamageState {
  armor: Record<Location, number>;               // front armor per location
  armorRear: Partial<Record<Location, number>>;  // rear torso pools
  internalStructure: Record<Location, number>;
}
```

`applyDamage(damage: UnitDamageState, location, amount, options?): DamageApplication`
— drains the active armor pool (front, or rear for rear-arc torso hits),
then that location's internal structure, then transfers inward (arms/legs →
side torso → center torso; head/CT terminal). `DamageOptions` carries the
arc (`"front"` default) and other resolution flags.

```ts
interface DamageApplication {
  damage: UnitDamageState;
  steps: { location; pool: "armor"|"armorRear"|"structure"; damageApplied; depleted }[];
  newlyDestroyed: Location[];
  blownOffArms: Location[];
  killed: boolean;
}
```

`DamageTransferStep` is the per-step shape used in `steps`.

Predicates: `isUnitDestroyed(damage)` (head or CT IS gone),
`isUnitImmobile(damage)` (either leg IS gone),
`isUnitLocationDestroyed(damage, loc)`,
`canFireFromLocation(damage, loc)` (location + its support torso intact).
Side-torso IS death blows off the arm.

### Critical hits (`rules/critical.ts`)

```ts
resolveCriticalHits({
  rng; def; source: { location; damage };
  critSlotsDestroyed; destroyedWeapons; damage; ammoBins;
}): CriticalResolution
```

Runs the TW Determining Critical Hits table (2D6: 2-7 none, 8-9 one, 10-11 two,
12 blow-off on head/arm/leg or three on torso), per-location slot rolls (1D6
head/legs, 2D6 half+slot torso/arms), re-rolls on empty/soak/destroyed slots,
and inward transfer (head/CT terminal; excess lost). Effects: weapon destroyed,
ammo explosion (per-shot damage × remaining shots applied directly to the
bin's IS with cascading crits), inert-ammo crit (`ammoNoExplosion` — gauss
rifle and similar rounds do not detonate; the bin still empties), limb/head
blown off, cockpit kill, and leg-actuator/hip/jump-jet destruction tracked
for movement.

`CriticalResolution` exposes `rows` (the individual `CriticalEffect`s),
`determiningRoll`, `throughArmor` (true when the roll came from a hit-location
2 with armor unbreached), and the resulting `critSlotsDestroyed` /
`destroyedWeapons` / `damage` / `blownOffArms` / `killed` / `ammoBins`.

- `effectiveMovement(def, critSlotsDestroyed): EffectiveMovement` — computes
  walking/running/jumping after leg-actuator (−1 walk each), hip (halves
  walking), and jump-jet (−1 jump each) crit damage.
- `applyAmmoExplosion(bins, weaponIndex, damage, ...): { bins, damage, crits }`
  — runs the explosion damage + cascading crits separately from
  `resolveCriticalHits` (used when only the explosion side is needed).
- `ammoDamagePerShot(weapon, ammo)` — per-shot damage figure for a weapon
  + ammo pair.
- `checkCASE(ammoBin, ...): CaseKind` — returns the CASE protection kind for
  the ammo bin (used to decide whether the explosion hits the bin only).
- `countDestroyedEngine(slotsDestroyed): number` — engine crit count
  for heat dissipation.
- `CaseKind` (`"none" | "case" | "caseII"`), `CriticalEffect`,
  `CriticalResolution`, `CritSource` (the crit-source record carried into
  the resolver), `EffectiveMovement`.

### Single attack (`rules/attack.ts`)

```ts
resolveWeaponAttack(input: WeaponAttackInput): AttackResolution
```

```ts
interface WeaponAttackInput {
  rng; gunnery; attackerMoved; targetHexesMoved; targetJumped; targetImmobile?;
  targetTerrain; interveningTerrains; distance; weaponName;
  shots?: number;             // rapid-fire volley; defaults 1
  targetDamage: UnitDamageState;
  arc?: Arc;                  // defaults "front"
  attackerLevel?; targetLevel?;
  partialCoverMod?;           // wreck cover (+2) merged with terrain (larger wins)
  targetDef?; targetCritSlotsDestroyed?; targetDestroyedWeapons?; targetAmmoLeft?;
}
```

Handles to-hit roll, jam on natural 2 for multi-shot rapid fire, SRM
per-missile vs LRM lots-of-five locations, arc-aware location selection, and
folds all hit groups into one cumulative `DamageApplication`. When the target
stands in a water1/building hex and the attacker is not higher, partial cover
applies: +1 to-hit and a leg hit-location roll strikes the cover (the group
is dropped). A supplied `partialCoverMod` merges with the terrain value
(larger wins): the engine-wide `rules/game.ts` `partialCoverMod` returns 2
when the target is adjacent to a level-2 wreck and the attacker is below the
wreck's top. When `targetDef` + crit snapshots are supplied, it also runs
critical-hit resolution per group that stripped IS — plus one unconditional
determining roll per group whose hit-location roll was a 2 (through-armor
critical, damage still lands on armor normally; tagged `throughArmor` on the
group and the resolution) — and folds ammo-explosion damage into the
returned application. It does **not** mutate the target; callers copy from
`resolution.application.damage` and `resolution.crits[last]`.

`AttackResolution` = `{ weapon; distance; breakdown; toHitRoll; hit; jammed;
prone; propArm; clusterRoll; groups; application; arc; crits }` — `arc` is
the firing arc the attack resolved against (drives the hit-location table
and armor pool); `prone` marks shots fired while prone and `propArm` (null
when standing or with no arm weapons) names the propped arm. Each `groups`
entry carries `throughArmor` (true on a hit-location roll of 2). `HitGroup`
is the per-group shape. `PARTIAL_COVER_TERRAIN_MOD = 1` is the constant used
when the target is in a partial-cover hex.

### Fireability (`rules/fireability.ts`)

- `suggestFireTargets(state, unitId): FireSuggestion` — for every enemy,
  lists the weapons that could reach it (arc, LOS, range, ammo, not
  jammed/destroyed, not auto-missing, not leg-blocked while prone) with their
  computed TN and expected damage, plus per-weapon block reasons
  (`FireBlockerReason`: `jammed` / `destroyed` / `outOfRange` / `outOfArc` /
  `noLos` / `outOfAmmo` / `autoMiss` / `prone` / `noSensor` — blind after
  the second destroyed sensor slot). Each `FireTarget` carries the
  classified `arc` and each `FireWeapon` its own `arc`. When the attacker is
  prone, each target also carries `weaponsIfPropLeft` / `weaponsIfPropRight`
  (+ matching blocked lists): a legal prone volley draws from exactly one
  side. Mirrors `declareAttacks` checks.
- `bestFireTarget(state, unitId): FireTarget | null` — highest-expected-
  damage suggestion across the enemy's targets.
- `compareFireTargets(a, b): number` — ordering helper for `bestFireTarget`.
- `fireTargetScore(target): number` — score function used by `compareFireTargets`.
- `FireBlocked` — the structured "why blocked" record for a weapon against
  a target (subset of `FireBlockerReason` plus target info).
- `FireSuggestion` — top-level return shape.

### Piloting (`rules/piloting.ts`)

PSR, consciousness, fall direction, and supporting constants.

- `DEFAULT_PILOTING = 5`, `PILOT_HITS_DEAD = 6`, `PSR_DAMAGE_THRESHOLD = 20`
- `SENSOR_ONE_HIT_MOD = 2`, `SENSOR_BLIND_HITS = 2`, `SENSORS = "sensors"`
- `sensorAttackModifier(destroyedSensors): number`
- `sensorsBlind(destroyedSensors): boolean`
- `LEG_ACTUATORS`, `LEG_DESTROYED_MOD = 5`, `HIP_MOD = 2`,
  `LEG_ACTUATOR_MOD = 1`, `GYRO_HIT_MOD = 3`, `GYRO_DESTROYED_HITS = 2`
- `countDestroyedStructure(slots, kind): number`
- `destroyedLegStructures(slots): { left, right }`
- `rollPilotingCheck({ target, modifier, rng }): { roll; success }`
- `preexistingDamageModifier(damage: PreexistingDamage): number`
- `FALL_TONNAGE_DIVISOR = 10`, `FALL_CLUSTER_SIZE = 5`
- `consciousnessTarget(hits): number | null`
- `rollConsciousness(rng, target): { roll; success }`
- `fallingDamageTotal(tonnage, levelsFallen): number`
- `fallingDamageGroups(total): number[]`
- `rollFallDirection(rng): { roll } & FallDirection`
- `facingAfterFall(facing, shift): Facing`
- `buildingEntryModifier(terrain): number | null`
- `waterEntryModifier(terrain): number | null`
- `PreexistingDamage`, `FallDirection` — types

### Ammo helpers (`rules/ammo.ts`)

Bin identity + depletion helpers; used by the engine and exposed for
custom UIs.

- `AmmoPolicy` (`"exposed" | "core" | "spread" | "leastFirst"`)
- `AMMO_POLICIES`, `isAmmoPolicy(v)`, `parseAmmoPolicy(word)`
- `AmmoBins` — `Record<AmmoBinId, AmmoBinState>` (the per-bin map type)
- `ammoBinId(loc, slotIndex): AmmoBinId` — `"${loc}:${slotIndex}"`
- `collectAmmoBins(def): AmmoBin[]` — every bin in the resolved def
- `binsForWeapon(def, weaponIndex)`, `binsForWeaponName(def, weaponName)`
- `pooledShotsLeft(def, bins, weaponName): number`
- `pooledTotalsByWeaponName(def, bins): Readonly<Record<string, number>>`
- `loadAmmoBins(def): AmmoBins` — initial shot counts
- `ammoWeaponTotals(def, bins): Record<number, number>` — per-mount totals
- `consumeAmmo(def, bins, weaponIndex, needed, policy, rng): AmmoBins`
- `consumeAmmoForName(def, bins, weaponName, needed, policy, rng): AmmoBins`
- `drawOrderBins(bins, state, policy, rng): AmmoBin[]` — the per-policy
  draw order (with random tie-breaking via `rng`)
- `stripBinsInLocation(bins, loc)` — in-place drop of every bin in `loc`

## Battle state machine (`rules/game.ts`)

The engine is **in-place and `void`-returning**: rule functions mutate the
`BattleState` you pass directly and return `void` (read-only queries like
`nextActor` / `actorQueue` / `getUnit` return values without
touching combat state; `nextActor` and `actorQueue` lazily fill the cached
activation order on first use each phase). The engine never decides
winner: `gameLoop(state, rng, stopper)` advances transient phases until
caller-supplied `GameLoopStopper` returns true; victory checks live
outside engine (`checkSessionVictory` in `web/session.ts`, `checkVictory`
test helper in `tests/helpers.ts`).
The engine is single-threaded and non-concurrent; atomicity is **not**
guaranteed per rule call — callers that need all-or-nothing behavior (e.g. the
web session) hold a serializable snapshot and roll back on failure (see
`web/session.ts` `commitAtomic`), and `createBattle`/`advancePhase` commit at
the caller's boundary.

```ts
createBattle(units: UnitInit[], options?: CreateBattleOptions): BattleState
rollInitiativePhase(state, rng, sink: GameEvent[]): void                // initiative -> movement
executeMove(state, unitId, mode, steps, sink: GameEvent[], { finalFacing, rng }?): void  // declares mode + walks steps in one call
attemptStandUp(state, unitId, sink: GameEvent[], rng?): void            // movement phase only: prone unit tries to rise (one attempt per activation)
dropProne(state, unitId, sink: GameEvent[], rng?): void                // movement phase only: go prone voluntarily (1 MP, no heat, 1 front-column damage)
proneFacingTurn(state, unitId, facings, sink: GameEvent[]): void        // movement phase only: prone unit turns ±1 hexside
ejectPilot(state, unitId, sink: GameEvent[]): void                      // movement phase only: removes the unit (removed = "pilotEjected") and spawns a level-2 wreck in its hex
voluntaryShutdown(state, unitId, sink: GameEvent[], rng?): void        // movement phase only: shuts down ("manual") plus the immediate +3 shutdown PSR
attemptVoluntaryStartup(state, unitId, sink: GameEvent[], rng?): void  // startup attempt after a manual shutdown
declareAttacks(state, unitId, decls, sink: GameEvent[], rng?): void    // weaponAttack phase only
validateAttacks(state, unitId, decls, { twist? }?): void               // read-only gate check; throws on any rule violation without mutating state or emitting events. Returns the resolved volley metadata via `validateAttacksImpl`.
resolveAllAttacks(state, rng, sink: GameEvent[]): void                  // resolves every unit's declared attacks simultaneously, then runs the end-of-phase piloting sweep
applyFall(state, unitId, rng, opts, sink: GameEvent[]): void
applyPilotHits(state, unitId, hits, reason, rng, sink: GameEvent[]): void  // pilot damage + consciousness rolls
resolveHeatPhase(state, rng, sink: GameEvent[]): void                  // end-of-phase heat scale + shutdown PSRs
resolvePhasePiloting(state, rng, before, sink: GameEvent[]): void       // end-of-phase PSR sweep against snapshots
passMovement(state, unitId): void                                       // mark "passed" for the current activation
damageBuildingAt(state, hex, damage, sink: GameEvent[]): BuildingDamageResult | null   // drains a building hex's CF, collapses to rubble on reaching 0
inferPronePropArm(state, unitId): { arm: "leftArm"|"rightArm"|null }  // hint for the web UI when picking a prone volley side
wreckAt(state, hex): WreckState | undefined
partialCoverMod(state, targetHex, attackerLevel): number  // engine-wide partial-cover modifier (wreck cover +2 etc.)
advancePhase(state, sink: GameEvent[], rng?): void                      // drives the phase cycle, pushes `phase` event into sink
nextActor(state): string | null                      // alternating activation hint (skips unconscious units)
actorQueue(state): { acted: string[]; pending: string[] }  // activation order view
gameLoop(state, rng, stopper: GameLoopStopper, sink: GameEvent[]): GameLoopResult  // transient phases until actor acts or stopper(state) true; GameLoopResult.events aliases sink
requireUnit(state, unitId): UnitState
```

`GameLoopStopper = (state: BattleState) => boolean` — caller owns
stop condition. Engine returns `{ actorId; stopped; events }` with no
winner field. See `web/session.ts` `drive()` feeding
`checkSessionVictory` as stopper; tests use `checkVictory` helper in
`tests/helpers.ts` same role.

```ts
interface CreateBattleOptions {
  terrain: TerrainHexDef[];           // non-clear hexes, optional level; pass [] for a clear board
  width: number; height: number;      // board size in engine coords (must cover every unit/terrain hex)
  critsDisabled: boolean;             // suppress crit resolution
}
```

Predicates on unit state:

- `isNominal(state, unitId)` — alive, not destroyed/removed, not shutdown
- `isShutdown(state, unitId)`, `isImmobile(state, unitId)` — same
  `BattleState` view, narrower statuses
- `isUnitAvailable(state, unitId)` — alive and can act this phase
- `isUnitRemoved(state, unitId)` — true when `removed !== "not"`

Constants:

- `DEFAULT_RNG` — `() => Math.floor(Math.random() * 6) + 1`; injected into
  state by `createBattle` but available as a sensible default for
  `createBattle`-less flows
- `STAND_MP_COST`, `DROP_MP_COST` — MP costs for the stand-up / drop-prone
  voluntary actions
- `WRECK_LEVEL = 2`, `LIGHT_MECH_TONNAGE_MAX = 40`,
  `WRECK_COVER_BY_LEVEL = { 1: 1, 2: 2 }`,
  `WRECK_L2_ELEVATED_COVER_MOD = 1` — wreck constants
- `wreckLevelFor(tonnage): 1 | 2` — returns 1 for < 40t, 2 otherwise

Key types:

```ts
interface UnitInit { id; model; team; gunnery; piloting?; position: Hex; facing: Facing }

type MoveStep =
  | { kind: "enter"; to: Hex }      // forward/backward (ground) or adjacent hop (jump)
  | { kind: "turn"; facings: number };

interface AttackDecl { weaponIndex: number; targetId: string; rapidFire?: boolean }

type Phase = "initiative" | "movement" | "weaponAttack" | "end";

interface BattleState extends HexGrid {
  turn; phase; initiativeWinnerTeam;
  units: Record<string, UnitState>;
  cells: readonly HexCell[];          // per-hex { terrain: TerrainType; level: number }
  width: number; height: number;      // board size
  critsDisabled: boolean;
  actedThisPhase: string[];
  buildings: Record<string, BuildingState>;  // { cf; type } keyed "col,row"; building hexes only
  wrecks: Record<string, WreckState>;  // { unitId; level: 2 } keyed "col,row"; ejected-'Mech obstacles
}

interface UnitState {
  id; model; team; gunnery; position; facing;
  damage: UnitDamageState;            // updated as soon as damage lands
  phaseStartDamage: UnitDamageState;  // snapshot for weapon usability this phase
  ammoBins: AmmoBins;                 // per ammo-bin object, keyed "location:slotIndex"
  jammedWeapons: number[];
  critSlotsDestroyed: Record<Location, boolean[]>;
  destroyedWeapons: number[];
  moveMode; movesThisTurn; jumpedThisTurn; mpSpent;
  declaredAttacks; firedTargetId; passedAttacks;
  destroyed: DestroyedState;          // "not" | "headDestroyed" | "centerTorsoDestroyed" | "cockpitDestroyed" | "headBlownOff" | "engineDestroyed"
  removed: RemovedState;              // "not" | "destroyed" | "pilotEjected" | "pilotKilled"
  shutdown: ShutdownState;            // "running" | "shutDown" (manual) | "shutDownAuto"
}

type DestroyedReason = "headDestroyed" | "centerTorsoDestroyed" | "cockpitDestroyed" | "headBlownOff" | "engineDestroyed";
type DestroyedState = "not" | DestroyedReason;
type RemovalReason = "destroyed" | "pilotEjected" | "pilotKilled";
type RemovedState = "not" | RemovalReason;
type ShutdownState = "running" | "shutDown" | "shutDownAuto";

type GameEvent =
  | { kind: "turn"; turn }
  | { kind: "phase"; phase }
  | { kind: "initiative"; rolls; winnerTeam }
  | { kind: "moveDeclared"; unitId; mode }
  | { kind: "moved"; unitId; from; to; facing; steps }
  | { kind: "attacksDeclared"; unitId; decls }
  | { kind: "attackResolved"; attackerId; targetId; resolution }
  | { kind: "unitDestroyed"; unitId; reason: DestroyedReason }
  | { kind: "unitRemoved"; unitId; reason: RemovalReason }
  | { kind: "buildingCollapsed"; hex; cf }
  | ... ;                              // see src/rules/game.ts for the full union

interface ActorQueueActorView { id; team; shutdown; destroyed; removed }
type GameLoopStopper = (state: BattleState) => boolean;
interface GameLoopResult { actorId: string | null; stopped: boolean; }  // transient: nothing stored on BattleState
// No VictoryResult in engine. Winner checks live outside engine:
// SessionVictoryResult in web/session.ts, VictoryResult test helper in tests/helpers.ts.
```

Rules encoded by the state machine:

- **Damage deferral**: units keep fighting during the weapon attack phase even
  if destroyed mid-phase; kills are committed when advancing
  `weaponAttack -> end` (`destroyed`/`removed` set to the reason, e.g.
  `"centerTorsoDestroyed"` / `"destroyed"`; paired `unitDestroyed` +
  `unitRemoved` events returned). A pilot kill or eject sets only
  `removed` (`"pilotKilled"` / `"pilotEjected"`), leaving `destroyed = "not"`.
- **Weapon usability** is judged against `phaseStartDamage`.
- **Ammo** is deducted at declaration time; jams persist for the rest of the game.
- **Declaration validation**: weapon indexes are 1-based; one target per turn,
  front arc, unblocked LOS (woods + elevation), range check, rapid-fire limits
  (`rapidFire: true` only on R weapons), TN > 12 must be aborted (throws), one
  declaration per weapon per turn, destroyed/jammed weapons rejected.
- **Movement validation**: MP budget per mode (including crit-affected
  effective ratings), terrain costs, +1 MP per level changed up or down,
  forward steps capped at 2 levels per hex, backward steps may not change
  level, backward steps banned while running, turn costs 1 MP/hexside, stacking
  (pass-through friendly-only, never end on another 'Mech); jumping may pass
  over any unit, lands only on empty hexes, and picks its landing facing freely.
- Engine calls return transient `GameEvent[]` (formatted then discarded by the
  caller); `BattleState` stores no log, keeping snapshots small.

## Version (`version.ts`)

`VERSION: string` — build stamp of the bundled commit in
`YYMMDD-<short-git-hash>` form (e.g. `260901-e52ae41`); the
timestamp is the commit's committer time rendered in UTC, so the same commit
stamps identically on any machine. `scripts/build-web.mjs` and
`scripts/standalone-web.mjs` inject the literal stamp into the web bundles via
esbuild `define` (visible with the `ver` command in the CLI). The plain npm/tsc
build has no injection and resolves to `"dev"`.

## Console rendering

Board and 'Mech-sheet rendering is **web-layer code, not part of the package
root API** (the package root — `src/index.ts` — exposes no render functions).
The renderer lives in `web/render.ts`, `web/renderer.text.ts`, and
`web/format.ts`, and is documented in `docs/CLI.md` (see the `board`, `mode`,
`info map`, and `sheet` commands).

Key model: `web/render.ts` exposes a small facade over `web/renderer.text.ts`
(which the web CLI must not import directly). The render layer builds a
`BoardModel` (cells + per-character `CharStyle` hints keyed by `"col,row"`,
including `BoardModel.elevations` and team-colored `idStyles`) either from a
`BattleState` (`battleModel(state, overlay?, marks?, styles?)`), from a
`MapDef` (`mapModel(...)`), or from structured render info via
`createBoardModel(info)`; `boardToText(model)` returns the flat ASCII form and
`boardToSpans(model)` returns styled span runs. Commands produce board chunks
from a `BoardRenderInfo` (`{ map, units, reachables, reachableTeam }`) rather
than a pre-built model; reachable-hex clipping for the movement `mode` command
happens inside `createBoardModel` and the info is supplied by `reachableInfo`
in `web/format.ts`. The web terminal renders spans inside a `.board` container
whose font family, size and line spacing come from the CSS variables
`--font-board` / `--board-fs` / `--board-lh`; each terrain's color scheme is
its own set of variables (`--t-lightWoods`, `--t-heavyWoods`,
`--tb-heavyWoods`) in `web/index.html`.

## Public API check

The script `scripts/check-public-api.mjs` (`npm run lint:api`) diffs the
export surface of `dist/index.d.ts` against the names listed in this file.
Adding an export without a docs entry, or removing an export without
updating this file, will fail CI.
