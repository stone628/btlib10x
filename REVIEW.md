# REVIEW.md — btlib10x code review

Overall: high-quality, well-disciplined TypeScript project. Tight scope (Classic
BattleTech quick-start subset, bipedal only), strict TS config
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zero runtime deps,
deterministic rule functions, in-place state mutation, atomic rollback at the
session layer. Tests (167 passing) and the build/lint/typecheck triple are
clean. Conventions in `AGENTS.md` are followed consistently.

## Findings ranked by impact

### High impact — correctness / robustness

1. `src/rules/game.ts:302-308`, `web/session.ts:317-319` — duplicate
   hand-rolled "are these two hexes adjacent" check.
2. `src/rules/game.ts:422-431`, `:500-502`, `src/rules/fireability.ts:48-57`
   — three copies of the intervening-terrain woods-points sum.
3. `src/rules/game.ts:447` — `decls.indexOf(decl) === 0` is O(n²) and
   obscures intent; the values captured inside are loop-invariant.
4. `src/rules/game.ts:521-528`, `:578-588` — destroy/remove flagging and
   paired events are duplicated verbatim.
5. `src/rules/damage.ts:137-148` — arm-blowoff copy/paste.
6. `src/rules/initiative.ts:18` — `rng.d6() + rng.d6()` instead of `roll2D6`.
7. `src/data/mechCatalog.generated.ts` — file comment claims "front + rear
   summed" but the implementation keeps them separate. Same lie is baked
   into the gen-script template.

### Medium impact — convention / maintainability

8. `src/rules/attack.ts:128-137` — per-group `DamageApplication` accumulator
   spreads the whole prior array each iteration (O(n²) for `steps`).
9. `src/rules/movement.ts:141-248` — `reachableLandings` keeps a full
   fragment path per state (heap pressure on every enqueue). Parent-pointer
   BFS would be cheaper.
10. `web/format.ts` (1075 lines) — biggest file in the repo; consider
    splitting once a 4th command group lands.
11. `src/rules/game.ts:618-621` — `nextActor` ordering math has a
    effectively-unreachable `loser === winner` branch.
12. `src/data/weapons.ts:30-32` — `WeaponsFile` type is unused outside its
    module; either export or drop.
13. `src/index.ts` — wildcard re-exports promote every internal helper
    (`TRANSFER_INWARD`, `HIT_LOCATION_TABLE`, `parseWeaponsData`) into the
    public surface. Curate when API stability matters.

### Low impact — nice-to-have / future-proofing

14. `tsconfig.json` — missing `noUnusedLocals` / `noUnusedParameters`
    (Biome catches unused imports, but TS-side errors are stricter).
15. `src/rules/cluster.ts:8-20, 28-40` — keyed-by-roll Record types would
    remove the `row - 2` arithmetic in the lookup helper.
16. `src/data/schema.ts:232`, `weapons.ts:83`, `mapschema.ts:93` — three
    `as unknown as` casts at validator exit points; safe but worth
    documenting why exhaustive checks are trusted.
17. `web/main.ts` / `web/cli.ts` — confirm no import cycle (visual scan
    looks clean).
18. `tests/` — `exampleGame.test.ts` and `webcli.test.ts` are full
    integration tests; consider tagging with `describe("integration", ...)`.
19. `web/session.ts:401` — `structuredClone` is the only non-trivial runtime
    feature the engine relies on. Web-platform available, but worth a
    comment.

## What's already great (no change needed)

- Determinism is enforced at the type system boundary: `Rng` injected
  everywhere, all rule functions pure on inputs.
- Atomic commit at `commitAtomic` (`web/session.ts:398-408`) — rules mutate
  freely, session guarantees all-or-nothing.
- i18n catalog with compile-time key enforcement; `kr.ts` cannot drift
  from `en.ts`.
- Generated `mechCatalog.generated.ts` with a `gen:mechs` step that runs
  before typecheck/test/build.
