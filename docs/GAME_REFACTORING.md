# Game refactoring: splitting `src/rules/game.ts`

Status: **done (steps 0 to 9), uncommitted.** `src/rules/game.ts` is deleted; the engine lives in 24 modules under `src/rules/game/`. Measured outcome in section 8. The rest of this document is the plan as executed, kept for the rationale. Baseline measurements below are against `main` at `aa4d6080` ("added club drop discrepancies"), vitest 5.0.5; the first version of this plan was measured at `bef7fafc` ("fixed TAG firing bug").

## What changed since the first measurement

- **`game.ts` grew from 6330 to 7055 lines.** New code since `bef7fafc` includes AMS / Laser AMS missile defense (`amsMountsAtPhaseStart`, `amsCovering`, `prepareMissileDefense`, `missileDefenseFor`), per-weapon fire helpers pulled out of `resolveUnitAttacks` (`runningStateFor`, `ownStateFor`, `spendOwnAmmo`, `volleyContextFor`, `weaponToHitInputFor`), unit policy commands (`unitPolicyOf`, `setUnitPolicy`), underwater air supply (`resolveAirSupply`), `canUnitStandUp`, `isValidTeam`, `isUnitAvailable`, `occupantTeamAt`, attack-direction helpers (`attackDirectionFor`, `losSideFor`, `partialCoverDetail`), `salvageFallConsciousness`, `removePilotKilled`, `voidLimbSalvage`, `physicalWeaponConflict` and `requireValidFinalFacing`. All of them are placed in section 2.
- **Tests were consolidated** (`f4118ed5`, then pruned in `9882d875`): 86 test files became **37**, one per testing area. The separate `persona`, `rollback` and `autoplay` test files no longer exist; their cases live in `players`, `session`, `policy` and `replay`.
- **Vitest went from 2.1 to 5.0.5** (`a880b599`). Vitest 5 runs **every** test when a changed file is reachable from a `setupFiles` entry, and `tests/setup.ts` imports the `../src` barrel. So today any edit under `src/` selects all 37 files. This is a new blocker, handled by step 1a.
- **The full suite is now about 10 s wall time** (1554 tests, down from ~65 s), so selective runs save less than they used to. The split is still worth it for module size and reviewability, and selection still matters for watch mode and for the large files.
- The measurement scripts (`game-split/tools/`) are no longer in the project files, and they used the vitest 2 API. The Tools section describes a vitest 5 replacement.

## TL;DR

- Today an edit to `game.ts`, to any other `src/rules/` file, or even to `src/core/hex.ts` selects **37 of 37** test files, because of the setup-file rule above. With that fixed (step 1a, a one-line import change) a `src/rules/` edit selects **32**. The remaining funnel is the same as before: everything goes through `game.ts` *and* through `tests/helpers.ts`.
- Splitting `game.ts` alone is not enough. Four test-side leaks must be fixed with it: `tests/setup.ts` imports the `src` barrel; `tests/helpers.ts` (imported by 30 tests) pulls in the `src/index` barrel, `game.ts` and the web CLI; inline `import { type X }` keeps a runtime edge under `verbatimModuleSyntax`; and `createTestBattle` calls `advancePhase`, which reaches every phase.
- The first plan's model predicted typical fixes going from 61/86 files to 15 to 35. Those numbers were for the old 86-file tree and must be re-modelled after steps 1 and 1a (section 6).
- The work is 10 steps (0, 1, 1a, 2 to 9). Each step only moves code and keeps the full suite green, so it can stop after any step.

## 1. What the graph looks like today (measured)

Measured with vitest 5's own `filterTestsBySource` (the path `vitest related` and `--changed` use), via `tmp/related.mjs` (see Tools).

| Edited file | Selected today | With step 1a only |
|---|---|---|
| `src/rules/game.ts` | 37 / 37 | 32 |
| `src/rules/heat.ts`, `critical.ts`, `tohit.ts`, `score.ts`, `salvage.ts`, `fireability.ts`, `physical.ts`, `ams.ts`, `snapshot.ts` | 37 | 32 |
| `src/core/hex.ts` | 37 | 32 |
| `src/data/catalog.ts` | 37 | 37 (the setup file needs it) |
| `tests/helpers.ts` | 30 | 30 |

