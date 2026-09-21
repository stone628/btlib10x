# btlib10x TODO

## Goal

- **Library** — zero-dependency TypeScript library implementing a **subset of
  BattleTech Total Warfare rules** (bipedal 'Mechs only). See `docs/API.md`.
- **Web CLI** — single-page terminal-emulator app exposing the core; vanilla
  TypeScript + DOM only, zero runtime dependencies. See `docs/CLI.md`.

## To Do

- need snapshot keeping, capable of rollback N steps like ctrl-z
- The Physical Attack Phase. advancePhase runs initiative → movement → weaponAttack → end, with the heat phase folded into the weaponAttack exit. TW inserts a physical attack phase between weapon fire and heat, carrying punch, kick, push, club, charge and Death From Above. None exists. This also strands the handActuator and shoulder crit slots, whose published effects are largely physical. (Physical-triggered PSRs — kicks, pushes, charges, DFAs — wait on this phase; see "Not viable" in `docs/CLI.md`.)

## In progress

- Later in classic expansion: physicals, basements,
  hull-down, water depth movement-cost change, pavement skid (vehicle-specific;
  skid displacement is not viable without a displacement mechanic — see
  `docs/CLI.md`)

## Done

- **Shutdown +3 PSR, run/jump damaged PSRs, building-crash auto-falls** —
  reactor shutdown (heat or voluntary) forces an immediate +3 PSR
  (`shutdownFallCheck`; only *other* PSRs while down fail automatically);
  running with damaged hip/gyro or jumping with damaged actuators forces
  an end-of-move PSR at preexisting modifiers; a building crash that
  wrecks a leg/gyro or KOs the pilot drops the 'Mech on the spot (move
  also stops on unconsciousness). Pilot wounds stay consciousness-only
  per TW RAW — never a to-hit/PSR modifier.
- **Piloting Skill Rolls, falling, prone, and the pilot** — `UnitInit`
  takes an optional piloting skill (default 5); `UnitState` tracks pilot
  hits, unconsciousness, and prone. End-of-phase PSRs (20+ damage,
  leg/foot actuators, hips, first gyro hit; automatic falls for destroyed
  gyros/legs and shut-down/unconscious units), Facing After Fall damage
  with crits, seatbelt pilot checks, stand-up/drop/prone-turn movement
   actions, prone combat modifiers (+2 attack / −2 adjacent-target or +1
   distant-target / propping arm),
   sensor-crit effects (+2 to-hit on first hit, blind on second), water/rubble/building entry PSRs, pilot
  damage (head hits, ammo explosions, falls, heat-soaked life support),
  consciousness rolls with knockout/wake, immobile targeting for the
  unconscious. Covered by `tests/piloting.test.ts`. Remaining gaps are the
  physical-phase triggers and the displacement-bound rules listed under
  "Not viable" in `docs/CLI.md`.
- **Target movement modifier (TW)** — `targetHexesMoved` now feeds total hexes
  entered this turn (`movesThisTurn.length`) from all three call sites
  (`declareAttacks`, `resolveUnitAttacks`, `suggestFireTargets`); TW counts total
  hexes moved, not the trailing run since the last direction reversal.
  `hexesSinceLastReversal` deleted.
- **Streak missiles (TW)** — `streak` flag on `WeaponDef` (CL Streak SRM
  2/4/6, IS Streak SRM 2/4/6). `resolveWeaponAttack` skips Cluster Hits
  Table on streak hits (full tube count, one location roll per missile,
  `clusterRoll` null, no cluster RNG drawn).   `declareAttacks` defers ammo
  draw to resolution; `resolveUnitAttacks` spends one shot and applies heat
  only on hit — miss means launcher never fired. Shared name pool with a
  pre-resolution guard: a streak launcher finding the pool empty auto-misses
  without rolling (`ammoExhausted`, out-of-ammo log note, no heat); draws go
  through the name pool so unlinked mounts spend shared ammo too.
