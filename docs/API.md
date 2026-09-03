# btlib10x API Reference

Zero-dependency TypeScript library implementing a **subset of classic
BattleTech game rules** (bipedal 'Mechs only). All rule functions are pure and
deterministic given an injected RNG (`interface Rng { d6(): number }`).
Everything below is exported from the package root (`btlib10x`).

**Coordinates are 1-based** throughout: hex columns/rows, map bounds, terrain,
and unit positions all use the mapsheet labels (`cols 1..width`,
`rows 1..height`). There is no 0-based convention and no conversion layer.

## Core

### Types (`core/types.ts`)

| Type | Values |
| --- | --- |
| `Facing` | `"n" \| "ne" \| "se" \| "s" \| "sw" \| "nw"` (hexside; clockwise from north) |
| `TerrainType` | `"clear" \| "lightWoods" \| "heavyWoods"` |
| `Hex` | `{ col: number; row: number; level?: number }` (1-based odd-q, flat-top) |
| `TerrainHexDef` | `{ col; row; type: TerrainType; level?: number }` (elevation, default 0) |
| `MoveMode` | `"standStill" \| "walk" \| "run" \| "jump"` |
| `Location` | `"head" \| "centerTorso" \| "rightTorso" \| "leftTorso" \| "rightArm" \| "leftArm" \| "rightLeg" \| "leftLeg"` |
| `Rng` | `{ d6(): number }` — inject into every rules call |

`FACINGS` lists them in order; `isFacing(v)` validates runtime values;
`rotateFacing(f, steps)` / `oppositeFacing(f)` handle rotation.
`LOCATIONS` lists all locations; `isLocation(s)` narrows a string.

### Dice (`core/dice.ts`)

- `rollD6(rng): number`
- `roll2D6(rng): number`

### Hex geometry (`core/hex.ts`)

- `neighbor(hex, facing): Hex`, `neighbors(hex): Hex[]`, `isAdjacent(a, b)`
- `hexDistance(a, b): number`, `sameHex(a, b): boolean`
- `lineHexes(from, to): Hex[]` — center-to-center trace excluding both endpoints
- `bearing(from, to): Facing | null` — approximate sector toward `to`; `null` when identical

### Terrain (`core/terrain.ts`)

- `terrainMoveCost(t): 0 | 1 | 2` surcharge, `costToEnter(t): number` (= 1 + surcharge)
- `woodsPoints(t): 0 | 1 | 2`
- `costToClimb(fromLevel, toLevel): number` (+1 per level climbed, descent free)
- `levelAt(elevation, hex): number` (level for a hex, default `DEFAULT_LEVEL` 0)
- `MP_PER_FACING_CHANGE = 1`, `MP_TO_ENTER_HEX = 1`, `MP_PER_LEVEL_CLIMB = 1`,
  `DEFAULT_LEVEL = 0`

## Data

### Weapon catalog (`data/weapons.ts`)

```ts
interface WeaponDef {
  name: string;
  short: number; medium: number; long: number; // max hexes per bracket
  minRange?: number;          // closer-than-minimum-range penalty
  damage?: number;            // direct fire
  missiles?: number;          // cluster column (LRM/SRM)
  missileDamage?: 1 | 2;
  variableDamage?: [number, number, number];   // V-code (per bracket)
  pulse?: boolean;            // P-code (-2 to-hit)
  antiInfantry?: boolean;     // AI-code
  rapidFireShots?: number;    // R-code max shots (Ultra AC/5 = 2)
}
```

`getWeapon(name): WeaponDef` (throws on unknown names), `getAllWeapons()`,
`listWeaponNames()`. `WEAPONS` is not exported as a public record.

### 'Mech definitions (`data/schema.ts`, `data/index.ts`)

The on-disk form is `MechDef` (written in `src/data/mechs/*.json`). It is
validated by `validateMechDef`, then resolved into the engine-facing
`ResolvedMechDef` by `resolveMechDef`.

```ts
interface MechDef {
  model: string; name: string; tonnage: number; // 10..100
  weightClass: "Light" | "Medium" | "Heavy" | "Assault";
  techBase: string;
  walking: number; running: number; jumping: number; // running === ceil(walking*1.5)
  armor: LocationValue &                     // torso = front only
    Partial<Record<"centerTorsoRear"|"leftTorsoRear"|"rightTorsoRear", number>>;
  weapons: WeaponMount[];                      // JSON-array form
  critSlots: CritSlots;                        // required; see below
  source: string;
}
```

```ts
interface WeaponMount { weapon: string; location: Location; shots?: number }
```

Critical slots are a per-location table faithful to the record sheet:

```ts
type CritSlot =
  | { kind: "empty" }                          // re-rolls during crit selection
  | { kind: "weapon"; weapon: string }
  | { kind: "ammo"; weapon: string }
  | { kind: "structure"; name: CritStructureName }
  | { kind: "soak"; name: CritSoakName };      // endoSteel / ferroFibrous / case

type CritSlots = Record<Location, readonly CritSlot[]>;
```

Per-location slot counts (`CRIT_SLOT_COUNTS`): head/legs = 6, torso/arms = 12.
Structure names (`CRIT_STRUCTURE_NAMES`): cockpit, sensors, lifeSupport,
engine, gyro, heatSink, doubleHeatSink, jumpJet, shoulder, upperArmActuator,
lowerArmActuator, handActuator, upperLegActuator, lowerLegActuator,
footActuator, targetingComputer, hip.

The engine-facing resolution keeps front and rear armor as **separate pools**
and derives internal structure:

```ts
interface ResolvedMechDef {
  model: string; name: string; tonnage: number;
  weightClass: ...; techBase: string;
  walking: number; running: number; jumping: number;
  armor: LocationValue;                     // front armor only
  armorRear: Partial<Record<TorsoLocation, number>>;    // 3 torso rear values
  internalStructure: LocationValue;         // derived from tonnage
  weapons: Record<number, WeaponMount>;                 // re-keyed 1..N (1-based index)
  critSlots: ResolvedCritSlots;                         // weaponIndex-linked
  source: string;
}
```

`ResolvedCritSlot` mirrors `CritSlot` but links weapon/ammo slots to their
1-based `weaponIndex` in `weapons`, and gives multi-slot structure components
(DHS) a `group` of sibling slot indices so one hit destroys the whole DHS.

- `MECH_DEFS` — a generated `Map<string, ResolvedMechDef>` keyed by model
  (upper-cased). Bundled sheets: AS7-D (Atlas), CDA-3MA (Cicada), ENF-4R
  (Enforcer), GRF-1N (Griffin), HBK-4G (Hunchback), HER-5SA (Hermes II),
  MC-MKII-2 (Mad Cat Mk II), TW-Prime (Mad Cat), WHK-Prime (Masakari),
  WVR-6R (Wolverine). See `docs/MTF.md` to add more.
- `getMechDef(model): ResolvedMechDef | undefined`
- `getAllMechDefs(): ResolvedMechDef[]`
- `validateMechDef(data: unknown): MechDef` — hand-rolled validator; throws
  with all problems listed.
- `resolveMechDef(def: MechDef): ResolvedMechDef`
- `CRIT_SLOT_COUNTS`, `CRIT_STRUCTURE_NAMES`, `CRIT_SOAK_NAMES`

### Battle maps (`data/mapschema.ts`, `data/maps/*.json`)

```ts
interface MapDef {
  name: string;
  width: number;    // cols 1..width (rulebook mapsheet labels)
  height: number;   // rows 1..height
  terrain: TerrainHexDef[];  // non-clear hexes only (level optional)
}
```

- `MAP_DEFS` — bundled maps keyed by name (`beginner`, `quickstart`, `test`),
  validated at load.
- `getMapDef(name): MapDef | undefined`, `getAllMapDefs(): MapDef[]`,
  `listMapNames(): string[]`.
- `validateMapDef(data): MapDef` — checks shape, integer coords, terrain type,
  1-based bounds, duplicate hexes, and optional non-negative `level`; throws
  with all problems listed.

Map coordinates are already 1-based and match the engine directly, so there is
**no** `toEngineTerrain` conversion function anymore.

## Rules

### Initiative (`rules/initiative.ts`)

`rollInitiative(teams, rng): { rolls: Record<number, number>; winnerTeam }` —
2D6 per team, ties reroll all.

### Movement (`rules/movement.ts`)

- `maxMovePoints(mode, walking, running, jumping)`
- `attackerMovementModifier(mode)` → 0/+1/+2/+3
- `targetMovementModifier(hexesEntered, jumped)` → 0…+7 (+1 jump bonus)
- `hexesSinceLastReversal(moves)` — only hexes after the last direction change count
- `facingChangeCost(facings)`
- `isForwardStep / isBackwardStep(from, to, facing)`
- `canPassThroughHex(occupantTeam, moverTeam)` — friends yes, enemies no
- `canEndMoveInHex(occupantTeam, moverTeam)` — never end on anyone
- `terrainAt(record, hex)` / `hexKey(hex)` for `"col,row"` maps
- `reachableLandings(start, startFacing, options): RevealedLanding[]` —
  enumerates every (hex, facing) reachable within the mode's MP budget, each
  with a movement `path` (`F` forward / `B` back / `R`/`L` turn). Ground
  charges 1 MP per turn and 1+terrain+climb per step (jump treats turns as
  free and ignores elevation).

### Line of sight (`rules/los.ts`)

- `interveningHexes(from, to): Hex[]`
- `losWoodsPoints(terrains)`, `losBlocked(points)` (≥3 blocks)
- `losWoodsPointsBetween(terrain, from, to)`, `interveningTerrains(terrain, from, to)`
- `losBlockedByElevation(elevation, from, to)` — draws a real-valued ray from
  attacker to target LOS level (hex level + 1); an intervening hex blocks iff
  its own LOS level exceeds the ray's height at its center.
- `losClear(elevation, terrain, from, to)` — true when both woods and elevation
  LOS checks are clear.

### Arcs (`rules/arcs.ts`)

- `isInFrontArc(facing, bearingToTarget)` — front three hexsides only.
- `classifyArc(facing, bearingToTarget): Arc` — `"front" | "rear" | "leftSide" | "rightSide"`.
- `Arc` — firing arc type. Side/rear classification is implemented but firing
  itself is still front-arc-only in the current subset.

### To-hit (`rules/tohit.ts`)

```ts
computeToHit({
  gunnery, attackerMovement, targetHexesMoved, targetJumped,
  targetTerrain, interveningWoods, distance, weapon,
  attackerLevel?, targetLevel?,
}): ToHitBreakdown
```

GATOR stack: gunnery + attacker move + target move + terrain + range bracket
(S 0 / M +2 / L +4) + pulse (−2) + minimum-range penalty + height difference;
auto-hit ≤ 2, auto-miss > 12. `attackerLevel − targetLevel` is reported as
`heightDiff` and subtracts as `heightMod` (attacker higher = easier).
`damageForBracket(weapon, bracket)` resolves plain/V damage values.
`ToHitBreakdown` carries the individual mods, `rangeBracket`, `automatic`,
and `outOfRange`.

### Hit location & clusters (`rules/hitlocation.ts`, `rules/cluster.ts`)

- `hitLocation(roll2d6): Location` — 2 CT · 3-4 RA · 5 RL · 6 RT · 7 CT ·
  8 LT · 9 LL · 10-11 LA · 12 head
- `hitLocationForArc(arc, roll2d6): Location` — uses `LEFT_SIDE_TABLE` /
  `RIGHT_SIDE_TABLE` for side arcs; front and rear share `HIT_LOCATION_TABLE`.
- `clusterHitsForMissiles(missiles, roll)` — columns 2/4/5/6/10/15/20
- `clusterHitsForShots(shots, roll)` — columns 2/3/4 (rapid fire)
- `groupMissiles(total, lotSize)` — LRM lots of five

### Internal structure (`rules/internalStructure.ts`)

`internalStructureForTonnage(tonnage): Record<Location, number>` — standard TW
table (20–100t in 5t rows), head always 3. `HEAD_STRUCTURE = 3`,
`STANDARD_INTERNAL_STRUCTURE`.

### Damage (`rules/damage.ts`)

Layered damage state:

```ts
interface UnitDamageState {
  armor: Record<Location, number>;               // front armor per location
  armorRear: Partial<Record<Location, number>>;  // rear torso pools
  internalStructure: Record<Location, number>;
}
```

`applyDamage(damage: UnitDamageState, location, amount, arc = "front"):
DamageApplication` — drains the active armor pool (front, or rear for rear-arc
torso hits), then that location's internal structure, then transfers inward
(per `TRANSFER_INWARD`: arms/legs → side torso → center torso; head/CT terminal).

```ts
interface DamageApplication {
  damage: UnitDamageState;
  steps: { location; pool: "armor"|"armorRear"|"structure"; damageApplied; depleted }[];
  newlyDestroyed: Location[];
  blownOffArms: Location[];
  killed: boolean;
}
```

Predicates: `isKilled(damage)` (head or CT IS gone), `isImmobile(damage)`
(either leg IS gone), `isLocationDestroyed(damage, loc)`,
`canFireFromLocation(damage, loc)` (location + its support torso intact).
Side-torso IS death blows off the arm; `TRANSFER_INWARD` is exported.

### Critical hits (`rules/critical.ts`)

`resolveCriticalHits({
  rng; def; source: { location; damage };
  critSlotsDestroyed; destroyedWeapons; damage; shotsLeft;
}): CriticalResolution`

Runs the TW Determining Critical Hits table (2D6: 2-7 none, 8-9 one, 10-11 two,
12 blow-off on head/arm/leg or three on torso), per-location slot rolls (1D6
head/legs, 2D6 half+slot torso/arms), re-rolls on empty/soak/destroyed slots,
and inward transfer (head/CT terminal; excess lost). Effects: weapon destroyed,
ammo explosion (per-shot damage × remaining shots applied directly to the bin's
IS with cascading crits), limb/head blown off, cockpit kill, and
leg-actuator/hip/jump-jet destruction tracked for movement.

`CriticalResolution` exposes `rows` (the individual `CriticalEffect`s),
`determiningRoll`, and the resulting `critSlotsDestroyed` / `destroyedWeapons` /
`damage` / `blownOffArms` / `killed` / `shotsLeft`.

`effectiveMovement(def, critSlotsDestroyed): EffectiveMovement` — computes
walking/running/jumping after leg-actuator (−1 walk each), hip (halves walking),
and jump-jet (−1 jump each) crit damage.

### Single attack (`rules/attack.ts`)

```ts
resolveWeaponAttack(input: WeaponAttackInput): AttackResolution
```

```ts
interface WeaponAttackInput {
  rng; gunnery; attackerMoved; targetHexesMoved; targetJumped;
  targetTerrain; interveningTerrains; distance; weaponName;
  shots?;                  // rapid-fire volley; defaults 1
  targetDamage: UnitDamageState;   // layered
  arc?: Arc;               // defaults "front"
  attackerLevel?; targetLevel?;
  targetDef?; targetCritSlotsDestroyed?; targetDestroyedWeapons?; targetAmmoLeft?;
}
```

Handles to-hit roll, jam on natural 2 for multi-shot rapid fire, SRM
per-missile vs LRM lots-of-five locations, arc-aware location selection, and
folds all hit groups into one cumulative `DamageApplication`. When
`targetDef` + crit snapshots are supplied, it also runs critical-hit resolution
per group that stripped IS and folds ammo-explosion damage into the returned
application. It does **not** mutate the target; callers copy from
`resolution.application.damage` and `resolution.crits[last]`.

`AttackResolution` = `{ weapon; distance; breakdown; toHitRoll; hit; jammed;
clusterRoll; groups; application; crits }`.

### Fireability (`rules/fireability.ts`)

`suggestFireTargets(state, unitId): FireSuggestion` — for every enemy, lists
the weapons that could reach it (arc, LOS, range, ammo, not jammed/destroyed,
not auto-missing) with their computed TN and expected damage, plus per-weapon
block reasons (`jammed` / `destroyed` / `outOfRange` / `outOfArc` / `noLos` /
`outOfAmmo` / `autoMiss`). Mirrors `declareAttacks` checks.

## Battle state machine (`rules/game.ts`)

The engine is **in-place and `void`-returning**: rule functions mutate the
`BattleState` you pass directly and return `void` (read-only queries like
`nextActor` / `checkVictory` / `getUnit` return values but never mutate).
The engine is single-threaded and non-concurrent; atomicity is **not**
guaranteed per rule call — callers that need all-or-nothing behavior (e.g. the
web session) hold a serializable snapshot and roll back on failure (see
`web/session.ts` `commitAtomic`), and `createBattle`/`advancePhase` commit at
the caller's boundary.

```ts
createBattle(units: UnitInit[], options?: CreateBattleOptions): BattleState
rollInitiativePhase(state, rng): void                  // initiative -> movement
declareMove(state, unitId, mode): void                 // movement phase only
executeMove(state, unitId, steps, { finalFacing }?): void
declareAttacks(state, unitId, decls): void             // weaponAttack phase only
resolveDeclaredAttacks(state, unitId, rng): void
resolveAllAttacks(state, rng): void                    // resolves every unit's declared attacks
advancePhase(state): void                              // drives the phase cycle
nextActor(state): string | null                        // alternating activation hint
checkVictory(state): { winnerTeam; draw }
getUnit(state, unitId): UnitState
```

```ts
interface CreateBattleOptions {
  terrain?: TerrainHexDef[];          // non-clear hexes, optional level
  width?: number; height?: number;    // board size hint for rendering (engine coords)
  critsDisabled?: boolean;            // suppress crit resolution (default false)
}
```

Key types:

```ts
interface UnitInit { id; model; team; gunnery; position: Hex; facing: Facing }

type MoveStep =
  | { kind: "enter"; to: Hex }      // forward/backward (ground) or adjacent hop (jump)
  | { kind: "turn"; facings: number };

interface AttackDecl { weaponIndex: number; targetId: string; rapidFire?: boolean }

type Phase = "initiative" | "movement" | "weaponAttack" | "end";

interface BattleState {
  turn; phase; initiativeWinnerTeam;
  units: Record<string, UnitState>;
  terrain: Record<string, TerrainType>;   // keyed "col,row"
  elevation: Record<string, number>;      // per-hex levels; missing = 0
  width?; height?;
  critsDisabled: boolean;
  actedThisPhase: string[];
  events: GameEvent[];                    // serializable audit log
}

interface UnitState {
  id; model; team; gunnery; position; facing;
  damage: UnitDamageState;            // updated as soon as damage lands
  phaseStartDamage: UnitDamageState;  // snapshot for weapon usability this phase
  shotsLeft: Record<number, number>;  // per 1-based weapon index
  jammedWeapons: number[];
  critSlotsDestroyed: Record<Location, boolean[]>;
  destroyedWeapons: number[];
  moveMode; movesThisTurn; jumpedThisTurn; mpSpent;
  declaredAttacks; firedTargetId; passedAttacks;
  destroyed; removed;
}
```

Rules encoded by the state machine:

- **Damage deferral**: units keep fighting during the weapon attack phase even
  if destroyed mid-phase; kills are committed when advancing
  `weaponAttack -> end` (`destroyed = removed = true`, events emitted).
- **Weapon usability** is judged against `phaseStartDamage`.
- **Ammo** is deducted at declaration time; jams persist for the rest of the game.
- **Declaration validation**: weapon indexes are 1-based; one target per turn,
  front arc, unblocked LOS (woods + elevation), range check, rapid-fire limits
  (`rapidFire: true` only on R weapons), TN > 12 must be aborted (throws), one
  declaration per weapon per turn, destroyed/jammed weapons rejected.
- **Movement validation**: MP budget per mode (including crit-affected
  effective ratings), terrain costs, climb at most 1 level per ground step,
  backward steps banned while running, turn costs 1 MP/hexside, stacking
  (pass-through friendly-only, never end on another 'Mech); jumping may pass
  over any unit, lands only on empty hexes, and picks its landing facing freely.
- `GameEvent` union (`turn`, `phase`, `initiative`, `moveDeclared`, `moved`,
  `attacksDeclared`, `attackResolved`, `unitDestroyed`, `unitRemoved`) makes
  battles fully replayable from the event log.

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

Key model: `battleModel(state, overlay?, marks?, styles?)` / `mapModel(...)`
build a `BoardModel` (cells + per-character `CharStyle` hints keyed by
`"col,row"`, including `BoardModel.elevations` and team-colored `cellStyles`);
`boardToText(model)` returns the flat ASCII form and `boardToSpans(model)`
returns styled span runs. Reachable-hex clipping for the movement `mode`
command is provided by `reachableModel` in `web/format.ts`. The web terminal
renders spans inside a `.board` container whose font family, size and line
spacing come from the CSS variables `--font-board` / `--board-fs` /
`--board-lh`; each terrain's color scheme is its own set of variables
(`--t-lightWoods`, `--t-heavyWoods`, `--tb-heavyWoods`) in `web/index.html`.