The five files that escape after step 1a are `avatar`, `catalog`, `data`, `gallery` and `gallery-api`; every other test reaches the whole engine.

Why:

1. **`tests/setup.ts` is reached by every test.** It is the vitest `setupFiles` entry and does `import { loadCatalog } from "../src"`. Vitest 5 (`AffectedModulesResolver.findAffectedInEnvironment`) returns all specs when a related file is reachable from a setup file. `loadCatalog` also lives in `src/data/catalog.ts`, which the setup file already imports.
2. **`game.ts` is the hub.** It has 7055 lines, imports 20 of the other 24 rules modules (all but `cluster`, `fireability`, `salvage`, `score`), and is imported directly by 28 test files (31 import statements) plus `helpers.ts`. Three rules modules import values back from it, and six more import types only:
   - `physical`: `isImmobile`, `isTargetableBy`, `isUnitOnBoard`, `isUnitRemoved`, `losSideFor`, `partialCoverMod`. This makes a runtime cycle `game ↔ physical`, so anything that touches `physical` touches everything.
   - `fireability`: the same plus `losEnds`, `shooterInPartialCover`.
   - `salvage`: `isHull`, `salvageableSeveredLimbs`, `WRECKAGE_TONNAGE_MIN`.
   - Types only: `critical`, `pilot`, `piloting`, `snapshot`, `score`, `tohit`.
3. **`tests/helpers.ts` is a second hub.** 30 tests import it, mostly for `scriptedRng` and `createTestBattle`. It imports `../src/index` (the barrel, which is all of `src`), `../src/rules/game`, `../src/rules/physical`, and `web/terminal/cli` + `renderer.text`. So even a test that only wants `bearing` depends on the whole engine. Separately, 15 test files import `../src` / `../src/index` directly.
4. **Inline type imports are real edges.** With `verbatimModuleSyntax`, `import { type UnitState } from "../src/rules/game"` keeps `import {} from ".../game"` at runtime, so vitest follows it. Verified with a throwaway test in the first measurement. About 23 test files still use the inline `{ type X }` form somewhere.
5. **`createTestBattle` calls `advancePhase`** for the end → initiative step. `advancePhase` lives next to `resolveHeatPhase` and `resolveAllAttacks`, so after a naive split it would still pull in every phase. `sweepPiloting` also imports `resolvePhasePiloting` from `game.ts`.

Internally `game.ts` is still layered. The only real knot is the damage-consequence cluster: `applyFall → applyDamageGroups → markUnitDestroyed → resolveEjection → leaveHull…`, and `applyFall ↔ resolveBuildingCollapse`. These are mutually recursive and have to stay in one module.

## 2. Proposed modules

New folder `src/rules/game/`. Line counts are what moves, estimated from the top-level declarations in today's file (doc comments included, imports not).

