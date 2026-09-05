# BoardModel refactoring plan

The rendered board is mature enough to warrant a structural cleanup.
`BoardModel` and its supporting code grew additively — each new visual
feature (terrain marks, elevation, facings, team tinting, edge tinting)
was bolted on as another optional `Record<string, T>` dictionary. The
result works but conflates layering, naming, and composition in ways that
make extension and maintenance harder than necessary.

## Current issues

### 1. `styles` vs `cellStyles` — confusing dual-role naming

`styles` controls the **entire hex**: grid walls, coord label, belly
parens, and the terrain mark at the bottom. `cellStyles` controls **just
the occupant id text** inside the parentheses. The fallback is implicit —
when `cellStyles[key]` is absent, the renderer uses `styles[key]` for the
id glyph too.

The actual semantic split is:

| Field         | What it tints                         | Source          |
|---------------|---------------------------------------|-----------------|
| `styles`      | Grid row, coord, walls, parens, mark  | Terrain type    |
| `cellStyles`  | Occupant id inside `( )` only         | Team color      |

The name `cellStyles` suggests it styles the whole cell. It does not.
Callers must read the JSDoc to discover the fallback. A clearer name
(`idStyles`) would make the contract self-documenting.

**Affected files:** `web/render.ts:73`, `web/renderer.text.ts:239,257,494`,
`web/format.ts:1365,1373,1386`, `tests/render-styled.test.ts:107,151`.

### 2. No composition helper — `reachableModel()` manually reassembles

`web/format.ts:1324-1390` (`reachableModel`) is the only call site that
composes a new BoardModel on top of an existing one. It must:

1. Call `battleModel(s.battle)` to get a base.
2. Spread every field into a new mutable local: `const cells = { ...(base.cells ?? {}) }`.
3. Mutate the locals (add `<>` markers, team-tinted cellStyles, edgeStyles).
4. Return a fresh BoardModel literal, re-spreading the unchanged fields.

This spread-mutate-reassemble pattern is the direct cost of a flat bag
with no composition API. It is 27 lines of boilerplate that must be
updated every time a new BoardModel field is added.

### 3. Factory functions duplicate terrain derivation logic

`mapModel()` (`renderer.text.ts:376-407`) and `battleModel()`
(`renderer.text.ts:429-496`) both independently:

- Derive terrain marks from a cell list (mapModel from `TerrainHexDef[]`,
  battleModel from `BattleState.cells`).
- Build per-hex terrain styles from `TERRAIN_STYLES`.
- Filter out zero elevations.

The logic is structurally identical but operates on different input
shapes (`TerrainHexDef` vs `HexCell`), so it was copy-pasted rather than
shared. Adding a new terrain-dependent visual feature (e.g. partial cover
indicators) would require updating both factories.

### 4. `drawCanvas()` is a monolithic 90-line loop

`renderer.text.ts:193-281` does everything in one pass:

- Hex grid structure (walls, coords, edges)
- Unit id placement in bellies
- Terrain mark placement
- Elevation digit display
- Facing arrow overlay
- Edge style tinting

Each concern is interleaved with the others inside the same
`for col → for row` loop. Adding a new rendering layer (e.g. damage
overlay, LOS highlight, movement trail) requires modifying this single
function and understanding all existing layers to avoid side effects.

### 5. File-level circular re-export chain

`web/render.ts` re-exports types and values from `web/renderer.text.ts`.
`web/renderer.text.ts` imports `BoardModel` back from `web/render.ts`.
This compiles (TypeScript resolves the cycle), but it creates a
conceptual circularity: the "public" types live in `render.ts` while the
implementations live in `renderer.text.ts`, and neither file is
self-contained.

### 6. `battleModel()` suppresses `cellStyles` when explicit `styles` is passed

At `renderer.text.ts:494`:

```ts
...(styles === undefined && Object.keys(autoCells).length > 0
  ? { cellStyles: autoCells }
  : {}),
```

When a caller passes an explicit `styles` override, the factory silently
drops all team-colored `cellStyles`. This is intentional (explicit styles
replace automatic ones entirely — tested at
`render-styled.test.ts:192-224`) but the behavior is non-obvious. A
caller passing `styles` for terrain highlighting would not expect to also
lose team-colored unit ids.

---

## Refactoring plan

Each phase is independently shippable and testable. Run
`npm run lint && npm run typecheck && npm test` after every phase.

### Phase 1 — Rename `cellStyles` → `idStyles`

**Goal:** Make the field contract self-documenting.