- Hand-rolled validators (no JSON Schema, no Zod) align with the
  zero-runtime-deps rule and surface all errors at once.
- Doc comments on every public function describing the rulebook source.
- Biome for both lint and format.
- One-shot `npm run lint && npm run typecheck && npm test` in `AGENTS.md`.

## Implementation checklist

- [x] Write REVIEW.md.
- [x] Fix misleading comment in `mechCatalog.generated.ts` and the
      `gen-mech-catalog.mjs` template.
- [x] Extract `isAdjacent(a, b)` into `core/hex.ts`; reuse in
      `rules/game.ts:executeMove` and `web/session.ts:queueEnter`. Added
      coverage in `tests/hex.test.ts`.
- [x] Extract `losWoodsPointsBetween(terrain, from, to)` and
      `interveningTerrains(terrain, from, to)` into `rules/los.ts`; reuse
      in `rules/game.ts:declareAttacks`,
      `rules/game.ts:resolveUnitAttacks`, and
      `rules/fireability.ts:suggestFireTargets`.
- [x] Replace `decls.indexOf(decl) === 0` with a first-iteration flag
      (`decls.forEach((decl, index) => { ... if (index === 0) ... })`).
- [x] Extract `markUnitDestroyed(state, unit)` and use in both
      `resolveUnitAttacks` and `advancePhase`.
- [x] Replace arm-blowoff copy/paste with a `TORSO_TO_ARM` table loop in
      `damage.ts`.
- [x] Use `roll2D6(rng)` in `initiative.ts`.
- [x] Re-export `isAdjacent` from `src/index.ts` so the web layer can
      import it from the public surface.
- [x] Run `npm run lint && npm run typecheck && npm test` — all green
      (168 tests across 18 files, was 167 before the new adjacency test).

## Summary of changes

- `src/core/hex.ts` — added `isAdjacent(a, b)`.
- `src/rules/los.ts` — added `losWoodsPointsBetween(terrain, from, to)`
  and `interveningTerrains(terrain, from, to)`.
- `src/rules/damage.ts` — added `TORSO_TO_ARM` map; replaced the
  rightTorso/leftTorso copy/paste with a single lookup.
- `src/rules/game.ts`:
  - Removed unused `FACINGS` and `neighbor` imports (replaced by
    `isAdjacent`); added imports for the new LOS helpers.
  - Replaced inline jump-adjacency loop with `isAdjacent`.
  - `declareAttacks` switched to `losWoodsPointsBetween`, switched to
    `forEach((decl, index) => …)` with an `index === 0` flag (eliminates
    the O(n²) `decls.indexOf(decl)` lookup).
  - `resolveUnitAttacks` uses the new `interveningTerrains` helper.
  - Extracted `markUnitDestroyed(state, unit)`; used in both
    `resolveUnitAttacks` and `advancePhase`'s end-of-phase kill sweep.
- `src/rules/fireability.ts` — dropped the local `woodsPoints` helper in
  favor of `losWoodsPointsBetween`; cleaned up imports.
- `src/rules/initiative.ts` — uses `roll2D6(rng)` instead of
  `rng.d6() + rng.d6()`.
- `src/index.ts` — re-export `isAdjacent` from the public surface.
- `web/session.ts` — `queueEnter` calls `isAdjacent`; `neighbor` import
  removed.
- `scripts/gen-mech-catalog.mjs` and the regenerated
  `src/data/mechCatalog.generated.ts` — corrected the comment that
  claimed "front + rear summed" (the implementation keeps them
  separate).
- `tests/hex.test.ts` — added an `isAdjacent` test (same-hex, all six
  neighbors, and a couple of far hexes).

### reachableLandings parent-pointer experiment

Tried the parent-pointer BFS refactor (step 1+3 from the plan). It shipped
the public API unchanged and stayed 191/191 green, but the bench (`node
tmp/profile-reach.mjs`, 200 reps on 100×100 empty board) measured a
**regression on the high end**:

