# btlib10x API Reference

Zero-dependency TypeScript library implementing a **subset of BattleTech
Total Warfare rules** (bipedal 'Mechs only). All rule functions are pure and
deterministic given an injected RNG (`interface Rng { d6(): number }`).
Everything below is exported from the package root (`btlib10x`).

**Coordinates are 1-based** throughout: hex columns/rows, map bounds, terrain,
and unit positions all use the mapsheet labels (`cols 1..width`,
`rows 1..height`). There is no 0-based convention and no conversion layer.

**Surface is minimal and explicit.** `src/index.ts` uses `export { … }` lists, not
`export *`, and exposes only what a library consumer needs to set up and drive
a game plus read-only display helpers. Engine internals (`resolve*` / `apply*`
resolution plumbing, LOS/building internals, data-ingestion validators) are
**not** re-exported from the package root: they stay importable from their
source modules (`src/rules/*`, `src/data/*`) for tests and power users, but
they are absent from `btlib10x.js` / `dist/`. Anything not listed below is
internal. If you need a helper that isn't listed, import it directly from its
source module.

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
| `Rng` | `{ d6(): number }` — inject into every rules call |

`FACINGS` lists `Facing` in clockwise order;
`rotateFacing(f, steps)` / `oppositeFacing(f)` handle rotation.

### Dice (`core/dice.ts`)

- `rollD6(rng): number` (uniform 1..6)
- `roll2D6(rng): number` (sum of two)
- `D2D6_MAX = 12`

### Hex geometry (`core/hex.ts`)

- `hexKey(hex): string` — `"col,row"` key used by `buildings`, `wreckage` and `clubs`
- `neighbor(hex, facing): HexCoord`,
  `isAdjacent(a, b)`
- `hexDistance(a, b): number`, `sameHex(a, b): boolean`
- `bearingExact(from, to): Facing` — strict sector; throws when the target is
  centered on the source
- `Bearing` — type alias used by `bearingExact`'s return

### Locations (`core/locations.ts` — re-exported via `core/types.ts`)

- `isArm(loc)`, `isLimb(loc)`, `isTorso(loc)` — boolean predicates
- `shoulderOf(loc)` — side-torso that backs an arm location
- `ArmLocation`, `LegLocation`, `TorsoLocation` — location sub-types

### Terrain (`core/terrain.ts`)

Terrain properties (move surcharge, screening value, target to-hit modifier,
partial-cover and targeting-restriction flags) are data-driven from the
catalog in `src/data/terrain.data.ts` (`TerrainDef` in `terrain.schema.ts`).
The package root exposes only the grid lookup plus the facing-change cost:

- `cellAt(grid, hex): HexCell` — grid cell lookup
- `hexCell(terrain, level = 0): HexCell` — the shared, immutable cell instance for a terrain/level pair; grids and snapshots hold these instances instead of copies
- `waterDepth(terrain): number` — water depth of a terrain type (0 for dry
  land, 1–3 for water1/2/3)
- `MP_PER_FACING_CHANGE = 1`
- `HexGrid` — the typed grid shape consumed by `cellAt` and battle state

The rest of the terrain catalog (`terrainDef`, `allTerrainDefs`,
`terrainMoveCost`, `costToEnter`, `screeningPoints`, `terrainTargetMod`,
`hasPartialCover`, `blocksTargeting`, `costToClimb`, `groundLevel` — a hex's
level minus its water depth, i.e. the bed a ground unit stands on) is
engine-internal:
import it from its source module when needed.

`TerrainDef` type: `{ moveCost, screeningValue, terrainMod, partialCover?, blocksTargeting?, waterDepth? }`

## Data

Weapons, ammo, and terrain live inside the engine as embedded tables
(`src/data/weapons.data.ts`, `src/data/ammo.data.ts`, `src/data/terrain.data.ts`);
their registries self-populate on first read. 'Mechs and maps ship as one packed catalog,
`data/btlib10x.jsonl`, built by `npm run pack` from the canonical sources
(`data/mechs/*.json`, `data/maps/*.json`): line 0 is the manifest, the rest
are compact wire lines addressed by absolute line number. Load once, then
sheets decode and register on demand — heap cost is O(roster), not O(catalog):

```ts
import { ensureMapRegistered, loadCatalog } from "btlib10x";
const manifest = loadCatalog(await (await fetch("btlib10x.jsonl")).text());
for (const m of manifest.maps) ensureMapRegistered(m.name); // maps are tiny; register all
// mechs register lazily: `add <model>` decodes its line via ensureMechRegistered
```

For custom data, call the individual `registerMech` / `registerMechs` /
`registerMap` / `registerMaps` loaders (the weapon/ammo tables can be
overridden with `registerWeapons` / `registerAmmo` from their source modules,
before mechs — mech validation links crit slots against those catalogs).
`catalogMechs()` / `catalogMaps()` list the loaded catalog's manifest entries
and `registeredMechDefs()` / `registeredMapDefs()` list what is currently
registered. Tests use `registerAllCatalog` (source module) to register the
whole loaded catalog at once.

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
  readonly pulse?: boolean;       // P-code eligibility flag (TC / aimed-shot rules)
  readonly toHitMod?: number;     // To-Hit Mod column: -2 pulse, +1 MRM / Clan heavy lasers
  readonly antiInfantry?: boolean;
  readonly rapidFireShots?: number; // R-code max shots
  readonly clusterRangeMod?: WeaponClusterRangeMod; // per-bracket cluster-roll mod (HAG)
  readonly streak?: boolean;      // SRM-Streak: full tube on success, no cluster roll
  readonly heat?: number;         // heat generated per shot
  readonly physicalWeapon?: boolean; // hatchet / sword / retractable blade (strike attacks)
  readonly critExplosion?: number; // Gauss-family / HAG weapon-crit blast damage
  readonly heatEffect?: WeaponHeatEffect; // H-code heat-causing behavior (TW p.113)
  readonly category: WeaponCategory; // "MISSILE" | "BALLISTIC" | "ENERGY" | "EQUIPMENT"
}
```

`WeaponHeatEffect` = `{ kind: "asHeat" }` (flamer family: the Damage Value
is applied as heat instead of damage when the firing unit's `heatFlamer`
policy is on, TW p.303) | `{ kind: "extraHeat"; dice: 1 | 2 }` (plasma
weapons: that many D6 of heat on every hit, on top of `damage`; the CL Plasma
Cannon carries `damage: 0`, TW p.139). Validation: `asHeat` needs a positive
`damage`.

- `weaponDefFor(h: WeaponNameHolder): WeaponDef` (throws on unknown names)
- `allWeaponDefs(): WeaponDef[]`
- `isFireableWeapon(def: WeaponDef): boolean` — false for every `EQUIPMENT`
  row. Physical weapons strike through physical declarations; TAG, Narc,
  probes, ECM, AMS, MGA and pods await the equipment pipeline (VISION §4),
  so `declareAttacks` / `validateAttacks` refuse them and
  `suggestFireTargets` omits them
- `listWeaponNames(): string[]`
- `WeaponNameHolder` — minimal interface (`{ weapon: string }`) accepted by
  the `…For` lookup helpers
- `WeaponCategory` — `"MISSILE" | "BALLISTIC" | "ENERGY" | "EQUIPMENT"`

The table itself is embedded (`WEAPON_DATA` in `src/data/weapons.data.ts`,
the source of truth); `registerWeapons` replaces it wholesale.

### Ammo catalog (`data/ammo.schema.ts`)

Engine-internal (source-module import only): `AmmoDef`, `AmmoNameHolder`,
`ammoDefFor`,
`allAmmo`, `listAmmoWeapons`, `shotsPerBinFor`. The table itself is embedded (`AMMO_DATA` in
`src/data/ammo.data.ts`, the source of truth). A row's optional
`explosionDamagePerShot` sets its explosion damage per remaining shot where the
weapon row has no Damage Value to derive it from: AMS rounds and Narc pods
explode for 2 per shot (TW p.130, p.139). Unexpended A-Pods are not explosive
(TW p.130). The battle
engine resolves ammo bins itself; library consumers read per-mount shot counts
via the sheet helpers, not the catalog directly.

### 'Mech definitions (`data/mech.schema.ts`, `data/index.ts`)

The on-disk form is `MechDef` (written in `data/mechs/*.json`). Shipped
sheets arrive packed in `data/btlib10x.jsonl` and decode on demand via the
catalog loader; library consumers access them through the read-only
lookups below. `resolveMechDef`, `validateMechDef`, and the raw `mechDef` /
`mapDef` / `validateMapDef` ingestion helpers are engine-internal
(source-module import only).

```ts
interface MechDef {
  model: string; name: string; clanName?: string; callsign?: string; tonnage: number;   // 20..100, multiple of 5
  intro: number; // introduction year (Master Unit List) from the MTF `Intro:` header
  bv: number;    // Battle Value (Master Unit List, regular 4/5 pilot) from the MTF `BV:` header; 0 when the MUL lists none
  weightClass: WeightClass;   // must equal weightClassForTonnage(tonnage)
  techBase: string;
  walking: number; running: number; jumping: number; // running === ceil(walking*1.5); jumping === number of jumpJet crit slots; walking*tonnage <= 500
  armor: Readonly<LocationValue> &   // per location <= 2 x internal structure (torso front + rear together), head <= 9
    Readonly<Partial<Record<"centerTorsoRear"|"leftTorsoRear"|"rightTorsoRear", number>>>;
  weapons: readonly WeaponMount[];
  critSlots: CritSlots;       // required; per-location table, see below
  heatsink: HeatSinkConfig;   // { type: "single"|"double"; count: number }
  myomer: MyomerType;         // "Standard" | "Triple Strength Myomer" (TW p.143)
  source: string;
}
```

`validateMechDef` is the trust boundary for catalog packs, so besides the
shape it enforces the TechManual construction limits the engine relies on:
tonnage on the internal-structure grid (20..100 in 5-ton steps), engine
rating `walking * tonnage` at most 500 (`MAX_ENGINE_RATING`; standard
engines stop at 400, large engines reach 500), armor at most twice the
location's internal structure with torso front and rear counted together
(head 9, `MAX_HEAD_ARMOR`), every weapon mount naming a known weapon, and
`shots` only on weapons that have an ammo row.

`clanName` holds the MTF line-2 parenthesised Clan name (`Mad Cat
(Timber Wolf)` → `name: "Mad Cat"`, `clanName: "Timber Wolf"`); it stays
`undefined` when the parens are absent, even on Clan sheets. `callsign`
holds the MTF line-3 parenthesised pilot suffix (`BL-10-KNT (Ross)` →
`model: "BL-10-KNT"`, `callsign: "Ross"`) or quoted nickname; `model` never
contains whitespace. `WeightClass`
is `"Light" | "Medium" | "Heavy" | "Assault"`, inferred from tonnage with
`weightClassForTonnage` (≤35 Light, ≤55 Medium, ≤75 Heavy, else Assault).

```ts
interface WeaponMount { weapon: string; location: Location; shots?: number }
```

Critical slots are a per-location table faithful to the record sheet:

```ts
type CritSlot =
  | { kind: "empty" }                             // re-rolls during crit selection
  | { kind: "weapon"; weapon: string }
  | { kind: "ammo"; weapon: string }
  | { kind: "structure"; type: CritStructureName; name?: string } // name: record-sheet item name, required for "equipment"
  | { kind: "soak"; name: CritSoakName };         // endoSteel / ferroFibrous / case / caseII / tsm / stealthSystem

type CritSlots = Readonly<Record<Location, readonly CritSlot[]>>;
```

Per-location slot counts (`CRIT_SLOT_COUNTS`): head/legs = 6, torso/arms = 12.
Structure types (`CRIT_STRUCTURE_NAMES`): cockpit, sensors, lifeSupport,
engine, gyro, heatSink, doubleHeatSink, jumpJet, shoulder, upperArmActuator,
lowerArmActuator, handActuator, upperLegActuator, lowerLegActuator,
footActuator, hip, equipment, targetingComputer. `equipment` is gear the engine
does not model yet (ECM, probes, Artemis, MASC, ...): it takes criticals
(TW p.124) with no modelled effect, and its `name` says which item it is.
Equipment that gains a model gets its own type after `equipment`
(`targetingComputer` is the first). Soak names (`CRIT_SOAK_NAMES`, slots that
re-roll a critical): endoSteel, ferroFibrous, case, caseII, tsm,
stealthSystem (`tsm` = Triple-Strength Myomer, exactly 6 slots on TSM designs,
TW p.143; `stealthSystem` = Null-Signature / Chameleon LPS, treated like stealth
armor, TW p.142). Both lists are wire-ordered: the packed catalog stores
indexes.

The engine-facing resolution keeps front and rear armor as **separate pools**
and derives internal structure:

```ts
interface ResolvedMechDef {
  model: string; name: string; clanName?: string; callsign?: string; tonnage: number;
  intro: number; bv: number;
  weightClass: WeightClass; techBase: string;
  walking: number; running: number; jumping: number;
  armor: ResolvedArmor;                                // front armor only
  armorRear: ResolvedRearArmor;                        // 3 torso rear values
  internalStructure: LocationValue;                    // derived from tonnage
  weapons: Record<number, WeaponMount>;                // re-keyed 1..N (1-based)
  critSlots: ResolvedCritSlots;                        // weaponIndex-linked
  heatsink: HeatSinkConfig;
  myomer: MyomerType;
  source: string;
}
```

`ResolvedCritSlot` mirrors `CritSlot` but links weapon/ammo slots to their
1-based `weaponIndex` in `weapons`, and gives multi-slot structure components
(DHS) a `group` of sibling slot indices so one hit destroys the whole DHS.

- `mechDefFor(h: MechModelHolder): ResolvedMechDef` (throws on unknown)
- `mechDef(model: string): ResolvedMechDef | undefined` — lookup by exact model
- `registeredMechDefs(): ResolvedMechDef[]`
- `MechModelHolder` — `{ model: string }` accepted by `…For` helpers
- `RearArmorKey` — `"centerTorsoRear" | "leftTorsoRear" | "rightTorsoRear"`

Packed wire (`src/data/mech.codec.ts`, `src/data/map.codec.ts`,
`data/btlib10x.jsonl`): `encodeMechDef` / `encodeMapDef` pack a sheet to one
short-key line, `decodeMechLine` / `decodeMapLine` expand it back (both wire
version `1`: `WIRE_VERSION` / `MAP_WIRE_VERSION`). Sheet identity
(`model`/`name`/`techBase`/`tonnage`/`intro`/`bv`, optional `clanName`/`callsign` — the
`MechIdentity` shape) lives only in the line-0 manifest entry, never the
wire line: `decodeMechLine` takes it as a second argument, so each sheet is
single-sourced. Myomer rides the mech wire as numeric `y` (1 = Standard,
2 = Triple Strength Myomer); a missing `y` on older v1 lines decodes as
Standard. `parseCatalogManifest` / `findMechEntry` / `findMapEntry`
index the manifest (`CatalogManifest` with `MechManifestEntry` /
`MapManifestEntry`: short keys `m`/`n`/`b`/`t`/`i`/`c?`/`k?`/`l` plus the sheet's
absolute file line — class is inferred, never stored). `loadCatalog` holds
the text in memory; `appendCatalog(text, pack)` adds a pack beside it and
throws if a pack with that id is already loaded (each pack id loads once;
`loadCatalog` starts over); `ensureMechRegistered` / `ensureMapRegistered` decode and
register one sheet on demand (throwing duplicates stay an error via
`registerMech` / `registerMap`).

Bundled sheets: AS7-D (Atlas), BSW-X1, BZK-F3, CDA-3MA (Cicada), CN9-YLW2
(Centurion), ENF-4R (Enforcer), GRF-1N (Griffin), HBK-4G (Hunchback),
HCT-5S (Hatchetman), HER-5SA (Hermes II), MC-MKII-2 (Mad Cat Mk II),
TBR-Prime (Mad Cat), WHK-Prime (Masakari), WVR-6R (Wolverine). See `docs/MTF.md` to add more.

### Battle maps (`data/map.schema.ts`, `data/index.ts`)

```ts
interface MapDef {
  name: string;
  width: number;    // cols 1..width (rulebook mapsheet labels)
  height: number;   // rows 1..height
  terrain: TerrainHexDef[];  // non-clear hexes only (level optional)
  legends: TerrainType[];    // terrain types shown in the map legend
}
```

- `mapDefFor(h: MapNameHolder): MapDef` (throws on unknown)
- `registeredMapDefs(): MapDef[]`
- `listMapNames(): string[]`
- `MapNameHolder` — `{ mapName: string | null }` accepted by `mapDefFor`
- `MapDefSrc` — the on-disk map shape (as written in `data/maps/*.json`).
  Optional `clubs: MapClubSrc[]` (`{col, row, model, limb}`) and
  `wreckage: MapWreckageSrc[]` (`{col, row, model}`) start the battle with
  severed limbs and wreckage on the board; `createBattle` registers catalog
  models on demand (`ensureMechRegistered`, exact id only, as for units) and
  rejects unknown models and wreckage under 40 t.

Bundled maps: `beginner`, `quickstart`, `test`, `testground`.

Map coordinates are already 1-based and match the engine directly, so no
coordinate conversion is needed.

## Rules

### Initiative (`rules/initiative.ts`)

Engine-internal: `rollInitiative` and `InitiativeResult` (source-module
import only). The engine drives initiative itself via `gameLoop`; library
consumers observe the winner through the `initiative` event and `actorQueue`.

### Heat (`rules/heat.ts`)

Heat is a public subsystem. Constants: `HEAT_SCALE_MAX = 30` (top of the
printed scale; heat above 30 tracks unbounded in the overflow box per TW
p. 159, never clamped), `AMMO_EXPLOSION_START_HEAT = 19`. Helpers:

- `effectiveMoveBudget(mode, movement, heat): number`
- `heatDissipation(def, damage, critSlotsDestroyed): number` — dry dissipation
- `heatDissipationMax(def): number`
- `toHitHeatModifier(heat): number`
- `toHitHeatModifierWithThreshold(heat): { toHit: number; threshold: number }`
- `movementMpPenalty(heat): number`
- `movementMpPenaltyWithThreshold(heat): { penalty: number; threshold: number }`
- `shutdownAvoid(heat): number` — 0 when safe; `D2D6_IMPOSSIBLE` (13, unreachable) at 30+
- `ammoExplosionAvoid(heat): number`
- `ammoExplosionAvoidWithThreshold(heat): { avoid: number; threshold: number }`
- `heatScaleEffects(heat): HeatScaleEffects`
- `HeatScaleEffects`, `LargestAmmoBin` — return shapes
- `TSM_ACTIVATION_HEAT = 9` — end-of-turn heat activating TSM (TW p.143)
- `OUTSIDE_HEAT_CAP = 15` / `outsideHeatApplied(received): number` — outside
  heat (heat-causing weapons) a unit takes per turn; the excess is wasted
  (TW p.159)
- `isTsmActive(def, endHeat): boolean` — true for Triple-Strength Myomer
  designs at heat 9+; pass `unit.heat` (last turn's end value mid-turn)

Water cooling (TW p.159) is `waterHeatBonus(def, damage, critSlotsDestroyed,
depth, prone)` in `rules/heat.ts` (engine-internal; the heat phase adds it to
`heatDissipation`).

Engine-internal heat plumbing (source-module import only): `movementHeat`,
`engineHitHeat`, `engineInternalSinks`, `dhsCritWidth`,
`heatSinksOperational`, `largestAmmoBin`, `shutdownAvoidWithThreshold`.

### Heat phase (`rules/game.ts` `resolveHeatPhase`)

Per TW p.159, the heat scale updates once at the heat phase: own heat
(movement + weapon + posture + engine crit, summed into `unit.heatPending`
during their producing phases) lands on the scale, dissipation subtracts,
and the result is the new `unit.heat`. There is no upper clamp: heat above
30 persists in the overflow box and dissipates over later turns. The
shutdown/restart and ammo-explosion checks then read `endHeat`
(the post-dissipation Heat Scale per TW p.159 net update). Peak within
the heat phase has no separate meaning.

Engine crit heat is skipped for any non-online unit (`shutdown !== "not"`)
per TW p.160: *"even engine criticals generate no extra heat while shut
down."* A voluntary `manual` shutdown generates no own heat at all.

The involuntary shutdown / restart roll convention is `roll >= avoid` =
success, matching the voluntary startup path and the ammo-explosion
check. The previous `roll <= avoid = fail` convention was off-by-one.

Outside heat (TW p.159): heat-causing hits add to the target's
`unit.heatExternalPending` (event `heatInflicted`). The heat phase lands
`min(received, 15)` on the scale right after own heat, shut down or not
(event `heatExternal { unitId, received, applied, wasted }`), then
dissipates; `heatDissipated.external` carries the applied amount, so
`endHeat = startHeat + totalGenerated + external - dissip`. A unit that left
play drops its pending outside heat.

`unit.heat` is the previous-turn end value during the movement and weapon
attack phases. Own heat generated this turn does not affect to-hit or MP
budget until the heat phase runs.

### Movement (`rules/movement.ts`)

- `reachableLandings(start, startFacing, options): RevealedLanding[]` —
  enumerates every (hex, facing) reachable within the mode's MP budget, each
  with a movement `path` (`F` forward / `B` back / `R`/`L` turn). Ground
  charges 1 MP per turn and 1+terrain+1-per-level-changed per step, where
  levels are measured at a water hex's bed (hex level − depth); running
  cannot enter water except by Minimum Movement (TW p.53, p.57). Jump
  treats turns as free and ignores elevation, and never lands in, or makes a
  DFA from, a building hex (TW p.168; roofs are not modeled). A hex holding battlefield
  wreckage (`wreckageAt(hex)` option; `hasWreckage(state, hex)` from a battle)
  costs +1 MP as Rough stacked on its terrain (`hexEntryCost`; no repeat on
  rough, nothing in a standing building).
  `occupantTeam(hex)` reports a hull as `NEUTRAL_TEAM` (0): passable by every
  team, never a landing, and a charge / DFA target like an enemy;
  `occupantTeamAt(state, hex, excludeId?)` builds it from a battle.

Types: `MoveFragment` (`"F" | "B" | "R" | "L" | "J" | "U"`),
`MovePathStep` (`baseMp` per step), `RevealedLanding`, `ReachabilityOptions`.
`pathMp(path)` sums a path's `baseMp`: the MP the landing costs.

The remaining movement math (`maxMovePoints`, `attackerMovementModifier`,
`targetMovementModifier`, `facingChangeCost`, `isForwardStep`,
`isBackwardStep`, `canPassThroughHex`, `canEndMoveInHex`, and the
`JUMP_MP_PER_HEX` / `TARGET_IMMOBILE_MOD` / `TARGET_JUMP_BONUS` /
`FORWARD_LEVEL_CHANGE_MAX` / `BACKWARD_LEVEL_CHANGE_MAX` constants) is
engine-internal (source-module import only).

### Line of sight (`rules/los.ts`)

Engine-internal (source-module import only): `interveningHexes`,
`interveningTerrains`, `losWoodsPoints`, `losBlocked`,
`losWoodsPointsBetween`, `losBlockedByWater`, `losBlockedByElevation`,
`losBlockedByBuilding`, `losClear(grid, from, to, prone?)` (depth 2+ water, and depth 1+ water for a
prone 'Mech, block LOS at the endpoints; units, hulls and wreckage never block, TW p.100). The engine checks LOS
during declaration validation; library consumers observe the outcome through
`suggestFireTargets` block reasons (`noLos`) and `validateAttacks` errors.

### Buildings (`rules/building.ts`)

Engine-internal (source-module import only): `isBuildingTerrain` (type guard
for `BuildingTerrainType`, the four building `TerrainType`s in `core/types.ts`;
the terrain is the building's sub-type and nothing else stores it), `buildingAt`,
`createBuildingState`, `initialCf`, `applyBuildingDamage`, `isCollapsed`,
`collapseToRubble`, `assertBuildingsMatchCells`, `DEFAULT_BUILDING_LEVELS`. The battle engine tracks building CF itself;
library consumers observe collapses through `buildingCollapsed` events.

In the battle engine (`rules/game.ts`), `createBattle` initializes
`BattleState.buildings["col,row"]` for each building hex in `terrain`.
`damageBuildingAt(state, hex, damage)` drains a building's CF, collapses it
to rubble on reaching 0 (emitting a `buildingCollapsed` event), and returns
the event (or `null` when the hex has no building). A collapse records the
building's terrain in `BattleState.rubbleOrigin["col,row"]`, which girder
searches read. Each weapon grouping that
hits a unit standing in a building hex costs the hex a toll of ceil(CF at the
start of the phase / 10) per grouping (TW p. 171); the unit inside still takes
its full damage. CF reduction applies after all weapons fire completes, and a
collapse deals ceil(CF/10 x (1 + levels above)) in 5-point punch-table groups
plus standard falling damage above Level 0 (TW pp. 176-177).

### Arcs (`rules/arcs.ts`)

- `Arc` — `"front" | "rear" | "leftSide" | "rightSide"`
- `classifyArcWithBoundary(facing, bearingToTarget): Arc` — boundary-aware
  variant used by the engine
- `classifyFiringArc(from, to, facing): Arc | null` — the TW p.105 hex
  template: which arc of `from` (facing `facing`) the hex `to` falls in
- `weaponCanFireIntoArc(weapon, arc): boolean` — arc eligibility for a
  weapon mount

Every accepted attack classifies its target into an arc at declaration time
(`declareAttacks` records it on the `AttackDecl`); the arc drives the
side/rear hit-location tables and the front/rear armor pool.

### To-hit (`rules/tohit.ts`)

The GATOR stack (gunnery + attacker move + target move + terrain + range
bracket + weapon/minimum-range mods; auto-hit ≤ 2, auto-miss > 12) is resolved
inside the engine. The package root exposes the skill default and the
breakdown shapes for reading resolutions:

- `DEFAULT_GUNNERY = 4`
- `AttackModifiers` — the argument shape; `ToHitBreakdown` — the individual
  mods plus `rangeBracket`, `automatic`, and `outOfRange`; `RangeBracket` is
  `"short" | "medium" | "long"`
- `toHitTotal(breakdown)` — the modified to-hit number (sum of the mods,
  infinite out of range); nothing stores it

`computeToHit`, `damageForBracket`, and `proneTargetModifier` are
engine-internal (source-module import only).

### Hit location & clusters (`rules/hitlocation.ts`, `rules/cluster.ts`)

- `HIT_LOCATION_TABLE`, `LEFT_SIDE_TABLE`, `RIGHT_SIDE_TABLE` — readonly
  records keyed by 2D6 roll

The resolvers (`hitLocation`, `hitLocationForArc`, `punchHitLocation`,
`PUNCH_LOCATION_TABLE`, `clusterHits`, `modifiedClusterRoll`,
`groupMissiles`, plus `CLUSTER_COLUMNS` / `CLUSTER_TABLE` data) are
engine-internal except for the display tables above: `CLUSTER_COLUMNS` and
`CLUSTER_TABLE` stay public for the reference-table UI; import the resolvers
from their source modules when needed.

### Physical attacks (`rules/physical.ts`, TW pp. 144-147)

Punch, kick, club, and physical-weapon strikes, declared through
`declareAttacks` and gated by `validatePhysicalAttack` (see the state-machine
section). Charge and DFA are declared by `executeMove` instead: a walk / run
(charge) or jump (DFA) path whose last step enters an enemy hex stops the unit
in the hex before it, sets `UnitState.meleeCharge` (`MeleeCharge`) plus
`passedAttacks`, reports it as `moved.pendingCharge`, and is resolved by `resolveAllAttacks`
(`meleeDeclarationProblem` explains why a declaration is illegal; reachability
lists such hexes as `RevealedLanding.melee` when `meleeOk` is supplied; the
target's hex stays reserved for the attacker; a target that left is reported by
a `physicalAttackResolved` whose `resolution.missReason` is `"advanced"`
(`advancedTo` is the hex the attacker moved into) or
`"voided:hexTaken"` / `"voided:attackerDown"`). A target whose pilot left
stays a hull in its hex and is still struck. Charge damage is
`ceil(tonnage / 10 × hexes moved)`, not counting the target's hex (TW p.148),
so an adjacent charge deals no damage but still forces both +2 PSRs on a hit.
Deviation: TW allows charges/DFAs only against units that finished moving
(pp.148–149); the engine omits the move-order check. `PhysicalAttackType` is `"punch" |
"kick" | "club" | "strike" | "charge" | "dfa"` (`isMeleeCharge`); `PhysicalAttackDecl` carries `{ type, targetId,
limb?, weapon? }`; `PHYSICAL_WEAPONS` / `PhysicalWeaponStats` /
`PhysicalWeaponName` / `isPhysicalWeaponName` describe the hatchet / sword /
retractable blade table, and `strikeMounts` / `strikeMountArms` /
`strikeWeaponInArm` / `resolveStrikeMount` / `resolveStrikeArm` /
`StrikeMountResolution` find the mount a strike swings;
`PhysicalModifiers` is the to-hit breakdown (`physicalToHitTotal(mods)` sums it);
`damageGroupsTotal(groups)` sums a group list; `PhysicalResolution` carries the
roll, `DamageGroup` hits (`{ location, damage }`), one `DamageApplication` per
target / self-damage group (`applications` / `attackerApplications`,
armor-change detail via `blastDetail`) and
weapon-style `crits` (rendered with `critLines`) and the deferred kick PSR flags. `DamageGroup` is the per-group shape.

Club handling (TW p.146): `HeldClub`, `ClubKind` (`"limb" | "tree" |
"girder"`; a limb carries `limb`, `model` and `ownerId`, null for a limb the
map placed), `ClubGroundToken`, `SeveredLimb`, `ClubPickupDecl` (the request:
`source?`, 1-based `tokenIndex?`), `DeclaredPickup` (what `declarePickup`
stores in `UnitState.declaredPickup`: the resolved `source` and, when a ground
token was chosen, that `token`; resolution re-finds it by value),
`GIRDER_SEARCH_TARGET` (keyed by rubble-origin building terrain), `clubTokensInHex(state, hex)`,
`pickupSourceInHex(state, hex)`, `salvageableSeveredLimbs(unit)`,
`validatePickup(state, unitId, decl?)` and `declarePickup(state, unitId, decl,
sink)` (an exclusive, attack-phase pickup declaration). Both need two working
hands: `clubHandsFunctional(def, damage, destroyed)` (each arm standing with an
undestroyed hand actuator); a unit that loses them drops its club
(`clubDropped` with `cause: "hands"`).

The numeric tuning constants (`PUNCH_ATTACK_MOD`, `KICK_ATTACK_MOD`,
`CLUB_ATTACK_MOD`, `PUNCH_DAMAGE_PER_TONS`,
`KICK_DAMAGE_PER_TONS`, `CLUB_DAMAGE_PER_TONS`, `PHYSICAL_MIN_TOHIT`,
`PHYSICAL_MAX_TOHIT`) and the resolvers (`computePhysicalToHit`,
`physicalDamage`, `kickHitLocation`, `resolvePhysicalAttack`) are
engine-internal (source-module import only), as are the arm-actuator helpers
(`ARM_ACTUATOR_WEAPON_MOD`, `SHOULDER_WEAPON_MOD`, `armWeaponToHitModifier`,
`countArmActuators`, `ArmActuatorCounts`).

### Internal structure (`rules/internalStructure.ts`)

- `internalStructureForTonnage(tonnage): Record<Location, number>` —
  standard TW table (20–100t in 5t rows), head always 3

(`HEAD_STRUCTURE`, `STANDARD_INTERNAL_STRUCTURE` are engine-internal.)

### Damage (`rules/damage.ts`)

Layered damage state:

```ts
interface UnitDamageState {
  armor: Record<Location, number>;               // front armor per location
  armorRear: Partial<Record<Location, number>>;  // rear torso pools
  internalStructure: Record<Location, number>;
}
```
(`LocationValue` and `TorsoLocationValue` are the per-location value shapes.)

Damage is applied by the engine during attack resolution; the `applyDamage`
function itself is engine-internal (source-module import only). The shapes it
produces (`DamageApplication`, `DamageTransferStep`, `DamageOptions`) stay
exported for reading `AttackResolution.applications` steps.

Predicates: `isUnitDestroyed(damage)` (head or CT IS gone),
`isUnitImmobile(damage)` (both legs AND both arms gone — TW p.122),
`destroyedLegs(damage)`, `destroyedArms(damage)`,
`canAttemptStandUp(damage)` (TW p.50: false for 2-legs or 1-leg + 2-arms),
`canFireFromLocation(damage, loc)` (location intact; arms also need their
side torso, legs do not).
Side-torso IS death blows off the arm. One leg destroyed = walk MP 1,
running MP 0 (TW p.122), not immobile. `isUnitLocationDestroyed` is
engine-internal.

### Critical hits (`rules/critical.ts`)

```ts
// engine-internal; import from src/rules/critical.ts for tests:
resolveCriticalHits({
  rng; model; source: { location; damage };   // model: MechModelHolder, resolved via mechDefFor
  critSlotsDestroyed; damage; ammoBins;     // the CritState bundle
}): CriticalResolution
```

Runs the TW Determining Critical Hits table (2D6: 2-7 none, 8-9 one, 10-11 two,
12 blow-off on head/arm/leg or three on torso), per-location slot rolls (1D6
head/legs, 2D6 half+slot torso/arms), re-rolls on empty/soak/destroyed slots,
and inward transfer (head/CT terminal; excess lost).

`CriticalResolution` exposes `rows` (the individual `CriticalEffect`s),
`determiningRoll`, `throughArmor` (true when the roll came from a hit-location
2 with armor unbreached), and the resulting `critSlotsDestroyed` /
`damage` / `killedReason` / `ammoBins`. The rows are the only record of a
severed limb: `critSeveredLimbs(res)` lists them (a 12 on an arm or leg, and
an arm lost with a side torso a crit blast destroyed).
A destroyed weapon has no separate record: `isWeaponCritted(def, critSlotsDestroyed, i)`
is true when any slot of mount `i` is flagged (one critical hit on any slot destroys
it, TW p.124, and a catastrophic location wipe flags every slot), and
`crittedWeapons(def, critSlotsDestroyed)` lists them. A location lost to plain
damage flags nothing, so readers also check `canFireMount`.
`killedReason` is the first kill in the cascade (a later blast or engine crit
does not overwrite it); every damage path takes the unit's kill reason from the
first resolution that killed it, falling back to the head or center torso at 0 IS.
A `DamageApplication`'s `mechDestroyed` means the damage destroyed the 'Mech
(head or center torso at 0 internal structure, or a destroying crit, TW p. 128);
it says nothing about the MechWarrior, whose fate the destruction sweep resolves
(cockpit crit, center-torso ammo/weapon blast, Tactical Operations auto-eject).

- `ENGINE_SLOTS_KILL = 3` — engine hits that destroy the unit
- `effectiveMovement(def, damage, critSlotsDestroyed, tsmActive?, waterDepth?):
  EffectiveMovement` — computes walking/running/jumping after leg-actuator
  (−1 walk each), hip (halves walking), and jump-jet (−1 jump each) crit
  damage. `tsmActive` (from `isTsmActive`) adds the TW p.143 +2 Walking MP
  before damage (one-leg clamp still overrides); running recomputes from it.
  `waterDepth` applies TW p.53: no jumping from depth 2+, only non-leg jump
  jets at depth 1.
- `TSM_WALK_BONUS = 2` — TSM walking-MP bonus while active (TW p.143).
- `countDestroyedEngine(def, damage, critSlotsDestroyed): number` — engine
  crit count for heat dissipation.
- `componentHitStatus(def, damage, critSlotsDestroyed):
  ComponentHitStatus` — aggregate engine/gyro/sensors/life-support counts.
- `CaseKind` (`"none" | "case" | "caseII"`), `CriticalEffect`,
  `CriticalResolution`, `CritSource` (the crit-source record), `EffectiveMovement`.

Engine-internal crit plumbing (source-module import only):
`applyAmmoExplosion`, `ammoDamagePerShot`, `checkCASE`,
`countDestroyedSensor`.

### Single attack (`rules/attack.ts`)

Engine-internal (source-module import only): `resolveWeaponAttack` and its
`WeaponAttackInput` shape. Single shots resolve inside the engine during
`gameLoop`; library consumers read per-weapon outcomes from
`attackResolved` events carrying an `AttackResolution`:

`AttackResolution` = `{ weapon; distance; breakdown; toHitRoll; hit; jammed;
prone; propArm; clusterRoll; clusterMod; groups; applications; targetDamageAfter; arc; crits;
inflictedHeat? }` —
`applications` holds one exact `DamageApplication` per group that reached the
target, in order (the crits a group triggered resolve before the next group and
carry their own effects in `crits[].rows`); `targetDamageAfter` is the target's
damage after every group and crit (unchanged on a miss). `arc` is
the firing arc the attack resolved against (drives the hit-location table
and armor pool); `prone` marks shots fired while prone and `propArm` (null
when standing or with no arm weapons) names the propped arm. Each `groups`
entry carries `throughArmor` (true on a hit-location roll of 2). `HitGroup`
is the per-group shape. `inflictedHeat` (`InflictedHeat` = `{ heat; source:
"asHeat" | "extraHeat"; dice? }`) is set when a heat-causing weapon hit: a
heat-mode flamer (`WeaponAttackInput.heatMode`, from the attacker's
`heatFlamer`) and the Plasma Cannon roll no hit location and deal no damage
(empty `groups`, no crits); the Plasma Rifle throws its die after its damage
and crits resolve.

### Fireability (`rules/fireability.ts`)

- `suggestFireTargets(state, unitId, twist?, dropClub = false): FireSuggestion` — for every enemy,
  lists the weapons that could reach it (arc, LOS, range, ammo, not
  jammed/destroyed, not auto-missing, not leg-blocked while prone) with their
  computed TN and expected damage, plus per-weapon block reasons
  (`FireBlockerReason`: `jammed` / `destroyed` / `outOfRange` / `outOfArc` /
  `noLos` / `outOfAmmo` / `autoMiss` / `prone` / `noSensor` — blind after
  the second destroyed sensor slot / `clubHeld` — arm mount while a club
  occupies both hands, TW p.146). `dropClub` suggests the volley after
  dropping the club, as the same option on `declareAttacks` does; it is
  ignored when no club is held. Each `FireTarget` carries the
  classified `arc` (twisted torso facing) and each `FireWeapon` its own
  `arc`; leg mounts classify against the feet facing, ignoring the twist
  (TW p.105), exactly as `declareAttacks` does. When the attacker is
  prone, each target also carries `weaponsIfPropLeft` / `weaponsIfPropRight`
  (+ matching blocked lists): a legal prone volley draws from exactly one
  side. Mirrors `declareAttacks` checks. Non-fireable mounts
  (`isFireableWeapon` false: physical weapons and other `EQUIPMENT`) are
  omitted from both the weapon and the blocked lists.
- `bestFireTarget(state, unitId): FireTarget | null` — highest-expected-
  damage suggestion across the enemy's targets.
- `FireBlocked` — the structured "why blocked" record for a weapon against
  a target (subset of `FireBlockerReason` plus target info).
- `FireSuggestion`, `FireTarget`, `FireWeapon` — return shapes.
  (`compareFireTargets` / `fireTargetScore` are engine-internal.)

### Piloting (`rules/piloting.ts`)

`PilotingCheckReason` tags why a PSR was rolled (carried on `pilotingCheck`
events). `DEFAULT_PILOTING = 5`, `GYRO_HIT_MOD = 3`, `GYRO_DESTROYED_HITS = 2`,
`SENSOR_BLIND_HITS = 2`, `DEFAULT_PILOT_HIT_MAX = 6`, and
`consciousnessTarget(hits, hitMax = 6): number | null` (pilot-hit consciousness
TN; `null` once `hits >= hitMax`; the TW table is scaled to `hitMax`: 5 → 3,5,10,11,
6 → 3,5,7,10,11, 7 → 3,5,7,7,10,11). `isValidPilotHitMax`, `EJECTION_BASE_MODIFIER`,
`ejectionModifier(input)` / `ejectionLandingModifier(terrain, level)` (TO p.165 table)
and `ejectionDamage(roll)` (floor(margin of failure / 2)) support ejection.

### Pilot (`rules/pilot.ts`)

`isPilotUnconscious(unit)` is true while `unconsciousSinceTurn` is set (the
turn of the knockout; cleared on waking), the only record of consciousness.
`pilotStatus(unit): "active" | "unconscious" | "ejected" | "abandoned" | "dead"` is the pilot's
relation to the 'Mech, derived from `pilotHits`/`pilotHitMax`/`unconsciousSinceTurn`/`removed`
(`dead` once the hits reach the max, else `ejected` / `abandoned` by the removal reason).
`pilotRecord(unit)` returns `{ gunnery, piloting, hits, hitMax, hp, nextTarget, targets, status }`
for record-sheet display (`hp = hitMax - hits`). `FallDirection` and
`PreexistingDamage` are the related shapes.

The PSR/fall machinery (`rollPilotingCheck`, `preexistingDamageModifier`,
`fallingDamageTotal`, `fallingDamageGroups`, `rollFallDirection`,
`facingAfterFall`, `rollConsciousness`, `buildingEntryModifier`,
`waterEntryModifier`, `sensorAttackModifier`, `sensorsBlind`, and the
`FALL_*` / `HIP_MOD` / `LEG_*` / `PILOT_HITS_DEAD` / `PSR_DAMAGE_THRESHOLD` /
`SENSOR_ONE_HIT_MOD` constants) is engine-internal (source-module import
only).

### Ammo helpers (`rules/ammo.ts`)

Bin identity + depletion helpers for custom UIs:

- `AmmoPolicy` (`"exposed" | "core" | "spread" | "leastFirst"`)
- `UnitPolicy` (`{ ammoPolicy: AmmoPolicy; autoEject: boolean; heatFlamer: boolean }`, per-unit settings fixed at setup; `DEFAULT_UNIT_POLICY` = `{ ammoPolicy: "exposed", autoEject: true, heatFlamer: true }`, filled by `buildUnitInit`). `autoEject` (TO:AR p. 165): on, losing the head (by damage or a blown-off head) or the center torso to an ammo/weapon blast ejects the pilot (head loss raises pilot hits to `pilotHitMax − 1` first); off, both kill the MechWarrior (TW p. 128). Copied to `UnitState.autoEject`; snapshots saved without it load as `true`. `heatFlamer` (TW p.303): on, every flamer-family (`asHeat`) weapon the unit fires deals its Damage Value as heat instead of damage; off, normal damage. Copied to `UnitState.heatFlamer`; snapshots saved without it load as `true`
- `AmmoBins` — `Record<AmmoBinId, number>`: shots left in each bin, never negative; identity comes from `collectAmmoBins`, and a missing key reads as 0. The count alone does not say whether those shots can be fired: `CritState` (`{ damage, critSlotsDestroyed, ammoBins }`) is the bundle every ammo query takes, and fate derives from it — `isBinUsable(state, bin)` (location IS above 0 and the slot intact), `usableShots(state, bin)`, `strandedShots(state, bin)` (shots stuck in a location lost to plain damage, i.e. salvage). A bin whose slot is flagged destroyed is gone: neither usable nor stranded, whatever its count says
- `CritState` — `{ damage: UnitDamageState; critSlotsDestroyed: CritMask; ammoBins: AmmoBins }`, the three fields that together decide a bin's fate; `UnitState` and `CriticalResolution` both satisfy it
- `ammoBinId(loc, slotIndex): AmmoBinId` — `"${loc}:${slotIndex}"`
- `collectAmmoBins(def): AmmoBin[]` — every bin in the resolved def
- `loadAmmoBins(def): AmmoBins` — initial shot counts
- `CritMask` — `Record<Location, number>`: destroyed crit slots as one bitmask per location (bit `i` = 0-based slot `i`; slot counts come from the def; bits of `empty` slots are never set — a catastrophic location wipe marks every non-empty slot, `soak` included, so lost gear stays on record for refit). Helpers: `emptyCritTable(def)`, `isSlotDestroyed(table, loc, slot)`, `setSlotDestroyed(table, loc, slot)`, `destroyedSlots(table, loc)`, `cloneCritTable(table)`
- `pooledTotalsByWeaponName(def, bins): Readonly<Record<string, number>>`

The draw-order/consumption internals (`AMMO_POLICIES`, `isAmmoPolicy`,
`ammoWeaponTotals`, `binsForWeapon`, `binsForWeaponName`, `pooledShotsLeft`,
`consumeAmmo`, `consumeAmmoForName`, `drawOrderBins`, `designTotalsByWeaponName`)
are engine-internal (source-module import only).

## Battle state machine (`rules/game.ts`)

The engine is **in-place and `void`-returning**: rule functions mutate the
`BattleState` you pass directly and return `void` (read-only queries like
`nextActor` / `actorQueue` return values without
touching combat state; `nextActor` and `actorQueue` lazily fill the cached
activation order on first use each phase). The engine never decides
winner: `gameLoop(state, rng, stopper)` advances transient phases until
caller-supplied `GameLoopStopper` returns true; victory checks live
outside engine (`checkSessionVictory` in `web/terminal/session.ts`, `checkVictory`
test helper in `tests/helpers.ts`).
The engine is single-threaded and non-concurrent; atomicity is **not**
guaranteed per rule call — callers that need all-or-nothing behavior (e.g. the
web session) hold a serializable snapshot and roll back on failure (see
`web/terminal/session.ts` `commitAtomic`), and `createBattle` commits at
the caller's boundary.

```ts
createBattle(map: MapDef, units: UnitInit[], options?: CreateBattleOptions): BattleState  // throws on duplicate ids, unknown models, a bad pilotHitMax, and a start hex that is non-integer, off the board or shared with another unit; team, facing and skills are trusted to their types
executeMove(state, unitId, mode, steps, sink: GameEvent[], { finalFacing, rng }): void  // declares mode + walks steps in one call; refuses off-board hexes and ending stacked in the last hex entered (trailing turns included) or after a charge / DFA hex, and a jump that ends (or stops for a DFA) in a building hex (TW p.168); `finalFacing` only for a jump landing or a stand-up that enters no hex
executePostureMove(state, unitId, "standUp" | "drop", locomotion, steps, sink: GameEvent[], { finalFacing, rng }): boolean  // stand-up or drop plus the movement after it: one activation, one MP pool (TW pp.49-50); the posture cost and a Minimum Movement stand count against the locomotion budget; no steps taken after a failed stand; after a successful stand, turns before the first hex entry are free (TW p.50); returns whether the posture change succeeded
postureMoveBudget(unit, "standUp" | "drop", budget): number           // MP left for the movement after a posture change, out of the locomotion budget (for reachability displays)
postureCost(unit, "standUp" | "drop"): number                         // MP the stand-up / drop charges now
attemptStandUp(state, unitId, sink: GameEvent[], rng): number          // movement phase only: prone unit tries to rise (one attempt per activation; ends it)
dropProne(state, unitId, sink: GameEvent[]): void                // movement phase only: go prone voluntarily (1 MP, no heat, no roll, no damage; refused after jumping; ends the activation)
ejectPilot(state, unitId, rng, sink: GameEvent[]): void                // current movement actor only, as its declaration (Tactical Operations extension; not with an unconscious pilot): ejection PSR (failure = floor(MoF/2) pilot hits, `pilotDamaged` reason "ejection"), then removes the unit (removed = "pilotEjected"); the frame stays as a hull; pilotHits retained
abandonPilot(state, unitId, sink: GameEvent[]): void                   // current movement actor only (house rule, TO:AR p.165): a unit shut down since an earlier turn; no roll, no hits; removed = "pilotAbandoned", the frame stays as a hull in its posture
voluntaryShutdown(state, unitId, sink: GameEvent[]): void              // current movement actor only, as its declaration: shuts down ("manual")
attemptVoluntaryStartup(state, unitId, sink: GameEvent[], rng): void  // current movement actor only: startup attempt after a manual shutdown
declareAttacks(state, unitId, weaponDecls, physicalDecls, sink: GameEvent[], rng, options?): void  // attack phase only: one combined declaration per turn (weapons + punch/kick/club/strike); emits a single merged `attacksDeclared`
validateAttacks(state, unitId, weaponDecls, physicalDecls?, options?): void            // read-only gate check; throws on any rule violation without mutating state or emitting events. Options carry the torso `twist`. Returns the resolved volley metadata via `validateAttacksImpl`.
declarePickup(state, unitId, decl, sink: GameEvent[]): void             // attack phase only: exclusive club pickup (see Physical attacks)
validatePhysicalAttack(state, unitId, decl: PhysicalAttackDecl, twist?, dropped?): ValidationResult  // read-only single-decl check (adjacency, arc, level, actuators); consumed by `declareAttacks` and the web `candidate` hints
passMovement(state, unitId): void                                       // current movement actor only: shut-down unit attempts no startup, stays off-line, marked as acted
passAttack(state, unitId): void                                         // attack phase only: current actor declares no attacks this turn, marked as passed + acted
wreckageAt(state, hex): readonly WreckageEntry[]                         // destroyed 'Mechs lying as wreckage in the hex: { model, unitId } (unitId null when the map placed it)
occupantAt(state, hex, excludeId?): UnitState | undefined               // the active unit or hull in a hex
isHull(unit) / isUnitOnBoard(unit) / isTargetableBy(attacker, target)  // see Hulls and wreckage below
salvageReport(state): SalvageEntry[]                                     // every hull and destroyed frame: kind, removal / kill reason, hex, posture, damage, destroyed slots, stranded ammo, salvageable severed limbs, intact weapons and equipment (`salvageable`)
scoreReport(state): TeamScore[]                                          // every team's score now (docs/SCORING.md): { team, score, lostValue, units: UnitScore[] }; per unit { bv, value, damaged, crippled: CrippleReason[], outOfPlay, lost }. Also unitScore, crippleReasons, damagedFraction, bvSkillMultiplier
nextActor / actorQueue / gameLoop / requireUnit — see below
```

No custom phase loop: transient phases (`rollInitiativePhase`,
`advancePhase`, `resolveAllAttacks`, `resolveHeatPhase`,
`resolvePhasePiloting`) and the single-shot resolvers
(`resolveWeaponAttack`, `resolvePhysicalAttack`) plus the fall/pilot-damage
appliers (`applyFall`, `applyPilotHits`) and building-damage helpers
(`damageBuildingAt`, `partialCoverMod`, `inferPronePropArm`) are
engine-internal (source-module import only). Drive the game with `gameLoop`
below and read outcomes from events.

```ts
actorQueue(state): ActorQueueView   // { initiative, acted, pending, removed } activation order view
gameLoop(state, rng, stopper: GameLoopStopper, sink: GameEvent[]): GameLoopResult  // transient phases until actor acts or stopper(state) true
requireUnit(state, unitId): UnitState
```

`GameLoopStopper = (state: BattleState) => boolean` — caller owns
stop condition. Engine returns `{ actorId; stopped }` with no winner field
(events go to the `sink` you pass). See `web/terminal/session.ts` `drive()` feeding
`checkSessionVictory` as stopper; tests use `checkVictory` helper in
`tests/helpers.ts` same role.

```ts
interface CreateBattleOptions {
  critsDisabled: boolean;             // suppress crit resolution
}
// The board comes from `map: MapDef` ({ name, width, height, terrain, legends });
// width/height must cover every unit and terrain hex.
```

Predicates on unit state:

- `isNominal(unit)` — not shut down
- `isShutdown(unit)`, `isImmobile(unit)` — narrower statuses (immobile also
  covers unconscious pilots and units with no legs and no arms)
- `isUnitAvailable(unit)` — not removed from play
- `isUnitRemoved(unit)` — true when `removed !== "not"`

Constants:

- `STAND_MP_COST`, `DROP_MP_COST` — MP costs for the stand-up / drop-prone
  voluntary actions

Key types:

```ts
interface UnitInit { id; model; team; gunnery: UnitSkillRange; piloting: UnitSkillRange; pilotHitMax?: number; position: HexCoord; facing: Facing; policy: UnitPolicy; damage?: UnitInitDamage }  // team is 1 or 2 (both required); pilotHitMax integer >= 1 (default 6); skills 0..7, gunnery/piloting within 2 of each other (TW p.273)

// Starting damage (optional on UnitInit; absent = pristine). Numbers are damage TAKEN vs. the model
// default; slot and weapon numbers are 1-based; jams are transient and not part of it.
interface UnitInitDamage {
  pilotHits?: number;
  damageTaken?: { armor?: Partial<LocationValue>; armorRear?: Partial<TorsoLocationValue>; internalStructure?: Partial<LocationValue> };
  critsDestroyed?: Partial<Record<Location, number[]>>;
  ammoUsed?: Record<AmmoBinId, number>;
}
// createBattle validates it (taken <= default, structure only behind depleted armor, a lost side torso takes its arm,
// real crit slots listed once (a listed `empty` slot has nothing to destroy and is dropped silently, so
// end states written by older wipes still load), ammo within the bin) and rejects states that would start destroyed:
// head or center torso structure gone, a destroyed cockpit slot, 3 destroyed engine slots, a dead pilot.
// A unit with a destroyed leg or gyro starts prone (TW p.122); other crippled states are legal.

type MoveStep =
  | { kind: "enter"; to: HexCoord }      // forward/backward (ground) or adjacent hop (jump)
  | { kind: "turn"; facings: number };

interface WeaponAttackDecl { weaponIndex: number; targetId: string; rapidFire?: boolean; arc?: Arc; attackDirection?: Arc }

type Phase = "initiative" | "movement" | "attack" | "end";

interface BattleState extends HexGrid {
  turn; phase; initiativeWinnerTeam;
  units: Record<string, UnitState>;
  cells: readonly HexCell[];          // per-hex { terrain: TerrainType; level: number }
  width: number; height: number;      // board size
  critsDisabled: boolean;
  actedThisPhase: string[];
  buildings: Record<string, BuildingState>;  // { cf } keyed "col,row"; one per building-terrain cell, sub-type is the terrain
  rubbleOrigin: Record<string, BuildingTerrainType>;  // collapsed building's terrain, keyed "col,row" of its rubble cell
  wreckage: Record<string, WreckageEntry[]>;  // battlefield wreckage keyed "col,row": { model, unitId | null } of destroyed 'Mechs (40 t+); the hex counts as Rough
  currentDealt?: DealtWindow;  // transient: the latest damage window ({ before, total, byAttacker }); set when one starts, never saved, undefined after a load
  clubs: Record<string, ClubGroundToken[]>;  // ground club tokens keyed "col,row"
  actorQueue: string[] | null;        // cached activation order for the phase
}

interface UnitState {
  id; model; team; gunnery; piloting; pilotHits; pilotHitMax; unconsciousSinceTurn; prone;   // isPilotUnconscious(unit)
  heat; heatPending;                  // scale value (last turn's end) + this turn's own heat
  heatExternalPending;                // outside heat received this turn (uncapped; heat phase applies <= 15)
  position; facing;
  damage: UnitDamageState;            // updated as soon as damage lands
  ammoBins: AmmoBins;                 // per bin, keyed "location:slotIndex": shots left, never negative. Whether they can be fired derives from damage + critSlotsDestroyed (isBinUsable / usableShots / strandedShots)
  jammedWeapons: number[];
  critSlotsDestroyed: CritMask;       // destroyed-slot bitmask per location (bit i = 0-based slot i); destroyed weapons derive from it (isWeaponCritted)
  blownOffLimbs: SeveredLimb[]; club: HeldClub | null;   // severed limbs / held club
  damageTakenFrom: Record<string, number>;   // armor + structure points each other unit dealt to this one (weapon and physical attacks, the crit blasts they set off, accidental falls); battle-long, not used for kill credit
  ammoPolicy: AmmoPolicy; autoEject: boolean; heatFlamer: boolean;   // from UnitPolicy
  moveMode; hexesMovedThisTurn; jumpedThisTurn; mpSpent;
  declaredWeaponAttacks; declaredPhysicalAttacks; declaredPickup; passedAttacks;
  destroyed: DestroyedState;          // "not" | "headDestroyed" | "centerTorsoDestroyed" | "cockpitDestroyed" | "headBlownOff" | "engineDestroyed"
  removed: RemovedState;              // "not" | "destroyed" | "pilotEjected" | "pilotKilled" | "pilotAbandoned"
  shutdown: ShutdownState;            // "not" | "manual" | "heat"
}

type DestroyedReason = "headDestroyed" | "centerTorsoDestroyed" | "cockpitDestroyed" | "headBlownOff" | "engineDestroyed";
type DestroyedState = "not" | DestroyedReason;
type RemovalReason = "destroyed" | "pilotEjected" | "pilotKilled" | "pilotAbandoned";
type RemovedState = "not" | RemovalReason;
type ShutdownState = "not" | "manual" | "heat";
type PilotHitReason = "headHit" | "ammoExplosion" | "fall" | "shutdownFall" | "lifeSupport"; // pilot-damage cause tag

type GameEvent =
  | { kind: "turn"; turn }
  | { kind: "phase"; phase }
  | { kind: "initiative"; rolls; winnerTeam }
  | { kind: "moveDeclared"; unitId; mode }
  | { kind: "moved"; unitId; mode; prevMode; position; facing; mpSpent; mpBudget }
  | { kind: "attacksDeclared"; unitId; weapons: DeclaredWeaponVolley[] /* one per target, primary first; {targetId,count,distance,rangeBracket,rangeMod,secondaryMod} */; physical: DeclaredPhysicalAttack[] }
  | { kind: "attackResolved"; unitId; targetId; secondaryMod: 0|1|2; resolution: AttackResolution }
  | { kind: "physicalAttackResolved"; unitId; targetId; resolution: PhysicalResolution }
  | { kind: "unitRemoved"; unitId; reason: RemovalReason; destroyReason?: DestroyedReason | null; credit: KillCredit[] }   // credit: { unitId, damage, share }[], see killCredit
  | { kind: "wreckageLeft"; unitId; col; row }   // a destroyed 'Mech of 40 t+ turned its hex into Rough (TO:AR p.155)
  | { kind: "unitFell"; unitId; cause: UnitFallCause; levelsFallen; groups; ... }   // damage: damageGroupsTotal(groups)
  | { kind: "buildingCollapsed"; hex; cf }
  | { kind: "heatInflicted"; unitId; targetId; weapon; heat; source: "asHeat" | "extraHeat"; totalReceived }
  | { kind: "heatExternal"; unitId; received; applied; wasted }   // outside heat landing, TW p.159
  | ... ;                              // see src/rules/game.ts for the full union