| Module | Contents (main symbols) | Lines | Imports from `game/*` |
|---|---|---|---|
| `types.ts` | every `interface` / `type` (`UnitState`, `BattleState`, `GameEvent`, `UnitPolicy`, decl types, options) | ~1115 | (types only) |
| `constants.ts` | `TEAM_IDS`, `DEFAULT_UNIT_POLICY`, `GIRDER_SEARCH_TARGET`, `WRECKAGE_TONNAGE_MIN`, `STAND/DROP_MP_COST`, `MOVE_MODES`, `DEFENDER_ARC_RANK`, PSR / seat-belt / building / life-support / pilot-hit constants, `ACCIDENTAL_FALL_BASE_TN`, `DEFAULT_CREATE_BATTLE_OPTION` | ~125 | none |
| `queries.ts` | `requireUnit`, `requirePhase`, `isValidTeam`, `isUnitRemoved`, `isUnitAvailable`, `isHull`, `isShutdown`, `isNominal`, `isUnitOnBoard`, `isTargetableBy`, `occupantAt`, `occupantTeamAt`, `wreckageAt`, `hasWreckage`, `cloneDamage`, `unitTonnage` | ~120 | constants |
| `condition.ts` | `isImmobile`, `isUnitWrecked`, `awaitsDestroyedMark`, `destroyedReasonFor`, `legGone` (need `damage`/`critical`) | ~55 | queries |
| `geometry.ts` | `losSideFor`, `attackDirectionFor`, `attackDirectionOnSide`, `partialCoverDetail`, `partialCover*`, `shooterInPartialCover`, `losEnds`, `facingToward`, `inferPronePropArm` | ~185 | constants |
| `melee.ts` | `meleeDeclarationProblem` (needs `physical`, so it must sit above it) | ~50 | queries, geometry |
| `ledger.ts` | `creditDealt`, `killCredit`, `damageTaken`, `newlyDestroyedStructures` | ~90 | none |
| `turnOrder.ts` | `actorQueue`, `actorToQueueView`, `pendingActors`, `buildActorQueue`, `nextActor`, `requireCurrentActor`, initiative phase, **`startNextTurn`** (was `processEndPhase`), `unitPolicyOf`, `setUnitPolicy` (needs `requireCurrentActor`) | ~220 | queries |
| `buildings.ts` | `damageBuildingAt`, `collapseDamageTotal` | ~60 | queries, constants |
| `clubs.ts` | club tokens, pickup choose/validate/declare/resolve, `voidLimbSalvage`, `salvageableSeveredLimbs`, `applyClubDrop`, `releaseClub`, `enforceClubHands*`, severed-limb records (`recordSeveredLimbs`, `recordCritSeveredLimbs`) | ~345 | queries, turnOrder |
| `consequences.ts` | the recursive cluster: `applyDamageGroups`, `applyFall`, `applyPilotHits`, `raisePilotHits`, `removePilotKilled`, `markUnitDestroyed`, hull/remains/salvage fall (incl. `salvageFallConsciousness`), ejection, CT blast, cockpit/head-loss checks, building collapse, `damageBuildingByUnit`, `pushPilotingCheck`, `shutdownFallCheck` | ~740 | queries, condition, ledger, clubs, buildings |
| `pilotingPhase.ts` | `resolvePhasePiloting` | ~140 | consequences |
| `create.ts` | `createBattle`, `buildUnitInit`, `catalogModel` | ~180 | turnOrder |
| `posture.ts` | posture costs and budget, `canUnitStandUp`, `attemptStandUp`, `standUpWalkBudget`, `standUpCost`, `dropProne` | ~205 | consequences, clubs |
| `terrainPsr.ts` | `movementTerrainPsr`, `waterHalvesFall` | ~250 | consequences |
| `move.ts` | `executeMove`, `executePostureMove`, `requireValidFinalFacing`, `moveUnit`, `passMovement` | ~565 | posture, terrainPsr, melee, pilotingPhase |
| `declare.ts` | `validateAttacks(Impl)`, `declareAttacks`, physical-set checks, `physicalWeaponConflict`, `passAttack` | ~540 | geometry, condition, turnOrder, clubs |
| `missileDefense.ts` | AMS: `amsMountsAtPhaseStart`, `declaredTwist`, `amsCovering`, `prepareMissileDefense`, `missileDefenseFor` | ~120 | geometry, weaponFire helpers (see note) |
| `weaponFire.ts` | `runningStateFor`, `ownStateFor`, `spendOwnAmmo`, `volleyContextFor`, `weaponToHitInputFor`, `resolveUnitAttacks` | ~265 | geometry, consequences, ledger, missileDefense |
| `resolveAttacks.ts` | `resolveAllAttacks` | ~810 | consequences, pilotingPhase, ledger, clubs, buildings, weaponFire, missileDefense |
| `heatPhase.ts` | `resolveHeatPhase`, `resolveAirSupply` | ~430 | consequences, pilotingPhase |
| `pilotActions.ts` | `ejectPilot`, `abandonPilot`, `voluntaryShutdown`, `attemptVoluntaryStartup` | ~135 | consequences |
| `loop.ts` | `advancePhase(Gen)`, `gameLoop`, battle loop generator | ~100 | turnOrder, heatPhase, resolveAttacks |

Note on `missileDefense` / `weaponFire`: these are new since the first plan. `missileDefenseFor` calls `ownStateFor` and `spendOwnAmmo`, and `prepareMissileDefense` calls `volleyContextFor` and `weaponToHitInputFor`, while `resolveUnitAttacks` calls `missileDefenseFor`. To stay acyclic, put the five per-weapon helpers in a small `weaponState.ts` (~140 lines) below both, and keep `resolveUnitAttacks` in `weaponFire.ts`. Order: `weaponState < missileDefense < weaponFire < resolveAttacks`.

