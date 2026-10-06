# btlib10x TODO

## Goal

- **Library** — zero-dependency TypeScript library implementing a **subset of
  BattleTech Total Warfare rules** (bipedal 'Mechs only). See `docs/API.md`.
- **Web CLI** — single-page terminal-emulator app exposing the core; vanilla
  TypeScript + DOM only, zero runtime dependencies. See `docs/CLI.md`.

## To Do

- heat related weapons
- physical attack attachment: spikes, shields
- **Undo / rollback** — the engine already saves and restores a `BattleState`
  (`saveBattleState` / `loadBattleState`, `src/rules/snapshot.ts`); still
  missing is a session-level history stack and a command to roll back N steps
  like ctrl-z.
- **Physical attacks** — punch, kick, push, club (incl. club acquisition) and
  physical-weapon strikes are implemented (see "Implemented subset" in
  `docs/CLI.md`). Remaining: charge / DFA movement-phase declarations, the
  nine industrial physical-weapon types (backhoe, chainsaw, …), the optional
  Punch/Kick-table election (+4), domino effect / accidental falls from above.
  (Physical-triggered PSRs — kicks, pushes, charges, DFAs — wait on these; see
  "Not viable" in `docs/CLI.md`.)
- **Weapon to-hit audit (TW p.303-304, p.113-114, p.117-118)** — P0/P1 done (see Done); remaining P2:
  - GATOR `Other` modifiers: secondary target `+1` forward / `+2` side-rear (TW p.108), IndustrialMech `+1` (TW p.108).
  - OS once-per-scenario + no-explode and PB same/adjacent-only legality gates (TW p.113-114); Flak `-2` gating (aerospace-scoped, TW p.113).
  - H-weapon damage-as-heat option incl. Plasma Rifle `10 + 1D6` heat vs 'Mechs / `10+2D6` in 5-pt groups vs others, woods/building double, underwater ban (TW p.113, p.139-140); the Plasma Rifle catalog row exists, the heat-damage behavior does not.
  - Heavy Gauss move+fire weight-class PSR (TW p.135-136); MGA / A-Pod / B-Pod one-shot behavior (TW p.130, p.137).
  - Missing catalog rows: Rocket Launchers, Plasma Cannon, iNarc launcher.

## In progress

- Water combat (TW pp.108-109, 121, 144), deferred:
  - Hull breach: underwater damage rolls 2D6, 10+ floods the location (all
    components nonfunctional; breached head destroys the 'Mech; flooded side
    torso disables its arm); a location with armor gone is automatically
    breached (TW p.121).
  - Underwater weapons: only lasers/PPCs fire underwater, using the Underwater
    Range Table; plasma and ammo weapons are barred (TW pp.108-109).
  - Underwater LOS/attack matrix (TW p.108): depth 1 standing 'Mechs fire leg
    weapons at underwater targets; submerged-vs-surface is blocked except as
    the table allows (today water2/3 and prone-in-water1 endpoints just block).
  - Physical attacks in water: damage halved on an underwater location, depth
    1 restrictions (TW p.144).
  - Water LOS eye height: a 'Mech in water stands on the bed (`level - depth`),
    so its LOS/cover levels should use `groundLevel` rather than the surface.

- Later in classic expansion: basements,
  hull-down, pavement skid (vehicle-specific;
  skid displacement is not viable without a displacement mechanic — see
  `docs/CLI.md`)

## Done

- **Weapon to-hit audit P1: HAG + rapid-fire (TW p.103-104, p.136)** —
  `clusterRangeMod` (+2 short / 0 medium / -2 long) applies to the 2D6
  cluster roll via `modifiedClusterRoll` (clamped 2..12), wired into the
  missile branch of `resolveWeaponAttack`; the raw roll stays in
  `clusterRoll` and the applied mod is exposed as `AttackResolution.clusterMod`
  (web log prints `cluster range mod ±n`). HAG `critExplosion` data fixed
  to 10/15/20; HAG 5-point groupings confirmed (1-damage missiles already
  flow through the lots-of-5 path). `critExplosion` wiring (Gauss/HAG
  weapon-crit blasts) rides inside `weaponDestroyed.explosion` — direct-to-IS
  blast with CASE + cascade + 2 pilot hits, replayed in the phase merge.
  Rapid-fire audit: heat `(heat ?? 0) × shots`
  (`game.ts`) and ammo `needed = shots` at declare + validate were already
  correct, including spend-on-miss/jam and 1-shot-per-missile-volley;
  covered by regression tests (Ultra AC/5 double-tap: 2 ammo at declare,
  2 heat at resolve even on a jammed miss). Deferred per scope: rotary
  jam-clear, Artemis/Narc/AMS cluster pipeline (see Later phases); observed
  gap (not P1): no partial volleys — rapid-fire always fires max shots.
  Tests: `tests/cluster.test.ts` (new), HAG short/long/unmodified cases in
  `tests/attack.test.ts`, HAG data + rapid-fire declare/resolve cases in
  `tests/data.test.ts`, `tests/depletion.test.ts`, `tests/heat.test.ts`.
- **Weapon to-hit audit P0 (TW p.303-304)** — `WeaponDef` carries a generic
  `toHitMod?: number` (the To-Hit Mod column: `-2` pulse, `+1` MRM 10/20/30/40
  and Clan Heavy Large/Medium/Small Laser); `pulse: boolean` stays as the
  P-code eligibility flag for the later Targeting Computer / aimed-shot
  milestone. `computeToHit` resolves `ToHitBreakdown.weaponMod` from
  `toHitMod` with a `-2` fallback for legacy pulse-only defs
  (`weaponToHitModifier`); the old `pulseMod` field is renamed (web GATOR
  line now prints `weapon ±n`, `info <weapon>` shows the mod for non-pulse
  weapons). LB-X stays `0` in slug mode; its `-1` cluster-mode modifier
  arrives with switchable ammo (Later phases). Validator fix in the same
  pass: `parseWeapon` no longer drops `clusterRangeMod` / `critExplosion` /
  `toHitMod` (all validated: mod integer `-5..5`, cluster mod per-bracket
  integers, explosion non-negative int), accepts `0` range brackets for
  `EQUIPMENT` (A-Pod 0/0/0, probes 0/0/N — the shipped catalog previously
  failed its own validator), and the suite round-trips every catalog entry
  plus targeted to-hit tests (`tests/data.test.ts`, `tests/tohit.test.ts`).
  Known pre-existing issue left untouched: the `heatWeapon.weapon` web
  typecheck (`web/session.common.ts:1202` vs `src/rules/game.ts`) —
  reproduces on the clean tree.
- **Heat phase enforcement (TW p.159 / p.160)** — heat scale 0-30 with
  movement heat, weapon heat, posture heat (stand-up, prone-turn), and
  engine-crit heat. Per TW p.159 the scale updates once at the heat
  phase: own heat generated during the movement and weapon attack phases
  accumulates into `unit.heatPending` (does not touch the scale mid-turn —
  weapon to-hit this turn reads the previous turn's end value), then lands
  on the scale, dissipation subtracts, and the result is the new
  `unit.heat`. Shutdown/restart and ammo-explosion checks read
  `max(startHeat, endHeat)` — the worst the scale reached at any discrete
  read; peak within the heat phase has no separate meaning. Heat-caused
  shutdown auto-fires at 30+ (initial only; restart at 30+ is a roll —
  roll 12 succeeds). 2D6 avoidance runs at 14, 18, 22, 26 with
  `roll >= avoid` for success (matches the voluntary startup convention);
  automatic restart once dissipation drops the unit below 14. Heat ammo
  explosion checks at 19, 23, 28 with `roll >= avoid` for avoided.
  Engine crit heat skips any non-online unit (TW p.160 "even engine
  criticals generate no extra heat while shut down"). Inert ammunition
  (gauss rifle rounds) is excluded from the heat-triggered selection and
  from crit-slot detonation; a crit on such a bin still empties it.
  Dissipation comes from the design's heat sinks: the engine mounts
  `floor(walking × tonnage / 25)` sinks free, the rest occupy crit slots;
  double heat sinks dissipate 2 heat each and take 3 crits (Inner Sphere)
  or 2 crits (Clan) per device. Destroyed sink crits reduce dissipation
  (a DHS retires per whole device); destroyed engine slots add +5/+10 heat
  per turn but never retire internal sinks (strict Total Warfare).
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
  direction (TW p.119, stored as `AttackDecl.attackDirection`), which flows
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
  losing both legs as immobility only when both arms are also gone
  (`isUnitImmobile` in `src/rules/damage.ts`, requires both legs AND both
  arms destroyed). One leg destroyed = standing on the remaining leg at
  1 walking MP, no running, +5 preexisting PSR (TW p.122). Victory
  (`checkSessionVictory` in `web/session.ts`, test helper `checkVictory`
  in `tests/helpers.ts`) only fires on head/CT destruction or `removed`
  flag (reason union `"not"` < `"destroyed"` / `"pilotEjected"` /
  `"pilotKilled"`). Real TW consciousness-roll removal on immobile
  end-of-turn is deferred to the piloting/falling milestone above.

## Verify later

- LOS edge-graze defender tie-break (v1 uses deterministic cube rounding)
- Falls from displacement / above (charge, DFA, domino): falls across levels already use the `levelsFallen` term for ground moves; the displacement-driven cases wait on the charge/DFA phase

## Later phases

- Salvage module (pure-function over end-state): readers must gate destroyed
  components on `isUnitLocationDestroyed(damage, loc) ||
  critSlotsDestroyed[loc][i]` — the OR is mandatory because plain-damage
  destruction (overflow, building collapse) intentionally leaves crit-slot
  flags unflagged (engine-by-design quirk), while ammo-explosion destruction
  marks every slot in zeroed locations explicitly via
  `markLocationCatastrophicallyDestroyed`. Blow-off (head/arm/leg 12
  determining) and cockpit-crit now ALSO preserve slot flags — per TW
  p.145 the blown-off limb carries its components intact for club use,
  and head components remain readable for salvage despite pilot death.
  Salvage value table deferred (TW does not publish salvage; rulebook
  reliance on TacOps / A Time of War / Strategic Operations).
- Plain-destruction rear-armor carry-over in `src/rules/damage.ts` `applyDamage`:
  same gap as the crit-slot asymmetry — when a torso's IS depletes mid-cycle
  (rear pool partial + IS hit 0), the remaining rear armor reads as intact in
  the next arc-pool calc. The catastrophic path now wipes it; the plain path
  does not. Either widen `markLocationCatastrophicallyDestroyed` to also
  cover plain destruction and accept the salvage-symmetry cost, or have
  `applyDamage` zero rear IS-depletion on the affected location. Deferred to
  keep the engine-by-design asymmetry consistent.
- Ammo ride-along in blown-off limbs: current behavior strips bins from any
  IS=0 location at end of `resolveCriticalHits`
  (`stripBinsInZeroedLocations` in `critical.ts:457`), so an explosive bin
  in a severed arm is treated as gone — at odds with the limb's salvageable
  intact-components design. Deferring the carve-out per user scope; the
  fix is a sentinel-bypass in the strip pass for blow-off-only locations.
- separate web cli framework to be used at another project
- Dev-only sarna.net scraper starting at https://www.sarna.net/wiki/BattleMech normalizing into MechDef JSON (Node OK here; library stays browser-first)
- Full intro-rules expansion: charge/DFA, multi-target arcs,
  vehicles/infantry, basements, hull-down, buildings damage beyond CF
  collapse
- Weapon systems (deferred, TW pp.129-143, pp.303-305):
  - Cluster-roll modifier pipeline: Artemis IV FCS `+2` (needs FCS
    equipment + ammo linkage; ECM-jammable, TW p.130), Narc pod `+2`
    (needs pod-attach state on targets, TW p.138-139), AMS `-4` (min 2,
    Streak-as-11, 1D6 vs single missile, 1 engagement/AMS/turn with 1 ammo
    + 1 heat each, TW p.129-130). ECM interaction stays deferred with the
    ECM bubble below.
  - Rotary jam-clear (TW p.140): End Phase declare, next turn stand/walk
    only + no weapon attacks, Gunnery+3 to clear. Jam stays permanent
    until this lands; needs a clearable-jam marker (Ultra jam never
    clears) plus movement/declaration gates.
  - Targeting Computer (`-1` DE/DB excl. flamer/MG; aimed-shot flow; bans; TW p.110, p.143).
  - TAG designation + TAG-guided ammo (TW p.142-143).
  - LRM indirect fire (`+1`, spotter move/LOS mods, spotter-fired `+1/+1`; TW p.111-112).
  - C3 / C3i networks (range from nearest networked unit; TW p.131-133).
  - ECM bubble (6-hex, kills Artemis/Narc/C3/probe; TW p.134-135).
  - Stealth Armor (`+1` med / `+2` long vs it, +10 heat/turn, ECM-linked; TW p.142).
  - Switchable ammo: LB-X slug/cluster (TW p.120-121, p.141), ATM Std/ER/HE (TW p.138), MML LRM/SRM (TW p.138).
  - Special munitions: Armor-Piercing, Precision, Flechette/Fragmentation, Infernos, Semi-Guided, Narc-equipped, Haywire/Nemesis/ECM/Explosive pods (TW p.140-142).