interface ActorQueueActorView { id; team; shutdown; destroyed; removed }
type GameLoopStopper = (state: BattleState) => boolean;
interface GameLoopResult { actorId: string | null; stopped: boolean; }  // transient: nothing stored on BattleState
// No VictoryResult in engine. Winner checks live outside engine:
// SessionVictoryResult in web/terminal/session.ts, VictoryResult test helper in tests/helpers.ts.
```

Rules encoded by the state machine:

- **Damage deferral**: units keep fighting during the weapon attack phase even
  if destroyed mid-phase; kills are committed when advancing
  `attack -> end` (`destroyed` is set to the reason, e.g.
  `"centerTorsoDestroyed"`, and `removed` to `"destroyed"`; one
  `unitRemoved` event carries `destroyReason`). A pilot kill or eject sets
  `removed` (`"pilotKilled"` / `"pilotEjected"`); `destroyed` records the
  frame independently. It stays `"not"` for an intact 'Mech, and holds the
  kill reason when the frame was destroyed (head loss or CT blast before an
  auto-eject, or a hull destroyed later, in the same step as a pilot kill or
  any time after). The `unitRemoved` event for a pilot kill carries no
  `destroyReason`; a destroyed hull emits a second `unitRemoved` with reason
  `"destroyed"` and its `destroyReason` while the unit keeps its pilot
  removal reason.
- **Kill credit**: every `unitRemoved` carries `credit`, from
  `killCredit(state, unit)`: each enemy unit that damaged the removed unit
  in the damage window that removed it (the weapon sub-pass or the physical
  sub-pass, each with its piloting sweep, or the move whose accidental fall
  hit it), with the armor + structure points it dealt there and its `share`
  of the enemies' total (shares sum to 1), largest first. Overkill adds
  nothing; teammates and self-damage earn none. A removal with no enemy
  damage in its window (heat, the unit's own fall or failed stand, ejection
  or abandonment) has empty credit, and so does the second `unitRemoved` of
  a hull destroyed later.
  `UnitState.damageTakenFrom` keeps the battle-long total per attacker and
  does not feed credit.
- **Hulls and wreckage**: a unit with a pilot removal reason and an intact
  frame is a hull (`isHull`, TO:AR pp.184–185): it stays on the board
  (`isUnitOnBoard`), never acts, keeps its team and posture, counts as lost
  for victory, and is a legal weapon and physical target for both teams
  (`isTargetableBy`) at the −4 immobile modifier (`isImmobile`). Any unit may
  move or jump through its hex but not end there; a path ending on it
  declares a charge / DFA. It never rolls a PSR: a trigger drops it
  automatically, without pilot hits. Every destroyed frame (`markUnitDestroyed`,
  auto-eject from a destroyed frame, a destroyed hull) first takes the
  salvage fall (TW p.128) when it was standing — a `unitFell` with cause
  `{ kind: "salvageFall" }`, damage and criticals on the record, and the fall's
  pilot hit for a MechWarrior still alive in the cockpit (an ejected pilot,
  auto-ejected or from a hull, is outside and takes none) — then, at
  `WRECKAGE_TONNAGE_MIN` (40 t) or more, adds its id to `state.wreckage`
  (`wreckageLeft` event).
- **Weapon usability** is judged against `baseDamage`.
- **Ammo** is deducted at declaration time; jams persist for the rest of the game.
- **Declaration validation**: weapon indexes are 1-based; weapons may be split among any
  number of targets (TW p.108: `options.primaryTargetId`, else the first
  forward-arc target; each secondary target takes `secondaryTargetMod` +1
  forward arc / +2 side-rear, not cumulative; physicals exempt),
  per-weapon mounting arc (TW p.105, torso twist applied; leg mounts keep the
  feet facing), unblocked LOS
  (woods + elevation + water), range check, rapid-fire limits
  (`rapidFire: true` only on R weapons), TN > 12 must be aborted (throws), one
  declaration per weapon per turn, destroyed/jammed weapons rejected.
- **Movement validation**: MP budget per mode (including crit-affected
  effective ratings), terrain costs, +1 MP per level changed up or down
  (water measured at its bed), no running into water (Minimum Movement
  excepted), jump limits in water (TW p.53), forward steps capped at 2 levels per hex, backward steps may not change
  level, backward steps banned while running, turn costs 1 MP/hexside, stacking
  (pass-through friendly-only, never end on another 'Mech); jumping may pass
  over any unit, lands only on empty hexes, and picks its landing facing freely.
- Engine calls return transient `GameEvent[]` (formatted then discarded by the
  caller); `BattleState` stores no log, keeping snapshots small.

## Snapshots (`rules/snapshot.ts`)

Persistence stays public for future web-client save/load:

- `saveBattleState(state): string` — serialize to JSON
- `parseBattleState(json: string): BattleState` — strict parse (throws on
  shape errors, or when `buildings` / `rubbleOrigin` disagree with the cells)
- `loadBattleState(state, json: string): void` — parse + load into live state

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
The renderer lives in `web/terminal/render.ts`, `web/terminal/renderer.text.ts`, and
`web/terminal/misc.ts`, and is documented in `docs/CLI.md` (see the `board`, `mode`,
`info map`, and `sheet` commands).

Key model: `web/terminal/render.ts` exposes a small facade over `web/terminal/renderer.text.ts`
(which the web CLI must not import directly). The render layer builds a
`BoardModel` (cells + per-character `CharStyle` hints keyed by `"col,row"`,
including `BoardModel.elevations` and team-colored `idStyles`) either from a
`BattleState` (`battleModel(state, overlay?, marks?, styles?)`), from a
`MapDef` (`mapModel(...)`), or from structured render info via
`createBoardModel(info)`; `boardToText(model)` returns the flat ASCII form and
`boardToSpans(model)` returns styled span runs. Commands produce board chunks
from a `BoardRenderInfo` (`{ map, units, reachable, clubHexes }`) rather
than a pre-built model; reachable-hex clipping for the movement `mode` command
happens inside `createBoardModel`. The web terminal renders spans inside a `.board` container
whose font family, size and line spacing come from the CSS variables
`--board-ff` / `--board-fs` / `--board-lh`; each terrain's color scheme is
its own set of variables (`--t-lightWoods`, `--t-heavyWoods`,
`--tb-heavyWoods`) in `web/terminal.css`.

## Public API check

The script `scripts/check-public-api.mjs` (`npm run lint:api`) diffs the
export surface of `dist/index.d.ts` against the names listed in this file.
Adding an export without a docs entry, or removing an export without
updating this file, will fail CI.