The assignment above was checked by hand against today's callers. It still needs a mechanical check (the old `tools/model.mjs` did this) before step 2. The intended bottom-up order is `constants < queries < condition < geometry < melee < ledger < turnOrder < buildings < clubs < consequences < pilotingPhase < create < posture < terrainPsr < move < declare < weaponState < missileDefense < weaponFire < resolveAttacks < heatPhase < pilotActions < loop`. The only cycle left anywhere under `src/` should be the existing `piloting ↔ critical` one, which this plan doesn't touch.

Every module is under 1000 lines except `types.ts` (~1115, declarations only; split it by domain if that matters). The big phase functions (`moveUnit` 472 lines, `validateAttacksImpl` 292, `resolveHeatPhase` 398, `resolveAllAttacks` 809) each get their own file.

## 3. Import direction rules

```
core/*, data/*                          (no rules imports)
rules/<leaf>.ts  (tohit, heat, critical, damage, piloting, ams, …)
game/types, game/constants              (types: import type only)
game/queries, condition, geometry, ledger
rules/physical, fireability, salvage    (now import game/queries|condition|geometry|clubs|constants, never game.ts)
game/melee, turnOrder, buildings, clubs
game/consequences → pilotingPhase
game/create, posture, terrainPsr → move;  declare;  weaponState → missileDefense → weaponFire → resolveAttacks;  heatPhase;  pilotActions
game/loop
src/index.ts  (public barrel)
```

Rules:

- A `game/*` module imports only modules below it. No module under `src/rules/` imports `./game` (the facade) or `../index`.
- Types always use `import type { … }`, never inline `{ type X }`. Biome's `style/useImportType` with `style: "separatedType"` can enforce this, and `organizeImports` keeps them sorted. (Neither rule is configured in `biome.json` today.)
- Tests import the specific module (`../src/rules/game/declare`), never `../src`, `../src/index` or `../src/rules/game`. The exceptions are tests that exist to check the public API, and `tests/setup.ts`, which imports `../src/data/catalog`. Enforce with Biome `noRestrictedImports` scoped to `tests/**` and `src/rules/**` (check the option shape against the installed Biome 2 version).

## 4. Facade and barrel policy

- **`src/index.ts` stays the public API** and keeps its export list. It re-exports straight from `./rules/game/<module>`, not through a facade. It is only used by `dist`, the web layer (`"btlib10x"`) and API-surface tests.
- **`src/rules/game.ts` becomes a temporary facade** (`export * from "./game/…"`, `export type * from "./game/types"`). It lets each move step land without touching 28 test files at once. **The risk:** while anything imports the facade, it depends on all 24 modules, so selection doesn't improve for that importer. The numbers in section 6 assume step 7 has removed every non-index import of the facade. After that, delete `game.ts`, or keep it with the lint ban.
- Functions that are private today but become cross-module (`markUnitDestroyed`, `pushPilotingCheck`, `applyDamageGroups`, `releaseClub`, `spendOwnAmmo`, …) are exported from their `game/*` module but **not** added to `src/index.ts`. The public surface stays the same.

## 5. Step-by-step order

Do the work on a branch, with one commit per step. After each step, run `npm run build && npm run lint && npm run typecheck && npm test` (the full suite takes about 10 s; `build` first because of the AGENTS.md stale-dist trap). Steps 2 to 6 are verbatim moves plus import fixes. No logic changes; diff review should show only moved blocks.

**Step 0: sequencing.** `game.ts` is still edited often (28 of the last 53 commits touched it). Land any fix in flight that touches `game.ts` *before* step 2. Git's rename detection won't follow functions into new files, so a fix rebased across the split has to be re-applied by hand to the new module. Keep steps 2 to 6 short in calendar time, ideally one sitting, so no other `game.ts` edits land in between.

**Step 1: test helpers (no engine change).** Split `tests/helpers.ts` into:
- `tests/helpers/rng.ts`: `scriptedRng`, `seededRng` (no imports)
- `tests/helpers/battle.ts`: `createTestBattle`, `critState`, `critWeapon`, `overrideAmmoBin`, `checkVictory`, `VictoryResult`, `bearing`
- `tests/helpers/piloting.ts`: `sweepPiloting`, `groupsTotaling` (imports `physical` and `resolvePhasePiloting`)
- `tests/helpers/session.ts`: `disableCritical`, `currentActor`, `chunkText`, `execute` (the only one importing `web/`: `cli`, `renderer.text`, `session`, `chunk`)

