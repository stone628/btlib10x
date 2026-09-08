# btlib10x TODO

## Goal

- **Library** — zero-dependency TypeScript library implementing a **subset of
  BattleTech Total Warfare rules** (bipedal 'Mechs only). See `docs/API.md`.
- **Web CLI** — single-page terminal-emulator app exposing the core; vanilla
  TypeScript + DOM only, zero runtime dependencies. See `docs/CLI.md`.

## To Do

- show ammo explosion check avoid (success)
- enforce minimum range rule for weapons
- warn min range, reject out of range on 'fire' command immediately
- change movement phase command to set final hex and facing.
- implement minimum range rule.
- implement attack direction rule.

## In progress

- Later in classic expansion: physicals, piloting/falling, basements,
  hull-down, water depth movement-cost change, pavement skid (vehicle-specific)
- **Piloting / consciousness roll on immobile end-of-turn** — TW end-of-turn
  consciousness roll for an immobile 'Mech (both legs destroyed via
  `isUnitImmobile`): on a failed roll the unit is destroyed; on a success it is
  removed as a casualty at end of turn and counted as a loss for victory.
  Wires into `checkVictory` via a new end-of-turn phase hook in
  `src/rules/game.ts`; consumes the injected `Rng` for the 2d6 roll.
  Coverage gap: a 'Mech with both legs destroyed today stays "alive" in
  the `units` map and only loses once its head/CT is also destroyed.

## Done

- **CASE / CASE II ammo-explosion containment** — ammo explosions in
  CASE-protected locations no longer overflow to the center torso. CASE
  (explicit `case` crit slot, or implicit on Clan side torsos) vents the
  overflow as one point of internal-structure damage to the protected location
  (crit-roll eligible) and stops transfer; CASE II (`caseII` slot) additionally
  caps the blast at 1 point total. Detection via `hasCase`/`hasCaseII` in
  `src/rules/critical.ts`; wired through `applyAmmoExplosion` for both the crit
  slot path (`applySlotHit`) and the heat-phase path (`resolveHeatPhase`).
  `applyDamage` gained an optional `caseProtection` arg to stop transfer at the
  protected location. `caseII` added to `CRIT_SOAK_NAMES` + i18n en/kr.
- **Partial cover (TW)** — a target standing in a water1 or building hex is in
  partial cover when the attacker's ground level is not higher than the
  target's: +1 to-hit (folded into `terrainMod` via new `targetPartialCover?`
  on `AttackModifiers`), and a standard hit-location roll that lands on a leg
  strikes the cover instead (no damage to the target). Derived from
  `hasPartialCover(targetTerrain) && attackerLevel <= targetLevel` in
  `declareAttacks`, `resolveWeaponAttack`, and `suggestFireTargets`. `water1`
  `terrainMod` changed −1 → 0 (TW: depth-1 water grants cover, not an easy-hit
  bonus). Cover-hit building-CF damage deferred.
- **Immobile/shutdown target modifier** — `targetMovementModifier` gains an
  `immobile` flag: a target that cannot move (shut down, or both legs
  destroyed) applies the −4 immobile target-number modifier instead of the
  hex-band movement table. Plumbed through `computeToHit`/`resolveWeaponAttack`
  (`targetImmobile?`) and wired in `declareAttacks`, `resolveUnitAttacks`, and
  `suggestFireTargets` from `isImmobile(unit)`,
  so fire-suggestion TNs and `autoMiss` reflect shutdown targets.
- **Core-rulebook terrain expansion** — terrain catalog extracted to
  `src/data/terrain.json` (13 types), data-driven via `terrain.schema.ts`;
  `TerrainType` widened to include rough, rubble, pavement, water1/2/3, and
  light/medium/heavy/hardened buildings. `terrainMoveCost`/`screeningPoints`
  (formerly `woodsPoints`) / `terrainTargetMod` / `hasPartialCover` /
  `blocksTargeting` read the catalog instead of inline switches. Water depth 2+
  blocks LOS in/out (`losBlockedByWater`); water1 grants partial cover (+1,
  TW) rather than a standalone target modifier.
  Building structural-factor damage + collapse-to-rubble wired into
  `BattleState.buildings` and weapon resolution (`damageBuildingAt`); renderer
  glyphs (`w W r R = ∼ ≈ ≋ b B # H`) + CSS. Partial cover resolution landed
  with the to-hit milestone.
- **Classic rules expansion** — internal structure (derived from tonnage, TW
  standard table), front/rear armor pools + layered damage model, front / side /
  rear arc classification (`arcs.ts`) and hit-location tables
  (`LEFT_SIDE_TABLE`/`RIGHT_SIDE_TABLE`, `hitLocationForArc`), firing still
  front-arc-only this milestone. Elevation: per-hex `level`, climb MP cost,
  jump ignores elevation, LOS height ray, height-difference to-hit mod, renderer
  + i18n. Web armor diagram shows I/F/R; public API exports updated.
- **Per-bin ammo depletion** — ammo tracked per crit slot (`ammo.ts`):
  bins load from the ammo table's per-bin capacity, or declared `shots`
  pool across all mounts/bins of a weapon name (remainder one per bin);
  a per-unit policy (`ammo <policy>`: `exposed` default, `core`,
  `spread`, `leastFirst`) orders which bin takes the next shot, ties
  broken at random through the injected RNG. Crit hits now detonate only
  the struck bin (remaining shots × damage-per-shot straight to IS with a
  cascade on depletion), bins in blown/destroyed locations are stripped,
  and empty bins soak. `shotsLeft` is a derived per-weapon sum. Wired
  through `game.ts`/`attack.ts`/`critical.ts`; web CLI `ammo` command,
  record-sheet policy line, and per-bin `(n left)` markers; i18n en+kr.
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
- **Checked "lose both legs = lose the game"** — current rule subset treats
  losing both legs as immobility only (`isImmobile` in `src/rules/damage.ts`),
  not as a kill; victory (`checkVictory` in `src/rules/game.ts`) only fires on
  head/CT destruction or `removed` flag. Real TW consciousness-roll removal
  on immobile end-of-turn is deferred to the piloting/falling milestone above.

## Verify later

- LOS edge-graze defender tie-break (v1 uses deterministic cube rounding)
- Elevation "thrown from height" / falling damage rules (v1 implements LOS + movement + to-hit only)

## Later phases

- separate web cli framework to be used at another project
- Dev-only sarna.net scraper starting at https://www.sarna.net/wiki/BattleMech normalizing into MechDef JSON (Node OK here; library stays browser-first)
- Full intro-rules expansion: heat, physicals, piloting/falling (incl. partial
  cover), rear hits, multi-target arcs, vehicles/infantry, basements,
  hull-down, full water-depth movement, buildings damage beyond CF collapse