**Changes:**

- `web/render.ts:73` — rename the property in the `BoardModel` interface.
- `web/renderer.text.ts:239,257,494` — update all reads/writes.
- `web/format.ts:1365,1373,1386` — update the `reachableModel()` spread
  and the variable name.
- `tests/render-styled.test.ts:107,151` — update property access in
  assertions.

**Risk:** Mechanical rename. No behavioral change.

**Verification:** grep for `cellStyles` across the repo; zero hits
expected after the rename.

### Phase 2 — Extract terrain-derivation helpers

**Goal:** Single source of truth for terrain→marks, terrain→styles,
terrain→elevations.

**In `web/renderer.text.ts`**, add module-private derivation helpers
(they read the `TERRAIN_GLYPHS`/`TERRAIN_STYLES` constants already
defined in that file):

```ts
import type { HexGrid, TerrainHexDef } from "btlib10x";

/** Terrain glyphs keyed by "col,row" (non-clear cells only). */
function deriveTerrainMarks(grid: HexGrid): Record<string, string>;

/** Per-terrain CharStyle keyed by "col,row" (non-clear cells only). */
function deriveTerrainStyles(grid: HexGrid): Record<string, CharStyle>;

/** Non-zero elevation entries keyed by "col,row". */
function deriveElevations(grid: HexGrid): Record<string, number>;

/** Same as deriveTerrainMarks but for TerrainHexDef[] (map display). */
function deriveMapMarks(terrain: readonly TerrainHexDef[]): Record<string, string>;

/** Same as deriveTerrainStyles but for TerrainHexDef[] (map display). */
function deriveMapStyles(terrain: readonly TerrainHexDef[]): Record<string, CharStyle>;
```

**Changes to `battleModel()`:** Replace the inline derivation loops with
calls to `deriveTerrainStyles()`, `deriveTerrainMarks()`,
`deriveElevations()`.

**Changes to `mapModel()`:** Replace the inline loops with calls to
`deriveMapMarks()`, `deriveMapStyles()`.

**Risk:** Low. The derivation logic is extracted verbatim; factory
signatures and return values are unchanged.

**Verification:** existing `render.test.ts` and `render-styled.test.ts`
cover both factories.

### Phase 3 — Add `composeBoard()` helper

**Goal:** Eliminate the manual spread-reassemble pattern.

**Add to `web/renderer.text.ts`:**

```ts
import type { BoardModel } from "./render.js";

export interface BoardOverlay {
  readonly cells?: Record<string, string>;
  readonly idStyles?: Record<string, CharStyle>;
  readonly edgeStyles?: Record<string, CharStyle>;
  readonly anchorCol?: number;
  readonly anchorRow?: number;
  readonly cols?: number;
  readonly rows?: number;
}

/**
 * Merge `overlay` fields on top of `base`, producing a new BoardModel.
 * Fields present in `overlay` replace the corresponding base field;
 * absent fields pass through unchanged.
 */
export function composeBoard(base: BoardModel, overlay: BoardOverlay): BoardModel;
```

**Rewrite `reachableModel()`** (`format.ts:1324-1390`) to build a
`BoardOverlay` and call `composeBoard(base, overlay)`. The function
shrinks from ~27 lines of spread-reassemble to ~10 lines of overlay
construction.

**Risk:** Low. The composition logic is identical to the existing
spread pattern, just centralized.

**Verification:** `render-styled.test.ts:168-190` (edgeStyles) and
manual reachable-map testing.

### Phase 4 — Split `drawCanvas()` into named layers

**Goal:** Each rendering concern becomes an independent, testable
function operating on the same `Canvas`.

**In `web/renderer.text.ts`, replace `drawCanvas()` with a single hex
pass dispatching one named layer per hex:**

```ts
function drawCanvas(model: BoardModel): Canvas {
  const canvas = makeCanvas(model);
  for (const hex of eachHex(model)) { // column-major, one visit per hex
    drawHexGrid(canvas, hex);     // walls, coord labels, edges
    drawUnitIds(canvas, hex);     // occupant text in bellies
    drawTerrainMarks(canvas, hex);// glyphs at hex bottom
    drawElevationDigits(canvas, hex);
    drawFacingArrows(canvas, hex);
    applyEdgeStyles(canvas, hex); // edge tinting (style-only)
  }
  return canvas;
}
```