Update the 30 importers with a small codemod. Don't leave `tests/helpers.ts` behind as a re-export barrel. Also convert inline `{ type X }` imports in `tests/` to `import type`.

**Step 1a: setup file (no engine change).** In `tests/setup.ts`, replace `import { loadCatalog } from "../src"` with `loadCatalog` from `../src/data/catalog` (already imported there for `appendCatalog` / `registerAllCatalog`). Measured: a `game.ts` edit goes from 37 to 32 selected files. Without this step none of the later steps change selection at all, because vitest 5 runs everything when a setup-file dependency changes. Edits to `src/data/catalog.ts` and its imports (`map/mech` codecs and schemas) will still select everything, which is correct.

**Step 2: `types.ts` + `constants.ts`.** Move all type declarations and the constants. `game.ts` re-exports them. Switch `critical`, `pilot`, `piloting`, `snapshot`, `score`, `tohit` to `import type … from "./game/types"`.

**Step 3: leaf modules.** `queries`, `condition`, `geometry`, `ledger`, `turnOrder`, `buildings`. Repoint `physical.ts` and `fireability.ts` to `queries` / `condition` / `geometry`, which removes the `game ↔ physical` cycle. In `turnOrder`, export the body of `processEndPhase` as `startNextTurn`. This is the one non-verbatim change: `advancePhaseGen`'s `"end"` case then calls `startNextTurn` (after `resolveAirSupply`), and `createTestBattle` calls `startNextTurn(state)` plus `state.actorQueue = null` instead of `advancePhase`. It does the same thing, but review it separately.

**Step 4: `clubs`, `consequences`, `pilotingPhase`.** Move the recursive cluster as one block. Repoint `salvage.ts` to `queries`, `clubs` and `constants`.

**Step 5: movement.** `create`, `posture`, `terrainPsr`, `melee`, `move`.

**Step 6: attack and end phases.** `declare`, `weaponState`, `missileDefense`, `weaponFire`, `resolveAttacks`, `heatPhase`, `pilotActions`, `loop`. `game.ts` is now re-exports only.

**Step 7: rewire importers.** A codemod maps each imported symbol to its defining module and rewrites the 31 test imports of `../src/rules/game`, plus the 15 tests importing `../src` / `../src/index`, where they aren't API tests. Point `src/index.ts` at the modules directly. Add the Biome restrictions from section 3. Delete `game.ts` or keep it banned.

**Step 8: docs.** Update `AGENTS.md` (the two "see / through `src/rules/game.ts`" rules become `src/rules/game/*`; the selection-quirk numbers, which still say `tohit.ts` → 52 files), the `rules/game.ts` mentions in `docs/API.md` (heat phase, `createBattle`, battle state machine, `GameEvent` union) and `docs/REPLAY.md`, and the `game.ts` reference in the `src/rules/arcs.ts` comment about `attackDirectionFor`.

**Step 9: make the selective run the default test action.** Add `scripts/test-default.mjs` and point `npm test` at it:

