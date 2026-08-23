# btlib10x API Reference

Zero-dependency TypeScript library for Classic BattleTech quick-start rules
(bipedal 'Mechs only). All rule functions are pure and deterministic given an
injected RNG (`interface Rng { d6(): number }`). Everything below is exported
from the package root (`btlib10x`).

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
(quick-start rules have no rear firing).

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

All functions return **new state objects** (shallow-copied units); nothing is
mutated in place except documented unit fields on the fresh copy.

```ts
createBattle(units: UnitInit[], { terrain }?): BattleState
rollInitiativePhase(state, rng): BattleState        // initiative -> movement
declareMove(state, unitId, mode): BattleState       // movement phase only
executeMove(state, unitId, steps, { finalFacing }?): BattleState
declareAttacks(state, unitId, decls): BattleState   // weaponAttack phase only
resolveDeclaredAttacks(state, unitId, rng): BattleState
advancePhase(state): BattleState                     // drives the phase cycle
nextActor(state): string | null                     // alternating activation hint
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

### `renderBattle(state, width?, height?, overlay?): string`
ASCII map for consoles/logs. Each hex draws as

```
  ---
 /wvr\
< 1,3 >
 \   /
  ---
```

with the occupant's id clipped/padded to 3 chars and space-aligned `col,row`
displayed 1-based (col right-aligned, row left-aligned; internal coordinates
remain 0-based). Borders default to `---` but render `===` where two hexes
share a horizontal edge.
Odd columns sit half a hex lower (matching the odd-q grid); removed units are
omitted; board bounds default to the units + terrain extent. Log with
`console.log(renderBattle(state))`.

`overlay` maps `"col,row"` keys (engine coordinates) to glyphs of up to 3
chars drawn inside empty hexes — e.g. terrain markers like `{ "3,4": "W" }`.
Occupying units always take precedence over overlay glyphs.

### `renderMap(terrain, width, height): string`

Render a static map sheet (no units) from non-clear terrain hex definitions at
the given size. Terrain hexes draw their glyph from the exported
`TERRAIN_GLYPHS` table (`lightWoods: "w"`, `heavyWoods: "W"`); all other hexes
are blank. Shares the same canvas machinery as `renderBattle`, so output is
identical to rendering an empty battle with a matching overlay.
