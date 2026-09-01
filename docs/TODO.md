# btlib10x TODO

## In progress

- Classic rules expansion (this phase): internal structure, rear armor, firing-arc damage, elevation
  - [x] Decisions: IS derived from tonnage (TW standard table); rear armor is a separate pool (fat split); full front/leftSide/rightSide/rear hit-location tables; refactor core rather than additive mode; side torso hits use front armor pool; firing stays front-arc-only this milestone
  - [x] Internal structure derivation helper + tests (`src/rules/internalStructure.ts`, TW standard table: 20–100 in 5t rows, head=3)
  - [x] `resolveMechDef`/`ResolvedMechDef` carry front + rear separately (stop summing): `armor` (front), `armorRear` (3 torso), `internalStructure` (derived)
  - [x] Layered damage model (`damage.ts`): front/rear armor + internal structure, arc-aware transfer; side-torso IS death blows off arm; head/CT IS death kills; leg IS death immobilizes; transfer graph preserved through the IS layer
  - [x] Arc classification (`arcs.ts`): front / leftSide / rightSide / rear (`classifyArc`). Firing still front-arc-only (dormant infra)
  - [x] Arc hit-location tables (`hitlocation.ts`): `LEFT_SIDE_TABLE`/`RIGHT_SIDE_TABLE` + `hitLocationForArc`
  - [x] Wire arc + layered damage through `attack.ts` / `game.ts`/`fireability.ts` (`UnitDamageState` on `UnitState`)
  - [x] Web layer: armor diagram + mech info show internal structure (I) / front (F/A) / rear (R)
  - [x] Public API exports (incl. `Arc`, `UnitDamageState`, `hitLocationForArc`, side tables, `internalStructureForTonnage`)
  - [x] Update downstream tests; lint + typecheck + test + build green (155 tests / 17 files)
  - [x] Elevation: per-hex `level` on `TerrainHexDef` / `Hex` (default 0); map JSON validator accepts optional non-negative integer `level`; `BattleState.elevation` populated by `createBattle`; `costToClimb`/`levelAt` helpers
  - [x] Movement: `reachableLandings` charges +1 MP per level climbed, max +1 per step, jump ignores elevation
  - [x] LOS: `losBlockedByElevation` + `losClear` (real-valued ray from attacker LOS level to target LOS level; intervening hex blocks iff its LOS level exceeds the ray); wired into `declareAttacks`/`suggestFireTargets`
  - [x] To-hit: `attackerLevel`/`targetLevel` on `AttackModifiers`; `heightDiff`/`heightMod` in `ToHitBreakdown`; plumbed through `WeaponAttackInput`/`resolveWeaponAttack`
  - [x] Renderer: `BoardModel.elevations`; per-hex level replaces the old `ELEVATION_DIGIT` constant; `info map` reports elevation counts
  - [x] Web i18n: `err.climbTooSteep`, `info.elevationLine` in `en.ts` + `kr.ts`
  - [x] Tests: `tests/elevation.test.ts` worked ridge-duel example; additions to `tests/hex.test.ts`, `tests/los.test.ts`, `tests/reach.test.ts`, `tests/tohit.test.ts`, `tests/mapdata.test.ts` (191 tests / 20 files)
