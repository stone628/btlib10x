# Game refactoring: splitting `src/rules/game.ts`

Status: **plan, not started.** Measured against `main` at `bef7fafc` ("fixed TAG firing bug"), working tree clean.

## TL;DR

- Today an edit to `game.ts` selects **61 of 86** test files. So does an edit to almost any other rules file (`heat.ts` 61, `tohit.ts` 62, `score.ts` 60), because everything funnels through `game.ts` *and* through `tests/helpers.ts`.
- Splitting `game.ts` alone is not enough. Three test-side leaks must be fixed with it: `tests/helpers.ts` (imported by 57 tests) pulls in the `src/index` barrel, `game.ts` and the web CLI; inline `import { type X }` keeps a runtime edge under `verbatimModuleSyntax`; and `createTestBattle` calls `advancePhase`, which reaches every phase.
- With the split below plus those fixes, the past bug fixes I replayed would have selected **15 to 35** test files instead of 61. A typical attack-declaration fix like the TAG one goes from 61 to **23**.
- The work is 8 steps. Each step only moves code and keeps the full suite green, so it can stop after any step.

## 1. What the graph looks like today (measured)

Measured with vitest's own `getTestDependencies` (the function `vitest related` and `--changed` use), via `tools/related.mjs`. A static model (`tools/after.mjs`, `MODE=before`) gives identical numbers.

| Edited file | Test files selected |
|---|---|
| `src/rules/game.ts` | 61 / 86 |
| `src/rules/heat.ts` | 61 |
| `src/rules/critical.ts` | 61 |
| `src/rules/tohit.ts` | 62 |
| `src/rules/score.ts`, `salvage.ts`, `fireability.ts` | 60 |
| `tests/helpers.ts` | 57 |

Why:

1. **`game.ts` is the hub.** It has 6330 lines, imports 19 of the other 23 rules modules, and is imported directly by 47 test files plus `helpers.ts` (75 import statements). Three rules modules import values back from it (`physical`, `fireability`, `salvage`) and six more import types. The `physical` import makes a runtime cycle `game ↔ physical`, so anything that touches `physical` touches everything.
2. **`tests/helpers.ts` is a second hub.** 57 tests import it, mostly for `scriptedRng` (40) and `createTestBattle` (40). It imports `../src/index` (the barrel, which is all of `src`), `../src/rules/game`, and `../web/terminal/cli`. So even `hex.test.ts`, which only wants `bearing`, depends on the whole engine.
3. **Inline type imports are real edges.** With `verbatimModuleSyntax`, `import { type UnitState } from "../src/rules/game"` keeps `import {} from ".../game"` at runtime, so vitest follows it. I verified this with a throwaway test: the inline form was selected by a `game.ts` edit and `import type { UnitState }` was not.
4. **`createTestBattle` calls `advancePhase`** for the end → initiative step. `advancePhase` lives next to `resolveHeatPhase` and `resolveAllAttacks`, so after a naive split it would still pull in every phase.

Internally `game.ts` is already layered. The only real knot is the damage-consequence cluster: `applyFall → applyDamageGroups → markUnitDestroyed → resolveEjection → leaveHull…`, and `applyFall ↔ resolveBuildingCollapse`. These are mutually recursive and have to stay in one module.

## 2. Proposed modules

New folder `src/rules/game/`. Line counts are what moves, computed from the current file.