- **Attack direction / firing arcs** — `declareAttacks` classifies every
  target on both ends: the attacker-side firing arc (`classifyArcWithBoundary`;
  gates each weapon by its TW p.105 mounting arc — head/legs/front-torso
  front-only, arms add their own side, `rearFacing` (`MechDef` mount flag,
  MTF `(R)`, e.g. Atlas CT lasers) rear-only) and the target-side attack
  direction (TW p.107, stored as `AttackDecl.attackDirection`), which flows
  through `resolveWeaponAttack` into `hitLocationForArc` and the front/rear
  armor pool. Bearings are exact flat-top pixel angles (`bearingExact`);
  arc-boundary lines admit both arcs for firing and resolve attack direction
  to the defender's dominant choice (`defenderArcChoice`). `suggestFireTargets`
  mirrors the legality checks and exposes the classified arc per target and
  per weapon; the web fire-suggestion header shows the target's firing arc
  and the resolution hit line names the attack direction. Torso twist
  (per-weapon facing override) remains deferred.
- **CASE ammo-explosion containment** — ammo explosions in
  CASE-protected locations no longer overflow to the center torso. CASE
  (explicit `case` crit slot, or implicit on all locations of Clan 'Mech)
  vents the excess out of the protected location (its IS is destroyed and
  stops at 0) and stops transfer. Detection via `checkCASE` in
  `src/rules/critical.ts`; wired through `applyAmmoExplosion` for both the crit
  slot path (`applySlotHit`) and the heat-phase path (`resolveHeatPhase`).
  `applyDamage` takes an optional `caseKind` arg to stop transfer at the
  protected location. IS CASE can mount in any location per TW p.133 (the
  previous side-torso-only restriction is lifted). Latent flavor bug:
  Clan implicit CASE returns `"case"` rather than `"caseII"` (per TacOps /
  stock Clan sheets); switch when a Clan mech's ammo explosion outcome
  matters enough to justify the 1-point cap.
- **Partial cover (TW)** — a target standing in a water1 or building hex is in
  partial cover when the attacker's ground level is not higher than the
  target's: +1 to-hit (folded into `terrainMod` via new `targetPartialCover?`
  on `AttackModifiers`), and a standard hit-location roll that lands on a leg
  strikes the cover instead (no damage to the target). Derived from
  `hasPartialCover(targetTerrain) && attackerLevel <= targetLevel` in
  `declareAttacks`, `resolveWeaponAttack`, and `suggestFireTargets`. `water1`
  `terrainMod` changed −1 → 0 (TW: depth-1 water grants cover, not an easy-hit
  bonus). Cover-hit building-CF damage deferred.
- **Pilot ejection / wrecks** — `ejectPilot` (movement phase only) marks a
  unit removed (`removed = "pilotEjected"`, destroyed stays `"not"`; counts
  toward victory; skipped by the actor
  queue and occupancy checks) and spawns a permanent wreck
  (`BattleState.wrecks`, `WreckState { unitId; level }`). Wreck level is
  decided by `wreckLevelFor` (Tactical Operations): light chassis (<40 t)
  or prone posture → level-1 wreck; otherwise the standard TW level-2
  wreck. `removePilotKilled` (six pilot hits) uses the same level rule.
  Wreck hexes are unenterable: `reachableLandings` excludes them via the
  `wreckAt` option and `executeMove` rejects entry/landing.
  LOS / partial-cover outcomes (engine-side, Tactical Operations):
  - L2 wreck between endpoints blocks LOS entirely (`losBlockedByWreck`,
    optional `wrecks` arg to `losClear`); a L1 wreck does NOT block LOS
    between two standing standard 'Mechs.
  - L2 wreck + adjacent target → +2 partial cover; +1 (per TO) when the
    attacker is at/above the wreck top and the target is elevated
    (target hex higher than attacker) or Level 3+; larger of terrain/wreck
    applies, leg-roll strikes the cover (`partialCoverMod` wired through
    `declareAttacks`/`resolveUnitAttacks`/`suggestFireTargets`).
  - L1 wreck + adjacent standing-ground target (not prone, not shut down,
    not unconscious) + attacker below wreck top → +1 partial cover; +0
    against prone/shutdown/unconscious targets.
  Web CLI `mode eject` + `done`, board `X` mark, i18n
  `err.alreadyEjected`/`log.ejected` en+kr. Wreck destruction deferred; the
  TO rough / severe-rough MP surcharge and entry PSR/PSC stay deferred
  because entry into wreck hexes is still rejected.
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
  and empty bins soak. Per-weapon totals derive live from the bins. Wired
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
  not as a kill; victory (`checkSessionVictory` in `web/session.ts`, test
  helper `checkVictory` in `tests/helpers.ts`) only fires on
  head/CT destruction or `removed` flag (reason union `"not"` < `"destroyed"` /
  `"pilotEjected"` / `"pilotKilled"`). Real TW consciousness-roll removal
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