1. If the working tree has uncommitted changes (staged, unstaged or untracked, per `git status --porcelain`), run `vitest run --changed` (vitest's default `--changed` is exactly the uncommitted set).
2. Otherwise run `vitest run --changed HEAD~1`, which covers the files in the last commit. Vitest diffs `HEAD~1...HEAD` here. If there is no parent commit, fall back to the full suite.
3. If the selected set touches `src/`, run `npm run build` first so the session tests that load `dist/` aren't stale.
4. Print which mode was picked and the file count, so a vacuous "0 tests" run is visible. If a forced-rerun trigger (`package.json`, the vitest config) changed, vitest already runs everything.

The full suite moves to `npm run test:all`. `test:changed` / `test:related` stay as they are.

Document it in two places:
- **`AGENTS.md`**: under Commands, `npm test` now means "uncommitted changes, or the last commit if the tree is clean" and `npm run test:all` is the full suite. The done criteria become `npm run lint && npm run typecheck && npm test` while iterating on a change, and `npm run test:all` before pushing, or whenever `package.json`, the test setup or data packs change. The "Filtered runs" paragraph is updated to match.
- **Claude Code**: Claude Code reads `CLAUDE.md`, not `AGENTS.md`, and the repo still has no `CLAUDE.md`. Add a short `CLAUDE.md` that imports `@AGENTS.md` and states the default: "To test, run `npm test` (uncommitted changes, else the last commit). Run `npm run test:all` only when asked, before pushing, or after changing config, setup or catalog data." That makes it Claude's default in every session on this repo.

This step only pays off after steps 1 to 7. Before them, `npm test` would still pick 32 or 37 of 37 files for most fixes. With the full suite at ~10 s, this step is now optional: weigh it against the risk of a skipped test hiding a regression.

## 6. Expected benefit

**Needs re-modelling.** The first plan's static model (`tools/after.mjs`) predicted, on the old 86-file tree, that after steps 1 to 7 a `declare` fix would select 23 files instead of 61, `move`/`posture`/`terrainPsr` 15, `resolveAttacks` 27, `consequences` 35, `queries` 59, and that `score.ts` / `salvage.ts` edits would drop from 60 to 1. Since then the tests were merged into 37 area files, so each test file now covers more ground and is more likely to be selected; the ratios will be worse than the old numbers suggest. Re-run the model on the 37-file tree after step 1a, before committing to steps 2 to 7.

Floors that remain regardless, and why:

- **`queries`, `create`/`turnOrder`:** nearly every test builds a battle and calls `requireUnit`. These modules are small and stable, so edits there should be rare.
- **Integration tests:** many tests drive `advancePhase` / `resolveAllAttacks` and legitimately depend on every phase. They are always selected for any engine edit, which is correct. After consolidation, `game.test.ts` (1674 lines) and similar area files mix unit and integration cases, which raises this floor; splitting them is out of scope here.
- **`tohit` / `piloting` / `critical`:** `createBattle` imports skill defaults (`DEFAULT_GUNNERY`, `DEFAULT_PILOTING`, `isValidPilotHitMax`) from them. Moving those defaults into `pilot.ts` or `game/constants.ts` later would cut these further. That's a follow-up, not part of this plan.
- **Session/web tests** reach the engine through `"btlib10x"` → `dist/`, which vitest's graph treats as `dist/index.js`. 18 of the 37 test files import `btlib10x` or `web/terminal`. After steps 1, 1a and 7, the ones that only use `dist` stop being selected by `src/` edits. Before, they were selected but still ran against stale `dist` unless you built first (the AGENTS.md "stale-dist trap"). For engine changes that affect sessions, run `npm run build` and then the full suite. A possible follow-up is a vitest `resolve.alias` from `btlib10x` to `src/index.ts`: that makes web tests always run against `src`, but they'd then be selected for every engine edit.

## 6a. Slow session tests

Full-suite timings at `aa4d6080` (`--reporter=json`, 1554 tests, ~10 s wall): `players` 8.8 s, `replay` 3.3 s, `policy` 2.1 s, `session` 1.4 s. Everything else is under 0.5 s per file. The old `persona` (41 s), `rollback` and `autoplay` files are gone; their surviving cases are in these four.

These tests drive `web/terminal/*`, which imports the engine as `"btlib10x"`, i.e. **`dist/`**, not `src/`. Today they get selected for every `src/` edit through `tests/setup.ts` and `tests/helpers.ts` → `src/index`, even though they then run against whatever `dist/` was last built.

Remaining leaks, fixed in step 7: `players.test.ts` imports `../src/index` (barrel) and `../src/data/index`, and `currentActor` in `helpers/session.ts` should take `requireUnit` from `"btlib10x"` rather than `src`, so the session helper has no `src/` edge at all. `replay.test.ts` imports `buildUnitInit` and decl types from `../src/rules/game` (so `game/create` edits will select it) and a few leaf `src` modules; point those at the specific modules.

Consequence: once the leaks are fixed, a `src/` engine fix no longer runs `players` / `replay` during iteration. They only exercise the engine after `npm run build`. For an engine change that can affect sessions or bot behaviour, run `npm run build && npx vitest related dist/index.js --run` (selects every session test) or the full suite before calling it done, as AGENTS.md already requires.

## 7. Optional phase 2 (not pure moves, decide later)

- `resolveAllAttacks` is now 809 lines and sits behind most attack fixes. Splitting it into weapon resolution, physical resolution and damage application would cut attack-fix selection further, but that is a real refactor with behaviour risk. (Some per-weapon work has already moved out into the helpers that become `weaponState` / `weaponFire`.)
- Move pilot-skill defaults out of `tohit`/`piloting` (see floors above).
- Split `types.ts` by domain if ~1115 lines of declarations is a problem.

## 8. Outcome (measured after step 9)

All steps landed as planned, with these deviations:

- `unitPolicyOf` / `setUnitPolicy` went to `turnOrder` (not `queries`): `setUnitPolicy` calls `requireCurrentActor`.
- `game.ts` was deleted rather than kept as a banned facade. `src/index.ts` re-exports straight from `./rules/game/<module>`.
- `tests/helpers/session.ts` takes `requireUnit` / `UnitState` from `"btlib10x"`, so it has no `src/` edge.
- `npm test` falls back to the full suite when catalog data (`data/`, `docs/mtf/sw/json/`) changed, because the import graph cannot see those files.

Checks: build, lint, typecheck and all 1554 tests pass; the rolled-up `web/btlib10x.d.ts` matches `main` line for line (sorted, blank lines aside) and the runtime export list is identical. The only runtime import cycle under `src/` is the pre-existing `piloting ↔ critical`.

Module sizes (lines): `types` 1112, `resolveAttacks` 891, `consequences` 868, `move` 615, `declare` 602, `heatPhase` 484, `clubs` 388, `terrainPsr` 301, `turnOrder` 229, `geometry` 222, `posture` 214, `create` 206, `pilotingPhase` 166, `weaponState` 159, `missileDefense` 152, `pilotActions` 147, `weaponFire` 145, `queries` 121, `constants` 111, `ledger` 105, `loop` 105, `buildings` 62, `melee` 62, `condition` 48.

Test files selected per edited file (of 37), `tmp/related.mjs`:

| Edited | Before (`aa4d6080`) | After |
|---|---|---|
| `game/types` | 37 | 0 (type-only; typecheck covers it) |
| `game/pilotActions` | 37 | 4 |
| `game/move`, `posture`, `terrainPsr`, `melee` | 37 | 12 |
| `game/heatPhase`, `loop` | 37 | 15 |
| `game/declare` | 37 | 17 |
| `game/resolveAttacks`, `weaponFire`, `weaponState`, `missileDefense` | 37 | 19 |
| `game/consequences`, `clubs`, `ledger`, `pilotingPhase` | 37 | 22 |
| `game/buildings` | 37 | 23 |
| `game/condition`, `geometry` | 37 | 25 |
| `game/turnOrder` | 37 | 28 |
| `game/create` | 37 | 29 |
| `game/queries`, `constants` | 37 | 30 |
| `rules/score.ts`, `salvage.ts` | 37 | 1 |
| `rules/fireability.ts` | 37 | 9 |
| `rules/snapshot.ts` | 37 | 20 |
| `rules/physical.ts` | 37 | 23 |
| `rules/heat.ts` | 37 | 26 |
| `rules/tohit`, `critical`, `piloting`, `ams`, `core/hex` | 37 | 30 |
| `src/data/catalog.ts` (setup file) | 37 | 37 |

## Tools

The original measurement scripts (`game-split/tools/related.mjs`, `model.mjs`, `after.mjs`) are no longer in the project files, and `related.mjs` used the vitest 2 API. Section 1 was re-measured with a small vitest 5 script kept in `tmp/related.mjs` (gitignored):

- It calls `createVitest("test", { watch: false, run: true })`, sets `vitest.config.related` to the given files, and counts `vitest.specifications.filterTestsBySource(await vitest.specifications.globTestSpecifications())`. Usage: `node tmp/related.mjs src/rules/heat.ts a.ts+b.ts …`; `V=1` lists the selected files; `CFG=<config>` measures against an alternate vitest config (used with a copy of `tests/setup.ts` to measure step 1a without editing the repo).
- `model.mjs` (symbol-to-module assignment and cycle check) and `after.mjs` (static before/after model) need to be rewritten before step 2 and section 6 respectively.
