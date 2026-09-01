# btlib10x TODO

## Goal

- **Library** — zero-dependency TypeScript library implementing a **subset of
  classic BattleTech game rules** (bipedal 'Mechs only). See `docs/API.md`.
- **Web CLI** — single-page terminal-emulator app exposing the core; vanilla
  TypeScript + DOM only, zero runtime dependencies. See `docs/CLI.md`.

## To Do

- Fix `armorLineShort` to surface full health at a glance: per location, sum
  the front pool, the rear pool (torsos only), and the internal-structure pool
  into a single `cur/max`, and append `*` when the front pool is depleted
  (structure intact) and `!` when internal structure is depleted. Keep the
  existing `sheet.armorLine` i18n key (`"armor: {list}"` / `"장갑: {list}"`)
  unchanged; layout is implementation detail.
- Implement ammo depletion order and ammo explosions
- Add a terrain type table

## In progress

- Later in classic expansion: heat (will pick up the `heatSinksDestroyed` count
  already tracked by crit state), physicals, piloting/falling, side+rear firing
  arcs, vehicles/infantry, buildings, basements, water depth, hull-down

## Done

- **Classic rules expansion** — internal structure (derived from tonnage, TW
  standard table), front/rear armor pools + layered damage model, front / side /
  rear arc classification (`arcs.ts`) and hit-location tables
  (`LEFT_SIDE_TABLE`/`RIGHT_SIDE_TABLE`, `hitLocationForArc`), firing still
  front-arc-only this milestone. Elevation: per-hex `level`, climb MP cost,
  jump ignores elevation, LOS height ray, height-difference to-hit mod, renderer
  + i18n. Web armor diagram shows I/F/R; public API exports updated.
- **Critical hit table** — TW determining table (2D6 12 = blow-off) + 1D6/2D6
  slot rolls with reroll/transfer/excess-lost; `CritSlot` schema + validator,
  `critSlots` on the 8 mech JSONs (MTF + backfill scripts, linkage precheck);
  `src/rules/critical.ts` effects: weapon destroyed, ammo explosion (cascading),
  blow-off, cockpit kill, leg actuator/hip/jump-jet movement penalties. Wired
  through `attack.ts`/`game.ts`; web i18n + `weapons` destroyed markers;
  `docs/CLI.md` + `docs/TABLES.md` updated.
- Rear torso armor added to the JSON schema + `MechDef` front/rear split,
  carried separately through the layered damage model (`ResolvedMechDef`,
  `resolveMechDef`); 8 mech JSONs carry front + `centerTorsoRear` /
  `leftTorsoRear` / `rightTorsoRear`.
- Scaffold project (npm, TypeScript strict ESM, Vitest; zero runtime deps)
- Extract rules from the source rulebooks (the implemented subset derives from the CBT and Beginner Box rulebooks)
- Scope decisions: bipedal only; heat, physical attacks, piloting rolls, and elevation are outside the current subset (deferred)
- Core domain types: odd-q offset flat-top hexes w/ cube math (`src/core/hex.ts`), dice w/ injectable RNG, terrain, locations
- Weapon catalog incl. P/V/C/R/AI effect codes (`src/data/weapons.ts`)
- `MechDef` JSON schema + hand-rolled validator (`src/data/schema.ts`)
- Movement rules: MP costs, facing changes, backward ban while running, jumping, stacking
- LOS: intervening hexes, woods points >= 3 blocking, endpoints excluded
- GATOR to-hit w/ range brackets, movement tables, terrain mods, pulse -2, auto-hit <=2 / auto-miss >12
- Hit location table (bipedal), Cluster Hits Tables (missiles 2/5/6/10/15 + shot columns 2/3/4), LRM lots-of-5 grouping
- Damage: flat armor HP/location, transfer-inward-on-depletion, hits on dead locations transfer, side-torso loss blows off arm, leg loss immobilizes, head/CT loss kills
- Single-weapon attack orchestrator: to-hit roll, jam on natural 2 for multi-shot rapid fire, variable damage per bracket
- Battle state machine (`src/rules/game.ts`): phases, alternating activation via `nextActor`, move execution, attack declaration/resolution, end-phase kill commitment, victory check, serializable event log
- Public entrypoint `src/index.ts` exports `VERSION` (build stamp `YYMMDD-<git hash>`,
  injected into the web bundles via esbuild `define`; npm/tsc build falls back to `"dev"`);
  CLI gains a `ver` command
- Single-file HTML deploy (`npm run dist:standalone` → self-contained `dist/standalone/bt10x.html`)
- Fix the misleading 'ammo' concept

## Verify later

- LOS edge-graze defender tie-break (v1 uses deterministic cube rounding)
- Elevation "thrown from height" / falling damage rules (v1 implements LOS + movement + to-hit only)

## Later phases

- separate web cli framework to be used at another project
- Dev-only sarna.net scraper starting at https://www.sarna.net/wiki/BattleMech normalizing into MechDef JSON (Node OK here; library stays browser-first)
- Full intro-rules expansion: heat, physicals, piloting/falling, rear hits, multi-target arcs, vehicles/infantry, buildings, basements, water depth, hull-down