| Module | Contents (main symbols) | Lines | Imports from `game/*` |
|---|---|---|---|
| `types.ts` | every `interface` / `type` (`UnitState`, `BattleState`, `GameEvent`, decl types, options) | ~1030 | (types only) |
| `constants.ts` | `TEAM_IDS`, `DEFAULT_UNIT_POLICY`, `GIRDER_SEARCH_TARGET`, `WRECKAGE_TONNAGE_MIN`, `STAND/DROP_MP_COST`, PSR / seat-belt / building divisors, `DEFAULT_CREATE_BATTLE_OPTION` | ~105 | none |
| `queries.ts` | `requireUnit`, `requirePhase`, `isUnitRemoved`, `isHull`, `isShutdown`, `isNominal`, `isUnitOnBoard`, `isTargetableBy`, `occupantAt`, `wreckageAt`, `hasWreckage`, `cloneDamage`, `unitTonnage` | ~145 | none |
| `condition.ts` | `isImmobile`, `isUnitWrecked`, `awaitsDestroyedMark`, `destroyedReasonFor`, `legGone` (need `damage`/`critical`) | ~50 | queries |
| `geometry.ts` | `partialCover*`, `losEnds`, `facingToward`, `inferPronePropArm` | ~110 | none |
| `melee.ts` | `meleeDeclarationProblem` (needs `physical`, so it must sit above it) | ~50 | queries, geometry |
| `ledger.ts` | `creditDealt`, `killCredit`, `damageTaken`, `newlyDestroyedStructures` | ~85 | none |
| `turnOrder.ts` | `actorQueue`, `pendingActors`, `buildActorQueue`, `nextActor`, `requireCurrentActor`, initiative phase, **`startNextTurn`** (today's `processEndPhase`) | ~150 | queries |
| `buildings.ts` | `damageBuildingAt`, `collapseDamageTotal` | ~60 | queries, constants |
| `clubs.ts` | club tokens, pickup choose/validate/declare/resolve, `applyClubDrop`, `releaseClub`, `enforceClubHands*`, severed-limb records | ~345 | queries, turnOrder |
| `consequences.ts` | the recursive cluster: `applyDamageGroups`, `applyFall`, `applyPilotHits`, `markUnitDestroyed`, hull/remains/salvage fall, ejection, CT blast, building collapse, `pushPilotingCheck`, `shutdownFallCheck` | ~635 | queries, condition, ledger, clubs, buildings |
| `pilotingPhase.ts` | `resolvePhasePiloting` | ~140 | consequences |
| `create.ts` | `createBattle`, `buildUnitInit` | ~155 | turnOrder |
| `posture.ts` | posture costs and budget, `attemptStandUp`, `standUpCost`, `dropProne` | ~180 | consequences, clubs |
| `terrainPsr.ts` | `movementTerrainPsr`, `waterHalvesFall` | ~260 | consequences |
| `move.ts` | `executeMove`, `executePostureMove`, `moveUnit`, `passMovement` | ~510 | posture, terrainPsr, melee, pilotingPhase |
| `declare.ts` | `validateAttacks(Impl)`, `declareAttacks`, physical-set checks, `passAttack` | ~525 | geometry, condition, turnOrder, clubs |
| `resolveAttacks.ts` | `resolveUnitAttacks`, `resolveAllAttacks` | ~970 | consequences, pilotingPhase, ledger, clubs, buildings |
| `heatPhase.ts` | `resolveHeatPhase` | ~400 | consequences, pilotingPhase |
| `pilotActions.ts` | `ejectPilot`, `abandonPilot`, `voluntaryShutdown`, `attemptVoluntaryStartup` | ~135 | consequences |
| `loop.ts` | `advancePhase(Gen)`, `gameLoop`, battle loop generator | ~120 | turnOrder, heatPhase, resolveAttacks |

`tools/model.mjs` checks this assignment against the real symbol references in `game.ts`. The module graph is **acyclic**, with bottom-up order `constants < queries < condition < geometry < melee < ledger < turnOrder < buildings < clubs < consequences < pilotingPhase < create < posture < terrainPsr < move < declare < resolveAttacks < heatPhase < pilotActions < loop`. The only cycle left anywhere under `src/` is the existing `piloting ↔ critical` one, which this plan doesn't touch.

Every module is under 1000 lines, and the big phase functions (`moveUnit`, `validateAttacksImpl`, `resolveHeatPhase`, `resolveAllAttacks`) each get their own file.

## 3. Import direction rules

```
core/*, data/*                          (no rules imports)
rules/<leaf>.ts  (tohit, heat, critical, damage, piloting, …)
game/types, game/constants              (types: import type only)
game/queries, condition, geometry, ledger
rules/physical, fireability, salvage    (now import game/queries|geometry|clubs, never game.ts)
game/melee, turnOrder, buildings, clubs
game/consequences → pilotingPhase
game/create, posture, terrainPsr → move;  declare;  resolveAttacks;  heatPhase;  pilotActions
game/loop
src/index.ts  (public barrel)
```

Rules:

- A `game/*` module imports only modules below it. No module under `src/rules/` imports `./game` (the facade) or `../index`.
- Types always use `import type { … }`, never inline `{ type X }`. Biome's `style/useImportType` with `style: "separatedType"` can enforce this, and `organizeImports` keeps them sorted.
- Tests import the specific module (`../src/rules/game/declare`), never `../src`, `../src/index` or `../src/rules/game`. The exception is tests that exist to check the public API. Enforce with Biome `noRestrictedImports` scoped to `tests/**` and `src/rules/**` (check the option shape against the installed Biome 2 version).

## 4. Facade and barrel policy

- **`src/index.ts` stays the public API** and keeps its export list. It re-exports straight from `./rules/game/<module>`, not through a facade. It is only used by `dist`, the web layer (`"btlib10x"`) and API-surface tests.
- **`src/rules/game.ts` becomes a temporary facade** (`export * from "./game/…"`, `export type * from "./game/types"`). It lets each move step land without touching 47 test files at once. **The risk:** while anything imports the facade, it depends on all 21 modules, so selection doesn't improve for that importer. The numbers in section 6 assume step 7 has removed every non-index import of the facade. After that, delete `game.ts`, or keep it with the lint ban.
- Functions that are private today but become cross-module (`markUnitDestroyed`, `pushPilotingCheck`, `applyDamageGroups`, `releaseClub`, …) are exported from their `game/*` module but **not** added to `src/index.ts`. The public surface stays the same.

## 5. Step-by-step order

Do the work on a branch, with one commit per step. After each step, run `npm run lint && npm run typecheck && npm run build && npm test` (the full suite takes about 65 s). Steps 2 to 6 are verbatim moves plus import fixes. No logic changes; diff review should show only moved blocks.

**Step 0: sequencing.** The TAG-fire fix is already committed (`bef7fafc`, tree clean, 6 commits ahead of `origin/main`), so nothing needs to be reapplied. Land any other fix in flight that touches `game.ts` *before* step 2. Git's rename detection won't follow functions into new files, so a fix rebased across the split has to be re-applied by hand to the new module. Keep steps 2 to 6 short in calendar time, ideally one sitting, so no other `game.ts` edits land in between.

**Step 1: test helpers (no engine change).** Split `tests/helpers.ts` into:
- `tests/helpers/rng.ts`: `scriptedRng`, `seededRng` (no imports)
- `tests/helpers/battle.ts`: `createTestBattle`, `critState`, `critWeapon`, `overrideAmmoBin`, `checkVictory`, `bearing`
- `tests/helpers/piloting.ts`: `sweepPiloting`, `groupsTotaling`
- `tests/helpers/session.ts`: `disableCritical`, `currentActor`, `chunkText`, `execute` (the only one importing `web/`)

Update the 57 importers with a small codemod. Don't leave `tests/helpers.ts` behind as a re-export barrel. Also convert inline `{ type X }` imports in `tests/` to `import type`. On its own this barely moves the numbers (game edits still select 59), but every later step depends on it.

**Step 2: `types.ts` + `constants.ts`.** Move all type declarations and the constants. `game.ts` re-exports them. Switch `critical`, `pilot`, `piloting`, `snapshot`, `score`, `tohit` to `import type … from "./game/types"`.

**Step 3: leaf modules.** `queries`, `condition`, `geometry`, `ledger`, `turnOrder`, `buildings`. Repoint `physical.ts`, `fireability.ts`, `salvage.ts` to them, which removes the `game ↔ physical` cycle. In `turnOrder`, export the body of `processEndPhase` as `startNextTurn`. This is the one non-verbatim change: `advancePhaseGen`'s `"end"` case then calls `startNextTurn`, and `createTestBattle` calls `startNextTurn(state)` plus `state.actorQueue = null` instead of `advancePhase`. It does the same thing, but review it separately.

**Step 4: `clubs`, `consequences`, `pilotingPhase`.** Move the recursive cluster as one block.

**Step 5: movement.** `create`, `posture`, `terrainPsr`, `melee`, `move`.

**Step 6: attack and end phases.** `declare`, `resolveAttacks`, `heatPhase`, `pilotActions`, `loop`. `game.ts` is now re-exports only.

**Step 7: rewire importers.** A codemod maps each imported symbol to its defining module and rewrites the 75 test imports of `../src/rules/game`, plus the 18 tests importing `../src` / `../src/index`, where they aren't API tests. Point `src/index.ts` at the modules directly. Add the Biome restrictions from section 3. Delete `game.ts` or keep it banned.

**Step 8: docs.** Update `AGENTS.md` (the "mutated through `src/rules/game.ts` APIs only" rule becomes "through `src/rules/game/*`"; the selection-quirk numbers), and the `game.ts` mentions in `docs/API.md` and `docs/REPLAY.md`.

**Step 9: make the selective run the default test action.** Add `scripts/test-default.mjs` and point `npm test` at it:

1. If the working tree has uncommitted changes (staged, unstaged or untracked, per `git status --porcelain`), run `vitest run --changed` (vitest's default `--changed` is exactly the uncommitted set).
2. Otherwise run `vitest run --changed HEAD~1`, which covers the files in the last commit. Vitest diffs `HEAD~1...HEAD` here. If there is no parent commit, fall back to the full suite.
3. If the selected set touches `src/`, run `npm run build` first so the session tests that load `dist/` aren't stale.
4. Print which mode was picked and the file count, so a vacuous "0 tests" run is visible. If a forced-rerun trigger (`package.json`, the vitest config) changed, vitest already runs everything.

The full suite moves to `npm run test:all`. `test:changed` / `test:related` stay as they are.

Document it in two places:
- **`AGENTS.md`**: under Commands, `npm test` now means "uncommitted changes, or the last commit if the tree is clean" and `npm run test:all` is the full suite. The done criteria become `npm run lint && npm run typecheck && npm test` while iterating on a change, and `npm run test:all` before pushing, or whenever `package.json`, the test setup or data packs change. The "Filtered runs" paragraph is updated to match.
- **Claude Code**: Claude Code reads `CLAUDE.md`, not `AGENTS.md`, and the repo has no `CLAUDE.md` today. Add a short `CLAUDE.md` that imports `@AGENTS.md` and states the default: "To test, run `npm test` (uncommitted changes, else the last commit). Run `npm run test:all` only when asked, before pushing, or after changing config, setup or catalog data." That makes it Claude's default in every session on this repo.

This step only pays off after steps 1 to 7. Before them, `npm test` would still pick about 61 files for most fixes.

## 6. Expected benefit

From the static model after steps 1 to 7 (`tools/after.mjs`, `MODE=after`). The before column is measured. Units are test files out of 86.

Replaying real past commits by the functions they touched:

| Past change | Touched (new modules) | Before | After |
|---|---|---|---|
| `bef7fafc` fixed TAG firing | declare | 61 | **23** |
| `d93a2863` ammo free shot | declare | 61 | **23** |
| `1f93b0f2` DFA vs prone | resolveAttacks | 61 | **27** |
| `fac1eb50` prone gyro facing | move + terrainPsr | 61 | **15** |
| `87e41916` stand-up preview | posture | 61 | **15** |
| `d92ee261` phantom engine kill | resolveAttacks + ledger | 61 | **35** |
| `9498b08b` building crash | consequences + terrainPsr + resolveAttacks | 61 | **35** |
| `b5103301` startup shutdown state | pilotActions + heatPhase + turnOrder | 61 | 49 |

Per module:

| Edited | After | | Edited | Before → After |
|---|---|---|---|---|
| game/pilotActions | 6 | | rules/score.ts | 60 → **1** |
| game/move, posture, terrainPsr, melee | 15 | | rules/salvage.ts | 60 → **1** |
| game/heatPhase, loop | 21 | | rules/fireability.ts | 60 → **9** |
| game/declare | 23 | | rules/snapshot.ts | 61 → 29 |
| game/resolveAttacks | 27 | | rules/physical.ts | 61 → 36 |
| game/consequences, pilotingPhase | 35 | | rules/heat.ts | 61 → 44 |
| game/clubs | 36 | | rules/tohit, critical, piloting | 61–62 → 53 |
| game/geometry | 40 | | | |
| game/create, turnOrder | 49 | | | |
| game/queries | 59 | | | |

Floors that remain, and why:

- **`queries` (59), `create`/`turnOrder` (49):** nearly every test builds a battle and calls `requireUnit`. These modules are small and stable, so edits there should be rare.
- **Integration tests:** about 21 tests drive `advancePhase` / `resolveAllAttacks` and legitimately depend on every phase. They are always selected for any engine edit, which is correct.
- **`tohit` / `piloting` / `critical` (53):** `createBattle` imports skill defaults (`DEFAULT_GUNNERY`, `DEFAULT_PILOTING`, `isValidPilotHitMax`) from them. Moving those defaults into `pilot.ts` or `game/constants.ts` later would cut these further. That's a follow-up, not part of this plan.
- **Session/web tests** reach the engine only through `"btlib10x"` → `dist/`, which vitest's graph treats as `dist/index.js`. After step 1 they stop being selected by `src/` edits. Before, they were selected but still ran against stale `dist` unless you built first (the AGENTS.md "stale-dist trap"). For engine changes that affect sessions, run `npm run build` and then the full suite. A possible follow-up is a vitest `resolve.alias` from `btlib10x` to `src/index.ts`: that makes web tests always run against `src`, but they'd then be selected for every engine edit.

## 6a. Slow session tests (persona, replay, rollback, autoplay)

Full-suite timings (cloud copy, `--reporter=json`): `persona` 41.3 s, `replay` 11.8 s, `rollback` 2.6 s, `autoplay` 1.1 s, out of ~62 s total. Everything else is under 1 s per file.

These tests drive `web/terminal/session`, which imports the engine as `"btlib10x"`, i.e. **`dist/`**, not `src/`. Today they get selected for every `src/` edit only through `tests/helpers.ts` → `src/index`, even though they then run against whatever `dist/` was last built.

After the split (model):

| Edited | Selected | Time of selected files |
|---|---|---|
| `game.ts` today | 61 incl. persona + replay | ~61 s (≈ full suite) |
| `game/declare` | 23, none of the four | ~1.8 s |
| `game/move` | 15 | ~1.0 s |
| `game/resolveAttacks` | 27 | ~1.9 s |
| `game/consequences` | 35 | ~2.2 s |
| `web/terminal/persona*.ts`, `session*.ts` | all four | unchanged |

Remaining leaks, fixed in step 7: `autoplay.test.ts` imports `../src/index` (barrel), `replay.test.ts` imports `buildUnitInit` from `src` (so `game/create` edits select it), and `currentActor` in `helpers/session.ts` should take `requireUnit` from `"btlib10x"` rather than `src`, so the session helper has no `src/` edge at all.

Consequence: a `src/` engine fix no longer runs persona/replay during iteration. They only exercise the engine after `npm run build`. For an engine change that can affect sessions or bot behaviour, run `npm run build && npx vitest related dist/index.js --run` (selects every session test) or the full suite before calling it done, as AGENTS.md already requires.

## 7. Optional phase 2 (not pure moves, decide later)

- `resolveAllAttacks` alone is 787 lines and sits behind most attack fixes. Splitting it into weapon resolution, physical resolution and damage application would get attack-fix selection below 27, but that is a real refactor with behaviour risk.
- Move pilot-skill defaults out of `tohit`/`piloting` (see floors above).

## Tools

The measurement scripts are not in the repo. They are kept in the project files as `game-split/tools/`, and can be copied into `tmp/` to re-measure after each step:

- `related.mjs`: real vitest selection (`node tmp/related.mjs src/rules/heat.ts …`, `V=1` lists the files).
- `model.mjs`: checks the symbol-to-module assignment for cycles and prints sizes and edges.
- `after.mjs`: static before/after selection model (`MODE=before|after`, `a.ts+b.ts` for unions, `WHY=test:file` prints the import path).