| mode / walk | states | before (ms) | after (ms) | delta |
|-------------|--------|-------------|------------|-------|
| walk 4      |    116 |       0.154 |       0.148 |  -3.8% |
| walk 8      |    712 |       0.865 |       0.894 |  +3.3% |
| walk 12     |  1 880 |       2.492 |       2.652 |  +6.5% |
| run 4       |    210 |       0.173 |       0.177 |  +2.3% |
| run 8       |  1 506 |       1.531 |       1.686 | +10.2% |
| run 12      |  4 098 |       4.514 |       5.118 | +13.4% |
| jump 4      |  1 302 |       1.143 |       1.223 |  +7.0% |
| jump 8      |  4 902 |       5.017 |       5.803 | +15.7% |
| jump 12     | 10 806 |      12.652 |      15.652 | +23.7% |

The CPU profile (`node --cpu-prof`, `tmp/cpuprof-summary.mjs`) explains
why: `rebuildPath` (the new end-of-search pass) ate 20% of the wall time
at jump 12 — roughly the same number of array writes, just done after
the BFS instead of during it. The path-spread savings were not the
dominant cost; the dominant costs are still:

- 12.4% in `enqueue` (Map ops; the function-call overhead is small but
  the BFS body has 2 turn + 1 forward + 1 backward call per state).
- 20.4% in `rebuildPath` (the new function, doing the same array
  writes the old code did at the BFS call site).
- 6.2% in `parseHexKey` (the post-search loop re-parses the state
  key string back into `{col, row}`, even though the state queue
  already had the parsed hex).
- The BFS body itself in `reachableLandings` (34.6% self).

**Reverted.** A second pass that also (a) drops `parseHexKey` by reading
the hex from the queue at end-of-search, (b) collapses `dist` + `parent`
into one `Map<key, { cost, parent, frag }>`, and (c) moves the
end-of-search loop to walk the queue directly instead of `dist`, would
probably net out positive. Skipped for now because the current bench
numbers are well under one frame for every realistic CLI case, and the
deliverable is the *data*, not the refactor.

Decision: keep the current implementation. Re-run `node
tmp/profile-reach.mjs` whenever the engine gains a 'Mech with jump MP
> 10 or a board > 30×30; if any case crosses 16 ms, revisit.

## Deferred (not addressed)

- [ ] `reachableLandings` parent-pointer BFS — **tried, reverted**: see
      `### reachableLandings parent-pointer experiment` below. The current
      implementation is the cheapest-correct version we can ship without
      a follow-up that addresses `rebuildPath` itself or collapses the
      Map ops. Defer until a real call site shows >16 ms wall time.
- [ ] `web/format.ts` split — defer until a 4th command group lands.
- [ ] `nextActor` unreachable `loser === winner` branch — leave with a
      comment.
- [ ] Curate `src/index.ts` re-exports — defer until API stability matters.
- [ ] `noUnusedLocals` / `noUnusedParameters` in `tsconfig.json` — Biome
      already covers unused imports.
- [ ] Cluster-table typed-as-Record refactor — cosmetic; current form
      mirrors the printed booklets.
- [ ] Tag integration tests with `describe("integration", ...)` — defer.

## Elevation feature — implementation summary

Adds the four CBT elevation rules (movement climb cost, jump ignoring
elevation, real-valued LOS ray, height-difference to-hit) to the engine.
Scope per the planned minimal subset: bipedal 'Mechs only, no buildings,
basements, water depth, hull-down, or multi-floor interiors.

### Schema & data

- `src/core/types.ts` — `Hex.level?: number` (default 0);
  `TerrainHexDef.level?: number` (default 0).
- `src/core/terrain.ts` — new constants/helpers:
  `DEFAULT_LEVEL`, `MP_PER_LEVEL_CLIMB`, `levelAt(map, hex)`,
  `costToClimb(fromLevel, toLevel)`.
