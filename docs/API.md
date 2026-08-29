# btlib10x API Reference

Zero-dependency TypeScript library implementing a **subset of classic
BattleTech game rules** (bipedal 'Mechs only). All rule functions are pure and
deterministic given an injected RNG (`interface Rng { d6(): number }`).
Everything below is exported from the package root (`btlib10x`).

## Core

### Types (`core/types.ts`)

| Type | Values |
| --- | --- |
| `Facing` | `"n" \| "ne" \| "se" \| "s" \| "sw" \| "nw"` (hexside; clockwise from north) |

`FACINGS` lists them in order; `isFacing(v)` validates runtime values;
`rotateFacing(f, steps)` / `oppositeFacing(f)` handle rotation.
| `TerrainType` | `"clear" \| "lightWoods" \| "heavyWoods"` |
| `Hex` | `{ col: number; row: number }` (odd-q column offset, flat-top hexes) |
| `MoveMode` | `"standStill" \| "walk" \| "run" \| "jump"` |
| `Location` | `"head" \| "centerTorso" \| "rightTorso" \| "leftTorso" \| "rightArm" \| "leftArm" \| "rightLeg" \| "leftLeg"` |
| `Rng` | `{ d6(): number }` — inject into every rules call |

`LOCATIONS` lists all locations; `isLocation(s)` narrows a string.

### Dice (`core/dice.ts`)

- `rollD6(rng): number`
- `roll2D6(rng): number`

### Hex geometry (`core/hex.ts`)

- `neighbor(hex, facing): Hex`, `neighbors(hex): Hex[]`
- `hexDistance(a, b): number`, `sameHex(a, b): boolean`
- `lineHexes(from, to): Hex[]` — center-to-center trace excluding both endpoints
- `bearing(from, to): Facing | null` — approximate sector toward `to`; `null` when identical

### Terrain (`core/terrain.ts`)

- `terrainMoveCost(t): 0 | 1 | 2` surcharge, `costToEnter(t): number` (= 1 + surcharge)
- `woodsPoints(t): 0 | 1 | 2`
- `MP_PER_FACING_CHANGE = 1`

## Data

### Weapon catalog (`data/weapons.ts`)

```ts
interface WeaponDef {
  name: string;
  short: number; medium: number; long: number; // max hexes per bracket
  damage?: number;            // direct fire
  missiles?: number;          // cluster column (LRM/SRM)
  missileDamage?: 1 | 2;
  variableDamage?: [number, number, number];   // V-code (Snub-Nose PPC)
  pulse?: boolean;            // P-code (-2 to-hit)
  antiInfantry?: boolean;     // AI-code
  rapidFireShots?: number;    // R-code max shots (Ultra AC/5 = 2)
}
```

`WEAPONS: Readonly<Record<string, WeaponDef>>`, `getWeapon(name): WeaponDef`
(throws on unknown names).

### 'Mech definitions (`data/schema.ts`, `data/index.ts`)

```ts
interface MechDef {
  model: string; name: string; tonnage: number;
  weightClass: "Light" | "Medium" | "Heavy" | "Assault";
  techBase: string;
  walking: number; running: number; jumping: number; // running === ceil(walking*1.5)
  armor: Record<Location, number>;  // flat HP per location
  weapons: { weapon: string; location: Location; ammoShots?: number }[];
  source: string;
}
```

- `MECH_DEFS` — bundled sheets keyed by model: ENF-4R, HBK-4G, CDA-3MA,
  HER-5SA, GRF-1N, WVR-6R.
- `getMechDef(model): MechDef | undefined`
- `validateMechDef(data: unknown): MechDef` — hand-rolled validator; throws
  with all problems listed.

### Battle maps (`data/mapschema.ts`, `data/maps/*.json`)

```ts
interface MapDef {
  width: number;    // cols are 1-based: 1..width (rulebook mapsheet labels)
  height: number;   // rows are 1-based: 1..height
  terrain: TerrainHexDef[];  // non-clear hexes only
}
```

- `MAP_DEFS` — bundled rulebook maps keyed by name (`beginner`,
  `quickstart`), validated at load.
- `getMapDef(name): MapDef | undefined`
- `validateMapDef(data): MapDef` — checks shape, integer coords, terrain type,
  1-based bounds, and duplicate hexes; throws with all problems listed.
- `toEngineTerrain(map): TerrainHexDef[]` — shifts map hexes to the engine's
  0-based grid for `createBattle({ terrain })`; round-trips with the renderer's
  +1 display labels.

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

### Line of sight (`rules/los.ts`)

- `interveningHexes(from, to): Hex[]`
- `losWoodsPoints(terrains): number`
- `losBlocked(points): boolean` — true at ≥3 points

### Arcs (`rules/arcs.ts`)

`isInFrontArc(facing, bearingToTarget)` — front three hexsides only
(rear firing is not yet implemented).

### To-hit (`rules/tohit.ts`)

```ts
computeToHit({
  gunnery, attackerMovement, targetHexesMoved, targetJumped,
  targetTerrain, interveningWoods, distance, weapon,
}): ToHitBreakdown & { total; automatic: "hit" | "miss" | null; outOfRange }
```

GATOR stack: gunnery + attacker move + target move + terrain + range bracket
(S 0 / M +2 / L +4), pulse −2, auto-hit ≤ 2, auto-miss > 12.
`damageForBracket(weapon, bracket)` resolves plain/V damage values.

### Hit location & clusters (`rules/hitlocation.ts`, `rules/cluster.ts`)

- `hitLocation(roll2d6): Location` — 2 CT · 3-4 RA · 5 RL · 6 RT · 7 CT ·
  8 LT · 9 LL · 10-11 LA · 12 head
- `clusterHitsForMissiles(missiles, roll)` — columns 2/5/6/10/15
- `clusterHitsForShots(shots, roll)` — columns 2/3/4 (rapid fire)
- `groupMissiles(total, lotSize)` — LRM lots of five

### Damage (`rules/damage.ts`)

`applyDamage(armor, location, damage): DamageApplication` where
`DamageApplication = { armor; steps; newlyDestroyed; blownOffArms; killed }`.

Semantics: flat armor HP per location; overflow transfers inward only after a
location reaches 0; destroyed side torso blows off its arm; either leg lost =
immobile but still armed; head or center torso destroyed = killed.
Predicates: `isKilled`, `isImmobile`, `canFireFromLocation(armor, loc)`.

### Single attack (`rules/attack.ts`)

```ts
resolveWeaponAttack(input: {
  rng; gunnery; attackerMoved; targetHexesMoved; targetJumped;
  targetTerrain; interveningTerrains; distance;
  weaponName; shots?; targetArmor;
}): AttackResolution
```

Handles to-hit roll, jam on natural 2 for multi-shot rapid fire, SRM
per-missile vs LRM lots-of-five locations, and folds all hit groups into one
cumulative `DamageApplication`. Does **not** mutate `targetArmor`; callers copy
from `resolution.application.armor`.

## Battle state machine (`rules/game.ts`)

The engine is **in-place and `void`-returning**: rule functions mutate the
`BattleState` you pass directly and return `void` (read-only queries like
`nextActor` / `checkVictory` / `getUnit` return values but never mutate).
The engine is single-threaded and non-concurrent; atomicity is **not**
guaranteed per rule call — callers that need all-or-nothing behavior (e.g. the
web session) hold a serializable snapshot and roll back on failure (see
`web/session.ts` `commitAtomic`).

```ts
createBattle(units: UnitInit[], { terrain }?): BattleState
rollInitiativePhase(state, rng): void                  // initiative -> movement
declareMove(state, unitId, mode): void                 // movement phase only
executeMove(state, unitId, steps, { finalFacing }?): void
declareAttacks(state, unitId, decls): void             // weaponAttack phase only
resolveDeclaredAttacks(state, unitId, rng): void
advancePhase(state): void                              // drives the phase cycle
nextActor(state): string | null                        // alternating activation hint
checkVictory(state): { winnerTeam; draw }
getUnit(state, unitId): UnitState
```

Key types:

```ts
interface UnitInit { id; model; team; gunnery; position: Hex; facing: Facing }

interface TerrainHexDef { col; row; type: TerrainType }   // options.terrain input

type MoveStep =
  | { kind: "enter"; to: Hex }      // forward/backward (ground) or adjacent hop (jump)
  | { kind: "turn"; facings: number };

interface AttackDecl { weaponIndex: number; targetId: string; shots?: number }

type Phase = "initiative" | "movement" | "weaponAttack" | "end";

interface BattleState {
  turn; phase; initiativeWinnerTeam;
  units: Record<string, UnitState>;
  defs: Record<string, MechDef>;
  terrain: Record<string, TerrainType>;  // keyed "col,row"; built from the TerrainHexDef[] option
  actedThisPhase: string[];
  events: GameEvent[];                   // serializable audit log
}

interface UnitState {
  id; model; team; gunnery; position; facing;
  armor: ArmorState;              // updated as soon as damage lands
  phaseStartArmor: ArmorState;    // snapshot for weapon usability this phase
  ammoLeft: Record<number, number>;
  jammedWeapons: number[];
  moveMode; movesThisTurn; jumpedThisTurn; mpSpent;
  declaredAttacks; firedTargetId;
  destroyed; removed;
}
```

Rules encoded by the state machine:

- **Damage deferral**: units keep fighting during the weapon attack phase even
  if destroyed mid-phase; kills are committed when advancing
  `weaponAttack -> end` (`destroyed = removed = true`, events emitted).
- **Weapon usability** is judged against `phaseStartArmor`.
- **Ammo** is deducted at declaration time; jams persist for the rest of the game.
- **Declaration validation**: one target per turn, front arc, unblocked LOS,
  range check, TN > 12 must be aborted (throws), rapid-fire shot limits.
- **Movement validation**: MP budget per mode, terrain costs, backward steps
  banned while running, turn costs 1 MP/hexside, stacking (pass-through
  friendly-only, never end on another 'Mech); jumping may pass over any unit,
  lands only on empty hexes, and picks its landing facing freely.
- `GameEvent` union (`turn`, `phase`, `initiative`, `moveDeclared`, `moved`,
  `attacksDeclared`, `attackResolved`, `unitDestroyed`, `unitRemoved`) makes
  battles fully replayable from the event log.

## Console rendering (`render.ts`)

### Battle boards (`battleModel` + `boardToText`)

Flat battle text comes from `boardToText(battleModel(state, overlay?, marks?))`.
Each hex draws as

```
  ____
 /0101\
(  wvr )
 \ w0 /
  ====
 /0102\
(      )
 \    /
  ‾‾‾‾
```

with `/0101\` carrying the 1-based column,row as fixed two-digit pairs
(`/0204\` for engine hex `{ col: 1, row: 3 }`; internal coordinates remain
0-based), the occupant's id centered in the 6-char belly — round half up, so
3-char ids start at the belly's 4th character (`(  wvr )`; ids clip to 4
characters, so `hunchy` draws as `( hunc )`), and the terrain glyph plus
elevation centered at the bottom — non-zero levels are read from
`state.elevation` (or a per-hex elevations map passed to `mapModel`);
clear hexes at level 0 still draw as `0` to match historic output. Outer
top edges render as `____`, edges shared with the hex below as `====`, and
the map's bottom edge as `‾‾‾‾`. A unit's facing replaces the grid
character at its hexside vertex — n `↑` (top edge's 2nd char), s `↓`
(bottom edge's 3rd char), nw/ne/sw/se `↖ ↗ ↙ ↘` on the upper / lower walls
— so both arrows stay visible on a shared edge.
Odd columns sit half a hex lower (matching the odd-q grid); removed units are
omitted; board bounds come from `state.width`/`state.height` when set (via
`createBattle`'s `width`/`height` options, which are stored on the battle
state), else they default to the units + terrain extent. Log with
`console.log(boardToText(battleModel(state)))`.

`overlay` maps `"col,row"` keys (engine coordinates) to glyphs drawn inside
empty hexes — e.g. terrain markers like `{ "3,4": "W" }`.
Occupying units always take precedence over overlay glyphs.

`marks` maps `"col,row"` keys to glyphs drawn at the bottom center of the hex
(same slot `renderMap` uses for terrain); it composes freely with occupants
and overlay.

### `renderMap(terrain, width, height): string`

Render a static map sheet (no units) from non-clear terrain hex definitions at
the given size. Terrain hexes draw their glyph from the exported
`TERRAIN_GLYPHS` table (`lightWoods: "w"`, `heavyWoods: "W"`) at the bottom
center of the hex (`\ w /`); all other hexes are blank.

### Structured models & styled output

The flat functions above are thin wrappers over structured equivalents that
also carry per-character presentation hints:

- `battleModel(state, overlay?, marks?, styles?): BoardModel`
  and `mapModel(terrain, width, height, styles?): BoardModel` build the board
  data (cells / marks / style hints keyed by `"col,row"`). Battle bounds read
  `state.width`/`state.height`, falling back to content extent.
- `boardToText(model): string` — the historic flat rendering.
- `boardToSpans(model): Span[][]` — runs of characters sharing a
  `CharStyle` (`fg`/`bg` from the named palette: `red green yellow blue
  magenta cyan white dim`, plus `bold`/`italic`, or a raw web-only CSS
  `cls`). Concatenating span texts reproduces `boardToText` exactly;
  styling travels beside the text, never inline, so geometry math only ever
  sees plain characters.

Semantic defaults: terrain hexes tint their grid rows via `TERRAIN_STYLES`
(one CSS class per `TerrainType`: `t-lightWoods`, `t-heavyWoods`); unit ids
are team-colored through a separate `cellStyles` record so `TEAM_STYLES`
(team 0 cyan, team 1 magenta) touches only the id characters and the unit's
facing arrow, never the
parens or grid rows — and terrain tint survives underneath an occupying
unit. An explicit `styles` record replaces all automatic styling entirely
(including `cellStyles`). The web terminal renders spans inside a `.board`
container whose font family, size and line spacing come from the CSS
variables `--font-board` / `--board-fs` / `--board-lh`; each terrain's color
scheme is its own set of variables (`--t-lightWoods`, `--t-heavyWoods`,
`--tb-heavyWoods`) in `web/index.html`, so per-terrain restyling needs no
code changes.