Each function receives `(canvas: Canvas, hex: HexContext)` and mutates
only its relevant canvas cells. `HexContext` carries the hex's geometry
(x/y, `col,row` key, terrain `style`, `lastRow`) plus a `model`
back-reference for per-hex record lookups. The layer order is fixed per
hex (grid → units → marks → elevation → facing arrows → edge styles),
matching the historic rendering order. Sharing the `====` edge relies on
`stampEdge` only filling spaces, so batching order across hexes does not
matter.

**Sub-function signatures:**

```ts
function drawHexGrid(canvas: Canvas, hex: HexContext): void;
function drawUnitIds(canvas: Canvas, hex: HexContext): void;
function drawTerrainMarks(canvas: Canvas, hex: HexContext): void;
function drawElevationDigits(canvas: Canvas, hex: HexContext): void;
function drawFacingArrows(canvas: Canvas, hex: HexContext): void;
function applyEdgeStyles(canvas: Canvas, hex: HexContext): void; // exported
```

`HexContext` and `eachHex` are exported (through `render.ts`) so a
synthetic-canvas test can drive `applyEdgeStyles` with the same single
pass.

**Risk:** Medium. The logic moves from one function to six, so
inter-layer assumptions (e.g. "the grid is drawn first so wall chars
exist for facing arrows to overwrite") must be preserved by the fixed
call order. Each sub-function can be tested independently via a
pre-populated canvas.

**Verification:** All existing render tests exercise the full pipeline.
Add a focused unit test for `applyEdgeStyles` using a synthetic canvas.

### Phase 5 — Flatten the file-level circular re-export

**Goal:** Leave `render.ts` as the only value-level importer of
`renderer.text.ts`, and remove the second module cycle
(`renderer.text.ts` ↔ `board-derivation.ts`).

**Merge `web/board-derivation.ts` back into `web/renderer.text.ts`:**
the five derivation helpers become module-private functions in
`renderer.text.ts` (they read the `TERRAIN_GLYPHS`/`TERRAIN_STYLES`
constants already defined there); delete `web/board-derivation.ts`.
This kills the value-level cycle between the two files.

**Types stay in `web/render.ts`** (no `board-types.ts`):
`renderer.text.ts` continues to type-import `BoardModel`, `CharStyle`,
`Span` from `./render.js`. That back-edge is type-only and erased at
compile time, so the resulting graph is:

```text
render.ts ──values──► renderer.text.ts
     ▲                     │
     └──── types only ─────┘
```

All value imports flow one way (`render.ts → renderer.text.ts`); there
is no runtime module cycle. `getBoardRenderer` and its `RENDERERS` map
stay in `render.ts`. A comment at the top of `render.ts` documents the
intentional type-only back-edge.

**Risk:** Low. No behavioral change; only file locations and import
paths change. `web/board-derivation.ts` has no consumers outside
`renderer.text.ts`.

**Verification:** `tsc --noEmit` clean; `rg "board-derivation" .`
returns zero hits; `rg "renderer\.text\.js" web/` lists only
`render.ts`; all tests pass.

---

## Phase execution order

```
Phase 1  (rename)            ─── mechanical, zero risk
Phase 2  (derive helpers)    ─── extract logic, no API change
Phase 3  (composeBoard)      ─── new helper, rewrite reachableModel
Phase 4  (drawCanvas split)  ─── restructure internals, same outputs
Phase 5  (file reorg)        ─── merge derivation back, break cycle
```

Phases 1–3 are independent of 4–5 and can be done in any order.
Phase 5 depends on nothing else and can be done at any time. Phase 4
benefits from Phase 2 being done first (the sub-functions can call the
new derivation helpers directly).

## Deferred

These items are out of scope for this refactoring pass:

- [ ] `web/format.ts` split — defer until a 4th command group lands.
- [ ] `BoardModel` gaining new fields (e.g. damage overlay, LOS
      highlight) — do that after the refactoring lands so the new fields
      go into the clean structure.
- [ ] `battleModel()` silently dropping `idStyles` when explicit `styles`
      is passed — document the behavior with a comment; changing it
      would alter rendering semantics.

## Verification checklist

After all phases, run:

```sh
npm run lint && npm run typecheck && npm test
```

Additional manual checks:

- `board text` renders identical output before and after.
- `board` (CSS Grid) renders identical styled output.
- `reachable` map renders with correct team tinting and edge styles.
- `info map <name>` renders terrain glyphs and elevation digits.
- No TypeScript import cycles: `tsc --noEmit` clean.
- `grep -r 'cellStyles' web/ tests/` returns zero hits (Phase 1 done).