- `src/data/mapschema.ts` — accepts optional `level` on terrain entries;
  validator rejects non-integer / negative values; `toEngineTerrain`
  passes the level through.
- `src/index.ts` — re-exports `DEFAULT_LEVEL`, `MP_PER_LEVEL_CLIMB`,
  `levelAt`, `costToClimb` (and the existing `costToEnter`).

### Battle state

- `src/rules/game.ts` — `BattleState.elevation: Record<string, number>`;
  `createBattle` populates it from each `TerrainHexDef.level` (missing
  values stay at the default 0). `executeMove` rejects >1-level ground
  steps and adds `costToClimb` to the per-step MP cost.
- `src/rules/los.ts` — `losBlockedByElevation(elevation, from, to)`
  computes the real-valued ray between attacker/target LOS levels
  (`hex.level + 1` for bipedal 'Mechs) and reports a block when an
  intervening hex's own LOS level exceeds the ray. `losClear(elevation,
  terrain, from, to)` combines woods and elevation LOS checks.
- `src/rules/fireability.ts` — `suggestFireTargets` now also reports
  `noLos` for elevation blocks and passes `attackerLevel` /
  `targetLevel` to `computeToHit`.
- `src/rules/attack.ts` — `WeaponAttackInput` gains optional
  `attackerLevel` / `targetLevel`; `resolveWeaponAttack` plumbs them
  into `computeToHit`.
- `src/rules/tohit.ts` — `AttackModifiers` gains `attackerLevel?` /
  `targetLevel?`; `ToHitBreakdown` exposes `heightDiff` (raw) and
  `heightMod` (negative `heightDiff`).
- `src/rules/movement.ts` — `ReachabilityOptions` gains
  `elevation: Readonly<Record<string, number>>`; `reachableLandings`
  charges +1 MP per level climbed for ground moves, refuses >1 level
  steps, and lets jump ignore elevation.

### Web layer

- `web/render.ts` — `BoardModel.elevations?: Readonly<Record<string,
  number>>` (keyed by `"col,row"`).
- `web/renderer.text.ts` — `drawCanvas` reads the per-hex level
  instead of the old `ELEVATION_DIGIT` constant; `mapModel` accepts
  elevations and emits them only for non-zero values; `battleModel`
  derives elevations from `state.elevation`.
- `web/format.ts` — `info map` reports an `elevation: L1 4, L2 1`
  breakdown alongside the terrain count; threads `elevations` into
  the static sheet.
- `web/session.ts` — `replaySteps`, `queueEnter`, and `moveStepsInfo`
  all add `costToClimb` to per-step MP; `queueEnter` rejects >1-level
  steps with the new `err.climbTooSteep` error.
- `web/i18n/en.ts` + `web/i18n/kr.ts` — `err.climbTooSteep`,
  `info.elevationLine` (with English + Korean text).

### Tests

- `tests/hex.test.ts` — `levelAt` returns the stored value or
  `DEFAULT_LEVEL`.
- `tests/los.test.ts` (new) — same-level clear LOS; level-1 ridge
  blocks level-0-to-level-0; level-2 attacker over a level-1 ridge
  is clear; tall peak always blocks; `losClear` combines woods and
  elevation.
- `tests/reach.test.ts` — +1 MP per level climbed; >1-level ground
  step rejected; descent is free; jump ignores elevation.
- `tests/tohit.test.ts` — same level = 0 heightDiff, +1 attacker = -1
  to TN, attacker -2 = +2 to TN; new `heightDiff` / `heightMod` fields
  exposed in the breakdown.
- `tests/elevation.test.ts` (new) — ridge-duel worked example
  covering all four rules end-to-end on a small board.
- `tests/mapdata.test.ts` — accepts and rejects optional `level`.

### Final state

- `npm run lint && npm run typecheck && npm test` — all green:
  191 tests across 20 files (up from 168 / 18).
- Out of scope (deferred): buildings, basements, water depth,
  hull-down, multi-floor building interiors, "falling" damage.

### 1-based coordinate conversion (post-elevation)

A project-wide conversion made all hex coordinates 1-based to match the
printed mapsheet labels. The 0-based → 1-based conversion that lived in
`toEngineTerrain` and in every `+1`/`-1` at display boundaries was
deleted.

- `Hex` and `TerrainHexDef` shapes are unchanged; the convention is
  documented in the type comments.
- `src/data/mapschema.ts` validates `1..width` / `1..height` directly.
  `toEngineTerrain` is removed (the public surface re-exports it no
  longer).
- The `web/cli.ts` `coord()` helper no longer subtracts 1 — user input
  is 1-based and goes straight into the engine.
- The `web/format.ts` `disp()` and `web/renderer.text.ts` `coordLabel()`
  no longer add 1 — the engine value is already 1-based.
- The renderer's drawing loop iterates `col = 1..cols` and
  `row = 1..rows`. Cols' x positions are now `(col - 1) * COL_STRIDE`
  so col 1 starts at x=0 (matching the 0-based original layout).
- A `tmp/bump-coords.mjs` script ran the mechanical +1 on every
  `position: { col: N, row: M }` literal and on every terrain-entry
  hex literal in `tests/`. Hardcoded `l.hex.col === N` comparisons and
  display-string expectations were updated by hand after the script.

### Canvas-width fix (uncovered by the 1-based change)

`web/renderer.text.ts` had `canvasCols = (cols - 1) * COL_STRIDE +
HEX_WIDTH` — fine for 0-based, but after the 1-based switch the
rightmost cell now starts at `cols*COL_STRIDE` and needed one more
column's worth of room. Surfaced as tests with 3+ columns truncating
the rightmost cell. Fixed by changing `canvasCols` to `cols * COL_STRIDE
+ HEX_WIDTH` (the 1-based form of the same formula). All 12 render
tests pass.

### Hex-geometry bug (fixed)

User's original report: from a unit at display (3,4) facing "ne", the
engine reported a forward step to (4,4) but the visual `↗` points to
what looks like (4,3). Root cause: the diagonal `ne`/`se`/`sw`/`nw`
deltas in `src/core/hex.ts` were swapped relative to the renderer's
stagger. The renderer lowers odd columns (`baseY = col % 2 === 1`
STAGGER), which is the same as raising even columns, so an even-col
hex's `ne` neighbor is one col over AND one row up — the old code put
it at the same row. `n`/`s` were already right.

Fix: replaced both delta tables in `src/core/hex.ts`:
- even col: ne [+1,-1], se [+1,0], nw [-1,-1], sw [-1,0]
- odd col:  ne [+1,0], se [+1,+1], nw [-1,0], sw [-1,+1]

The `offsetToCube` conversion already encoded even-columns-raised
(`z = row - (col + (col & 1)) / 2`), consistent with the renderer, so
cube-distance and line tracing were untouched. Updated the module
header comment.

Tests that pinned the old relationships were updated: `hex.test.ts`,
`reach.test.ts` (ne/nw side-neighbor hexes and the diagonal two-MP-walk
path), `elevation.test.ts` (the ridge-duel units now face se/sw toward
the ridge, since even-col `ne` went up instead of across), `game.test.ts`
(se-forward chain, backward hex, occupied-forward hex, jump hop), and
`exampleGame.test.ts` (the Wolverine's run now ends at (4,6) instead of
(4,5); range 7, woods (7,7) on the LOS line, and all to-hit numbers are
unchanged). Full suite: lint + typecheck + 191/191 tests passing.

Final state: lint + typecheck + 191/191 tests passing. Out-of-scope
items: buildings, basements, water depth, hull-down, multi-floor
building interiors, "falling" damage, and the hex-geometry delta fix.
