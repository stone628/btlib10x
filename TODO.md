# btlib10x TODO

## In progress

- Classic rules expansion (this phase): internal structure, rear armor, firing-arc damage
  - [x] Decisions: IS derived from tonnage (TW standard table); rear armor is a separate pool (fat split); full front/leftSide/rightSide/rear hit-location tables; refactor core rather than additive mode; side torso hits use front armor pool; firing stays front-arc-only this milestone
  - [x] Internal structure derivation helper + tests (`src/rules/internalStructure.ts`, TW standard table: 20–100 in 5t rows, head=3)
  - [x] `resolveMechDef`/`ResolvedMechDef` carry front + rear separately (stop summing): `armor` (front), `armorRear` (3 torso), `internalStructure` (derived)
  - [x] Layered damage model (`damage.ts`): front/rear armor + internal structure, arc-aware transfer; side-torso IS death blows off arm; head/CT IS death kills; leg IS death immobilizes; quick-start transfer graph preserved through the IS layer
  - [x] Arc classification (`arcs.ts`): front / leftSide / rightSide / rear (`classifyArc`). Firing still front-arc-only (dormant infra)
  - [x] Arc hit-location tables (`hitlocation.ts`): `LEFT_SIDE_TABLE`/`RIGHT_SIDE_TABLE` + `hitLocationForArc`
  - [x] Wire arc + layered damage through `attack.ts` / `game.ts`/`fireability.ts` (`UnitDamageState` on `UnitState`)
  - [x] Web layer: armor diagram + mech info show internal structure (I) / front (F/A) / rear (R)
  - [x] Public API exports (incl. `Arc`, `UnitDamageState`, `hitLocationForArc`, side tables, `internalStructureForTonnage`)
  - [x] Update downstream tests; lint + typecheck + test + build green (155 tests / 17 files)
- Later in classic expansion: heat, physicals, piloting/falling, elevation, torso twist / side+rear firing arcs, vehicles/infantry

## Done

- [x] Rear torso armor added to JSON schema + `MechDef` front/rear split, summed into flat armor for the quick-start engine (`ResolvedMechDef`, `resolveMechDef`); 8 mech JSONs carry front + `centerTorsoRear`/`leftTorsoRear`/`rightTorsoRear`

## Done

- [x] Scaffold project (npm, TypeScript strict ESM, Vitest; zero runtime deps)
- [x] Extract rules from both quick-start PDFs (macOS PDFKit text layer)
- [x] Scope decisions: bipedal only; no heat / physical attacks / piloting rolls / elevation in quick-start booklets -> deferred
- [x] Core domain types: odd-q offset flat-top hexes w/ cube math (`src/core/hex.ts`), dice w/ injectable RNG, terrain, locations
- [x] Weapon catalog incl. P/V/C/R/AI effect codes (`src/data/weapons.ts`)
- [x] `MechDef` JSON schema + hand-rolled validator (`src/data/schema.ts`)
- [x] Six record-sheet 'Mechs encoded: ENF-4R, HBK-4G, CDA-3MA, HER-5SA, GRF-1N, WVR-6R
- [x] Movement rules: MP costs, facing changes, backward ban while running, jumping (Beginner Box), stacking
- [x] LOS: intervening hexes, woods points >= 3 blocking, endpoints excluded
- [x] GATOR to-hit w/ range brackets, movement tables, terrain mods, pulse -2, auto-hit <=2 / auto-miss >12
- [x] Hit location table (bipedal), Cluster Hits Tables (missiles 2/5/6/10/15 + shot columns 2/3/4), LRM lots-of-5 grouping
- [x] Damage: flat armor HP/location, transfer-inward-on-depletion, hits on dead locations transfer, side-torso loss blows off arm, leg loss immobilizes, head/CT loss kills
- [x] Single-weapon attack orchestrator: to-hit roll, jam on natural 2 for multi-shot rapid fire, variable damage per bracket
- [x] Battle state machine (`src/rules/game.ts`): phases, alternating activation via `nextActor`, move execution, attack declaration/resolution, end-phase kill commitment, victory check, serializable event log
- [x] Public entrypoint `src/index.ts`
- [x] Test suites: 135 tests across 16 files, including rulebook worked examples (Rolling To-Hit p6 TN 9/TN 8, Target Movement p16 trio, Hunchback damage transfer p17, Wolverine damage transfer BB p8) and a full scripted Wolverine-vs-Griffin battle to victory on turn 6
- [x] `npm run typecheck && npm test` green; `npm run build` emits ESM + declarations with mechs JSON copied to `dist/`
- [x] docs/API.md (reference)
- [x] docs/USAGE.md (usage guide walking one battle turn through the engine)

## Verify later

- [ ] GRF-1N / WVR-6R armor circle counts (encoded from TRO 3025 allocation; Beginner Box prints circles only, no numbers in text layer)
- [ ] Locust LCT-1V / Griffin GRF-1S presence in CBT-Quick-Start-Rules.pdf (text found on p5 layer, possibly bundled-booklet artifact); encode if confirmed
- [ ] LOS edge-graze defender tie-break (v1 uses deterministic cube rounding)

## Later phases

- [ ] Dev-only sarna.net scraper starting at https://www.sarna.net/wiki/BattleMech normalizing into MechDef JSON (Node OK here; library stays browser-first)
- [ ] Full intro-rules expansion: heat, physicals, piloting/falling, elevation, rear hits, multi-target arcs, vehicles/infantry