- Critical hit table (this milestone; classic subset)
  - [x] Decide scope: TW determining table (2-7 none / 8-9 one / 10-11 two / 12 blow-off or 3 on torso) + 1D6 (head/legs) / 2D6 half+slot (torso/arms) slot roll + reroll on empty/soak/destroyed + inward transfer (no head/CT) + excess-lost rules; DHS run-grouping so a single crit destroys the whole DHS and sibling slots only soak
  - [x] Schema: `CritSlot` discriminated union (weapon / ammo / structure / soak / null) per location; `MechDef.critSlots` required, exact per-location length (6 for head/legs, 12 for torso/arms); validator enforces known component names and (location, weapon) count-consistency against the weapons array
  - [x] `resolveMechDef` derives `weaponIndex` on each crit slot by matching `(location, weapon)` occurrence order against the weapons array; multi-slot weapons (e.g. AC/20) link every slot to the same single mount; ammo bins link to the single ammo-bearing mount anywhere on the 'Mech
  - [x] MTF converter (`scripts/mtf.mjs`) emits `critSlots` for new conversions (factored through `scripts/mtf-crit.mjs`); component mapping covers weapons, ammo tokens, structure (cockpit/sensors/lifeSupport/engine/gyro/heatSink/doubleHeatSink/jumpJet), actuators (shoulder/upperArm/lowerArm/hand/hip/upperLeg/lowerLeg/foot), and soak (endoSteel/CASE/ferro)
  - [x] `scripts/backfill-crits.mjs` merges `critSlots` from each MTF into the 8 existing JSONs leaving every other field byte-identical; linkage precheck (slots must reference a mount in the same location, ammo must reference an ammo-bearing mount anywhere) so the Mad Cat and the source-mismatched Cicada are surfaced for manual handling — the Cicada is hand-transcribed from the Beginner Box record sheet
  - [x] `src/rules/critical.ts` — pure `resolveCriticalHits` orchestrator (determining roll per (group, location that took IS damage); re-roll + transfer; per-component effects; ammo explosion cascades a fresh determining roll, depth-guarded)
  - [x] Effects: weapon destroyed (slot hit disables whole mount; multi-slot weapons: first hit destroys, extras soak); ammo explosion (per-shot damage × remaining shots, applied to that location's IS, cascade crits); 12→arm/leg blown off / head destroyed (kill); cockpit slot → kill; leg actuators (upper/lower/foot) −1 walk each; hip → walking halved (round up; ignore other leg penalties on that leg); jump jets −1 jump each
  - [x] `UnitState` adds `critSlotsDestroyed: Record<Location, boolean[]>` and `destroyedWeapons: number[]`; created from def in `createBattle`; initialized from def crit layout
  - [x] `declareAttacks` rejects destroyed weapons (mirror jammed-weapon check); `executeMove` uses effective walking/running/jumping derived from crit state (leg actuator/hip/jump-jet destruction); web session's `budgetFor`/`maxMovePoints` call sites switched to the effective ratings
  - [x] Game: `resolveWeaponAttack` runs crit resolution per (group, location) and folds ammo-explosion damage/applications into the returned damage; `resolveUnitAttacks` commits crit state; crits travel inside the `attackResolved` `GameEvent`'s `resolution.crits` (no separate `critsResolved` event — it duplicated the log); kill sweep already covers head/CT
  - [x] Engine stays English; web i18n `en` + `kr` get new keys (determining roll, slot hit, weapon destroyed, ammo exploded, blow-off, transfer); `format.ts` appends a crit block after the transfer detail; `weapons` command marks destroyed mounts
  - [x] Tests: `tests/critical.test.ts` covers table boundaries, 1D6/2D6 slot rolls, re-roll, transfer + excess-lost, HBK worked examples, AC/20 ammo explosion value, blow-offs, cockpit kill, actuator/hip MP reductions, explosion cascade; updates to `tests/data.test.ts`, `tests/attack.test.ts`, `tests/game.test.ts`, `tests/exampleGame.test.ts`, `tests/i18n.test.ts`, `tests/webcli.test.ts`
  - [x] Docs: `docs/CLI.md` rule coverage moves critical hits to Implemented (note engine/gyro/sensors/heat-sink destroyed → no heat/piloting effect in subset); `docs/TABLES.md` gets a Critical Hits section
  - [x] Final verification: `npm run lint && npm run typecheck && npm test` green (221 tests across 21 files), plus `npm run build:web` bundle smoke
- Later in classic expansion: heat (will pick up the `heatSinksDestroyed` count already tracked by crit state), physicals, piloting/falling, side+rear firing arcs, vehicles/infantry, buildings, basements, water depth, hull-down

## Done

- [x] Rear torso armor added to JSON schema + `MechDef` front/rear split, carried separately through the layered damage model (`ResolvedMechDef`, `resolveMechDef`); 8 mech JSONs carry front + `centerTorsoRear`/`leftTorsoRear`/`rightTorsoRear`

## Done

- [x] Scaffold project (npm, TypeScript strict ESM, Vitest; zero runtime deps)
- [x] Extract rules from the source rulebooks (the implemented subset derives from the CBT and Beginner Box rulebooks)
- [x] Scope decisions: bipedal only; heat, physical attacks, piloting rolls, and elevation are outside the current subset (deferred)
- [x] Core domain types: odd-q offset flat-top hexes w/ cube math (`src/core/hex.ts`), dice w/ injectable RNG, terrain, locations
- [x] Weapon catalog incl. P/V/C/R/AI effect codes (`src/data/weapons.ts`)
- [x] `MechDef` JSON schema + hand-rolled validator (`src/data/schema.ts`)
- [x] Six record-sheet 'Mechs encoded: ENF-4R, HBK-4G, CDA-3MA, HER-5SA, GRF-1N, WVR-6R
- [x] Movement rules: MP costs, facing changes, backward ban while running, jumping, stacking
- [x] LOS: intervening hexes, woods points >= 3 blocking, endpoints excluded
- [x] GATOR to-hit w/ range brackets, movement tables, terrain mods, pulse -2, auto-hit <=2 / auto-miss >12
- [x] Hit location table (bipedal), Cluster Hits Tables (missiles 2/5/6/10/15 + shot columns 2/3/4), LRM lots-of-5 grouping
- [x] Damage: flat armor HP/location, transfer-inward-on-depletion, hits on dead locations transfer, side-torso loss blows off arm, leg loss immobilizes, head/CT loss kills
- [x] Single-weapon attack orchestrator: to-hit roll, jam on natural 2 for multi-shot rapid fire, variable damage per bracket
- [x] Battle state machine (`src/rules/game.ts`): phases, alternating activation via `nextActor`, move execution, attack declaration/resolution, end-phase kill commitment, victory check, serializable event log
- [x] Public entrypoint `src/index.ts`
- [x] Test suites: 135 tests across 16 files, including worked examples (Rolling To-Hit TN 9/TN 8, Target Movement trio, Hunchback damage transfer, Wolverine damage transfer) and a full scripted Wolverine-vs-Griffin battle to victory on turn 6
- [x] `npm run typecheck && npm test` green; `npm run build` emits ESM + declarations with mechs JSON copied to `dist/`
- [x] docs/API.md (reference)
- [x] docs/USAGE.md (usage guide walking one battle turn through the engine)

## Verify later

- [ ] GRF-1N / WVR-6R armor circle counts (encoded from TRO 3025 allocation; the Beginner Box rulebook prints circles only, no numbers)
- [ ] LOS edge-graze defender tie-break (v1 uses deterministic cube rounding)
- [ ] Elevation "thrown from height" / falling damage rules (v1 implements LOS + movement + to-hit only)

## Later phases

- [ ] Dev-only sarna.net scraper starting at https://www.sarna.net/wiki/BattleMech normalizing into MechDef JSON (Node OK here; library stays browser-first)
- [ ] Full intro-rules expansion: heat, physicals, piloting/falling, rear hits, multi-target arcs, vehicles/infantry, buildings, basements, water depth, hull-down
