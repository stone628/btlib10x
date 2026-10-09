# CLI.md — btlib10x Terminal Web App

Single-page web application exposing the btlib10x core through a stripped-down
terminal emulator UI. Vanilla TypeScript + DOM only; zero runtime dependencies
(honors AGENTS.md). Bundled with esbuild (dev-only).

## Prompt

    {game_state}[:sub_state] >

- `game_state`: `setup` | `turn` | `over`
- `sub_state` (only during `turn`): `(N):move(team T, mech ID)` during engine
  phase `movement`, `(N):attack(team T, mech ID)` during `attack` —
  N is the turn number; team and id come from `nextActor(state)`.
- Phases auto-advance when every living unit has acted. After attacks resolve,
  `drive()` in `web/session.ts` feeds `checkSessionVictory` as stopper into
  engine `gameLoop()`: more teams alive → next turn (auto initiative roll),
  otherwise → `over`. Engine itself never decides winner.

Examples:

    setup >
    turn(1):move(team 1, mech cicada) >
    turn(1):attack(team 0, mech hunchy) >
    over >

## Conventions

- All hex coordinates typed by the user are **1-based** (cols 1..width,
  rows 1..height), matching printed mapsheet labels and map JSON. Converted to
  engine coords internally.
- Dice flow through a mulberry32-backed `{ d6() }` Rng, default seed 42;
  `seed <n>` changes it, in setup only. Same seed ⇒ identical battle replay.
- Errors print as `error: <engine message>`. Failed commits leave state
  unchanged (the session rolls back via a serializable snapshot; buffers stay
  editable).
- `help` / `?` lists only commands legal in the current state.

## Commands

### Global (any state)

| command | effect |
|---|---|
| `help` / `?` | state hint line, then commands available now; `help <command>` shows usage plus per-argument explanations |
| `lang [<locale>]` | show or switch output language (`en`, `kr`); session-scoped, survives reset/rematch, defaults to `en` |
| `board` | ASCII grid (styled spans from `createBoardModel(BoardRenderInfo)`), sized from loaded map's width×height; with no map loaded, explains how to load one. Rendered as styled spans in a `.board` block: terrain glyphs on the grid rows and team-colored unit ids (id characters only, via `idStyles`); a bold `!` (`t-club`, `--club`) at the bottom-left interior slot (`\!w0 /`) marks a hex holding a ground club token (`state.clubs`; terrain-derived trees/girders are not marked) and adds a legend entry; font family, size and line spacing come from the `--font-board` / `--board-fs` / `--board-lh` CSS variables and each terrain's scheme from the `--t-*` variables in `web/index.html` |
| `clear` | clear the scrollback screen |
| `log [n]` | last n events (default 10) |
| `info mech` | list available 'Mechs |
| `info mech <model>` | sheet summary: walk/run/jump ratings, weapons, and the 3-row critical slot chart (right arm / head / left arm, right / center / left torso, right / left leg); web CLI renders the chart as a mouse-click-collapsible block |
| `info map` | list available maps |
| `info weapon [name]` | list weapons, or show one weapon's stats |
| `table [cluster\|hitloc\|crit\|heat]` | print a reference table (no argument lists them) |
| `info map <name>` | map info: width×height, terrain types and counts, elevation counts, ASCII map with terrain glyphs |
| `reset` | wipe everything back to empty setup |
| `ver` | show the built library version (`YYMMDD-<git hash>` stamp of the bundled commit) |
| `dp` | doctrine player (see below): no argument lists assignments, doctrines and the trace level; `dp <id> <doctrine\|off>` assigns in setup only; `dp go` lets it act at the current prompt; `dp why [id]` reprints a unit's last decision; `dp trace off\|brief\|full` sets how much reasoning is shown |
| `autoplay` | hidden demo driver (not listed by `help`): resets nothing itself but expects a blank slate — run `reset` first. Prints a notice, then on a short timer (`AUTOPLAY_INTERVAL_MS` in `web/autoplay.ts`) types the next command a demonstrator would: loads `quickstart`, places HBK-4G vs CDA-3MA adjacent, starts, then walks in place and fires every working weapon each turn until victory. Any manually typed command cancels it; it prints `autoplay finished.` when the battle ends |

### setup

| command | effect |
|---|---|
| `map <name>` | load a bundled map as terrain (`beginner`, `quickstart`, `test`, `testground`) |
| `add <id> <model> <col> <row> [facing]` | place unit (team auto-assigned to smallest team; default gunnery `4`, piloting `5`, facing `n`) |
| `set <id> <prop> <value>` | edit a property on a unit already on the roster (`model`, `team`, `col`, `row`, `facing`, `gunnery`, `piloting`, `pilotHitMax` (integer >= 1, default 6), `ammoPolicy` (`exposed` default, `core`, `spread`, `least-first`; case-insensitive, hyphens optional); property names are case-insensitive; cannot modify `id`) |
| `seed <n>` | set the dice seed (setup only; a battle in progress keeps its generator) |
| `rm <id>` | remove placed unit |
| `status` | setup summary: 'Mechs grouped by team, selected map name |
| `start` | ≥2 units on ≥2 teams required; creates battle, rolls initiative → `turn` |

### turn(N):move(team T, mech <id>)

The prompt names the acting unit; commands act on that 'Mech.

| command | effect |
|---|---|
| `mode standstill\|walk\|run\|jump` | declare movement mode (required first); for walk/run/jump, renders a clipped ASCII hex map of the reachable hexes — exactly the smallest bounding box around every reachable hex, clamped to the board (no padding). Reachable hexes draw a team-colored `<>` in the belly; every reachable (hex, facing) edge is tinted with the acting unit's team color, and no facing arrows are drawn. Other units inside the crop keep their ids (team-colored) but no facing arrow. Movement paths (the `F`/`B`/`R`/`L` fragment sequence per landing) remain available programmatically via `reachableLandings`/`RevealedLanding.path` for later use, but are not rendered on the map |
| `mode standup [walk\|run\|standstill]` | declare a stand-up attempt for a prone unit plus optional movement sharing one MP pool (stand costs 2; default `standstill` stands in place with no map; PSR with preexisting-damage modifiers, +1 heat; failure crashes back down for fresh falling damage and discards any queued `place`). Renders the reachable map for the named mode minus the stand cost, assuming the stand succeeds. `done` evaluates the stand first, then moves only on success — the activation ends either way; without a queued `place`, `done` just stands in place |
| `mode prone [turn\|pronestill]` | declare a voluntary drop to prone (no roll, no heat, no damage, costs 1 MP) plus an optional in-place turn sharing the walk budget (default `turn`: 1 MP per hexside, multiple turns allowed, +1 turn heat; `pronestill` drops in place with no map). Renders the turn map minus the drop cost. `done` drops first, then turns to the queued `place` (same hex) — without a `place`, `done` just drops in place |
| `mode turn` | turn in place while prone (prone unit only; 1 MP per hexside, multiple turns within the walk budget, +1 heat). `place` takes the same hex with a new facing; `done` commits |
| `mode pronestill` | stay prone (prone unit only; 0 MP, 0 heat). `place` stays unavailable; `done` ends the activation |
| `mode shutdown` | declare a voluntary shutdown (online unit only). `place` stays unavailable; `done` commits it — the unit goes off-line (`manual`) and can no longer move, fire, or act normally this turn. `cancel` resets the declaration |
| `mode startup` | declare a voluntary startup attempt (shut-down unit only). `done` rolls 2D6 against the heat shutdown avoidance number: success turns the unit `starting` (still off-line now, online just before the next initiative roll); failure keeps it shut down. `done` alone (without `mode startup`) passes — the unit stays off-line |
| `mode eject` | declare a pilot ejection (any non-removed unit, including a shut-down one). `place` stays unavailable; `done` commits it — the unit is marked removed (`pilotEjected`) and its hex becomes a permanent level-2 wreck. `cancel` resets the declaration |
| `place <col> <row> <facing>` | place the 'Mech at a final hex + facing in one step; `col row` are 1-based, `facing` is an absolute word (`n\|ne\|se\|s\|sw\|nw`). The (hex, facing) must be a reachable landing shown by `mode` (validated against the movement candidate); replaces any previously queued steps. Jump landing facing is chosen freely, so any facing at a reachable hex is legal for `jump` |
| `sheet [id]` | with id: armor diagram + weapons for a unit (plus the critical slot chart, which on `sheet <id>` marks per-slot live state with [J](jam) / [-](destroyed) / per-bin ammo `(n left)` markers); without id: brief unit list (id, model, position+facing) grouped by team |
| `heat [id]` | heat scale status of a unit (default: the acting unit); also available in the attack phase |
| `candidate` | re-show the queued move and the reachable-hex map for the declared mode |
| `status` | queued move steps with running MP cost per step |
| `cancel` | clear mode + steps |
| `rollback` | undo the last completed `done`: back to the previous actor's prompt (half-declared input is discarded; dice state and replay log are restored too). At most `MAX_SNAPSHOT_COUNT` (10) prompt snapshots are kept (`web/rollback.ts`); no redo |
| `done` | commit posture-change first, then move only on success (`attemptStandUp`/`dropProne` then `executeMove` in one atomic commit; failed stand discards queued `place`); prints path + MP spent (posture cost folded in) and full budget |

Shut-down units (including `starting`) act **first** in the movement phase,
regardless of initiative: the log prints
`{id} has movement priority — shut down, must attempt startup or pass`, and the
only move-phase commands available to them are `mode startup` (or `done` to
pass), plus `cancel`, `sheet`, `status`, `heat` and the globals.

### turn(N):attack(team T, mech <id>)

| command | effect |
|---|---|
| `torso <front\|left\|right>` | twist the acting unit's torso one hexside (TW pp.105-106): arm and front-torso weapons fire into the twisted arc; locked once a `fire` is queued |
| `candidate` | show possible targets with available weapons |
| `fire <targetId> <weapon> [<weapon> ...]` | queue weapon declarations using 1-based weapon numbers (target first; declare several weapons at once, all against the one shared target; rapid-fire SRM/LRM fire a full volley — no `shots` argument). A prone attacker fires at +2, cannot fire leg-mounted weapons, and must draw the whole volley from one prop side (left-arm and right-arm weapons cannot mix — the suggestion shows both prop-left and prop-right sets; firing an arm set props the other arm) |
| `sheet [id]` | with id: armor diagram + weapons for a unit (plus the critical slot chart, which on `sheet <id>` marks per-slot live state with [J](jam) / [-](destroyed) / per-bin ammo `(n left)` markers); without id: brief unit list (id, model, position+facing) grouped by team |
| `punch` / `kick` / `push` / `club` / `strike` / `pickup` / `drop` | physical attacks and club handling, see "Implemented subset: physical attacks" below |
| `heat [id]` | heat scale status |
| `status` | queued attack declarations |
| `cancel` | clear declarations |
| `rollback` | undo the last completed `done`: back to the previous actor's prompt (half-declared input is discarded; dice state and replay log are restored too). At most `MAX_SNAPSHOT_COUNT` (10) prompt snapshots are kept (`web/rollback.ts`); no redo |
| `done` | `declareAttacks` + `resolveAllAttacks` (simultaneous — every unit's declared shots resolve, even units killed that phase); prints per-weapon GATOR to-hit line, dice, cluster hits, damage by location |

### over

| command | effect |
|---|---|
| `sheet [id]` | with id: armor diagram + weapons for a unit (plus the critical slot chart, which on `sheet <id>` marks per-slot live state with [J](jam) / [-](destroyed) / per-bin ammo `(n left)` markers); without id: brief unit list (id, model, position+facing) grouped by team |
| `rollback` | return to the last battle prompt (the one before the game-ending `done`) |
| `rematch` | new battle, same roster + terrain + seed |
| globals | `board`, `log` remain available; `reset` returns to empty setup |

**Replay data.** While a battle is played the session records it in the compact
format of `docs/REPLAY.md` (`web/replay.ts`: header on `start`/`rematch`, one `M`/`A`
line per committed activation, rejected commands leave no trace). When the battle
ends, the victory banner is followed by a collapsed block *"you can replay this
match with this data"* holding the records laid out by `replayPrettifier`: version,
the setup line (`B…;S…`), one line per unit, then per turn one movement line and one
attack line (activations joined by `;`), the `W` line and one `E` line per unit. `rematch` starts a new
log; `reset` clears it and re-creates the dice generator from the seed. `replayPlayer(text)`
(`web/replay.ts`) replays such text and checks the winner, the final dice state and every
unit's end state; it throws a single error naming turn, phase and actor on the first problem. A match
that cannot be reproduced (more than 36 units, a team above 9, a unit id with
`:` `;` `,` or whitespace, a replaced dice generator) shows no block.

## Doctrine player (GDD §9)

A one-ply scoring player for units assigned a MechWarrior doctrine in setup
(`dp <id> <doctrine>`). The doctrine is a game-layer setting: it is not part of
`UnitInit` or the engine. Whenever `start`, `rematch` or `done` leaves the prompt
with a doctrine unit, the CLI plays it at once (no timer): it prints the
reasoning, then types the commands, each echoed as `<prompt> > <command>` and run
through the normal dispatch, so atomic commits, replay recording and rollback
snapshots all apply. A failed command stops it and hands the prompt to the human.

Doctrines (`web/doctrine.data.ts`): `alpha` (Alpha Striker), `longtom` (Long Tom),
`jumpjockey` (Jump Jockey), `hulldown` (Hull-Down), `pitfighter` (Pit Fighter),
`gladiator` (Gladiator), `dispossessed` (Dispossessed). Heat ceilings Cold 4 /
Warm 7 / Hot 9 / Redline 13 / Overdrive 30 sit one point under a Heat Scale step
(TW pp. 159–160). Ammo discipline: Free (any TN) / Measured (TN ≤ 10) /
Conservative (TN ≤ 8, 25% reserve) / Miser (TN ≤ 7, 50% reserve, energy first).

- **Movement**: every reachable landing for standstill / walk / run / jump (jump
  only if the doctrine uses jump jets) is scored with the GDD §9.1 terms: range
  (expected damage at that hex, best torso twist, minus drift from the preferred
  distance), cover, tmm (TW p. 107), flank, melee, edge (ring-out push setup),
  exposed (enemy expected damage), heat (over the ceiling) and crowd (Gladiator).
- **Attack**: per torso twist, a greedy weapon set by expected damage per heat,
  stopping at the heat ceiling and honouring the ammo discipline; adjacent
  punch / kick / push options are weighed against the weapons those limbs give
  up (opportunistic doctrines skip kicks above TN 8; push only for a ring-out).
- **Strategy memory** (per unit, across turns): committed target (switched only
  for a 1.5× better one), posture (approach / engage / hold / recover / yield),
  turns in contact, losses per turn, and a tally of enemy move modes.
- **Yield**: at the doctrine's armor + structure threshold (or with no weapons
  left for a Never-melee doctrine) it declares `mode eject`, standing in for the
  missing yield helper (GDD R6).
- **Own RNG**: a separate stream seeded from the battle seed, used only for
  tie-breaks; deciding never moves the battle dice.
- **Rollback**: the doctrine context (memory, its RNG, last traces) is part of
  each prompt snapshot. A rolled-back doctrine prompt waits; `dp go` replays the
  identical decision, or the human can play the prompt by hand.

The reasoning prints in the attack-resolution box:

    [foe -> me]
         ┌ doctrine Jump Jockey · posture engage · target me (held 1)
         │ movement: 871 options scored · heat 0, ceiling 9
         │ #1 standstill (4,3) se  +8.0 = range +8.5 cover +2.0 exposed -2.5
         │ #2 run (4,10) s  +6.5 = range +7.0 tmm +3.6 flank +0.9 exposed -5.0
         │ #3 jump (1,7) s  +5.6 = range +2.0 tmm +3.6 flank +0.9 exposed -0.8
         │ chose #1 standstill (4,3) se; for range +8.5 cover +2.0; against exposed -2.5; lead +1.5 over #2
         └ commands: mode standstill; done

`brief` (default) lists the top three options, `full` adds the rest in a
collapsible block, `off` shows only the typed commands. The reachable-hex board
that `mode` prints is left out of doctrine output.

## Status — BattleTech Total Warfare rule coverage

The engine implements a **subset of BattleTech Total Warfare rules** for
**bipedal 'Mechs only**. The terminal app exposes everything the engine can
simulate. See `docs/VISION.md` for direction and the will/won't lists.

### Implemented

- **Units** — bipedal 'Mechs only (fourteen record-sheet 'Mechs in `data/mechs/`:
  AS7-D, BSW-X1, BZK-F3, CDA-3MA, CN9-YLW2, ENF-4R, GRF-1N, HBK-4G, HCT-5S,
  HER-5SA, MC-MKII-2, TBR-Prime, WHK-Prime, WVR-6R; see `docs/MTF.md` to add more).
  Front and rear armor are separate pools; internal structure is derived from
  tonnage on the standard TW table.
- **Movement** — walk, run, jump, standstill. MP costs include the base 1 MP
  to enter a hex plus a terrain surcharge (data-driven from
  `src/data/terrain.data.ts`; e.g. lightWoods +1, heavyWoods +2, rough/rubble +1,
  water2/3 +3, buildings +1/+2/+3/+4, pavement +0), +1 MP per
  level of elevation changed (up or down), and 1 MP per
  hexside of facing change. Ground moves step straight ahead or back; run
  cannot move backward; forward steps may change level by at most 2 per hex
  and backward steps cannot change level at all. Jump steps into any adjacent
  hex at 1 MP per step, with the landing facing chosen freely; a jump follows a shortest
  path and is impossible when any hex on it is more than Jumping MP + the
  starting level above the sea (TW p.53). Water hexes are measured at their bed (hex level minus depth,
  TW p.32), so entering water costs 1 MP per level of depth on top of the
  water surcharge (depth 3 cannot be entered from the surface: 3 levels > 2).
- **Line of sight** — intervening-hex line trace; light/heavy woods points
  (1/2) accumulate along the line and ≥ 3 points block. A real-valued
  "ray height" is drawn between attacker and target LOS levels (hex
  level + 2 for a bipedal 'Mech); an intervening hex blocks when its own
  LOS level strictly exceeds the ray's height at the hex's center. Water
  depth 2+ (water2/water3) blocks firing into and out of the hex
  (`blocksTargeting`), and so does depth 1+ water for a prone 'Mech
  (TW p.102).
- **To-hit (GATOR)** — gunnery + attacker movement + target movement + range
  bracket + intervening terrain + weapon mod + minimum range penalty; auto-hit ≤
  2, auto-miss > 12. Target-terrain modifier is data-driven
  (`terrainTargetMod`): lightWoods/heavyWoods +1/+2. A shut-down 'Mech (or
  one with both legs destroyed) is immobile and applies a flat −4 target
  modifier instead of a movement band.
  **Partial cover (TW)** — a target standing in a water1 or building hex is
  in partial cover while the attacker's ground level is not higher than the
  target's: +1 to-hit (separate `coverMod` breakdown field, printed as
  `cover +1`) and a hit-location roll
  that lands on a leg strikes the cover instead (no damage to the target).
  A target adjacent to a level-2 'Mech wreck is in partial cover for
  +2 to-hit while the attacker's ground level is below the wreck's top
  (hex level + 2); the larger of the terrain and wreck values applies, and
  the leg-strike miss rule holds under either.
  Depth-1 water cover applies even when the attacker is higher (the water
  surrounds the 'Mech); building cover is negated by a downhill attacker.
  An adjacent higher hex between attacker and target also grants partial
  cover (TW p.102).
- **Terrain catalog** — 13 core-rulebook terrain types (`clear`, lightWoods,
  heavyWoods, rough, rubble, pavement, water1, water2, water3, and four
  building classes) defined in `src/data/terrain.data.ts` and validated by
  `terrain.schema.ts`. Move surcharge, screening value, target modifier,
  partial-cover flag, and targeting-restriction flag all live in the catalog.
- **Buildings** — building hexes carry a structural factor (CF) initialized
  from the sub-type (light 15 / medium 40 / heavy 90 / hardened 120).
  Each weapon grouping that hits a unit inside costs the hex ceil(CF at
  phase start / 10), applied after all weapons fire (`damageBuildingAt`);
  when CF reaches 0 the hex collapses to rubble and a `buildingCollapsed`
  event fires. Collapse damage is ceil(CF/10 x (1 + levels above)) in
  5-point punch-table groups, plus standard falling damage above Level 0.
  Units inside a collapsing hex take collapse damage (`collapseDamage`
  event).
- **Hit location** — bipedal front / left side / right side / rear tables.
- **Cluster hits** — missile 2/4/5/6/10/15/20 + shot columns 2/3/4.
  HAG applies its range mod (+2 short / −2 long, clamped 2..12) to the
  roll; 1-damage missiles (incl. HAG) group into 5-point lots.
  Streak launchers skip table: to-hit success lands full tube count, miss
  fires nothing (no ammo spent, no heat). Launchers share one ammo pool per
  weapon name; an earlier launcher may drain pool mid-resolution, and a later
  launcher with nothing left auto-misses without rolling (declaration order
  sets ammo priority).
- **Damage** — front/rear armor transfer inward on depletion; side-torso
  internal-structure loss blows off the arm; head/CT IS death kills; leg IS
  death immobilizes. Hits on already-destroyed locations transfer.
- **Firing arc** — attacker-side arcs gate declarations per weapon mounting
  (TW p.105: head/legs/torso front-only, arms add their own side,
  `rearFacing` torso mounts rear-only). The p.105 hex template assigns every
  hex wholly to one arc (forward arc three hexes wide: facing ±1 included),
  so firing has no boundary pairs; the target-side attack direction
  (TW p.119) picks the hit-location column (front/left/right share one
  per-arc table, rear shares the front column) and the armor pool (rear
  torso pool for rear-direction torso hits). Attack direction on an exact
  boundary line resolves to the defender's dominant choice (front over side,
  never rear). The web fire-suggestion header shows
  the target's firing arc, and the attack-resolution hit line names the
  attack direction it resolved against.
- **Weapons** — ballistic / energy / missile with short/medium/long range
  brackets, rapid-fire, weapon to-hit mods (−2 pulse, +1 MRM / Clan heavy
  lasers), per-bin ammo tracking, jam on
  natural 2 (multi-shot), LRM lots-of-5 grouping. Ammo is depleted per
  crit slot ("bin") under a per-unit policy fixed at setup with `set <id> ammoPolicy <policy>`:
  `exposed` arms → legs → side torsos → head → center torso (default),
  `core` the reverse priority, `spread` fullest-bin-first, `leastFirst`
  emptiest-first; equal-priority bins are chosen at random. Declared
  `shots` pool across all mounts and bins of a weapon name (remainder one
  per bin); per-weapon totals derive live from the bins. Streak ammo depletes
  only on hit (miss = launcher never fired).
- **Battle flow** — initiative roll, sequential movement phase, weapon
  attack phase, end-phase kill sweep, victory check, rematch.
- **Critical hit table** — the official TW determining table
  (2D6: 2-7 no crit, 8-9 one, 10-11 two, 12 blow-off or three on torso) plus
  the 1D6 / 2D6 half+slot roll per location. A hit-location roll of 2 is a
  through-armor critical: damage lands on armor normally and the attacker
  still rolls once on the determining table (tagged `through-armor` in the
  log). Slot selection re-rolls on
  empty / soak / already-destroyed slots and the whole determining roll
  transfers inward when the source is exhausted (head and center torso
  are terminal).   Effects implemented: weapon destroyed (Gauss-family / HAG
  weapon crits detonate their `critExplosion` blast inside the same
  `weaponDestroyed` event — 20-pt IS Gauss / 3-pt AP / 16-pt Light /
  25-pt Heavy / 10-15-20-pt HAG, direct to IS with CASE + cascade + 2
  pilot hits like an ammo explosion; further hits on the powered-down
  mount soak), ammo explosion
  (an explosion detonates only the hit bin — its remaining shots ×
  per-shot damage applied directly to that bin location's internal
  structure, with a cascading critical roll on the drained IS; bins in a
  location whose IS is fully gone are removed outright, and an empty bin
  soaks the hit), inert ammo (e.g. gauss rifle) recorded as a non-
  exploding crit that still empties the bin, arm/leg/head blown off on a 12, cockpit crit kills the
  pilot, leg actuator/hip/jump-jet destruction feeds the effective
  movement helper (leg actuators −1 walk each, hip halves walking, jump
  jets −1 jump each), and arm actuator/shoulder destruction feeds the
  weapon to-hit modifier (shoulder +4 suppressing upper/lower, otherwise
  +1 per destroyed upper/lower actuator in the firing arm; hand has no
  weapon effect). Engine / gyro / sensor / life-support / heat-sink
  slots take and absorb crits in the slot table; destroyed engine slots
  feed the heat system below.
- **Heat** — heat scale 0-30 (the stored value is never clamped; the excess above 30 is the Heat Overflow box) with movement heat, weapon heat, posture heat
  (stand-up, prone-turn), and engine-crit heat. Per TW p.159 the scale
  updates once at the heat phase: own heat generated during the movement
  and weapon attack phases accumulates into `unit.heatPending` (does not
  touch the scale mid-turn — weapon to-hit this turn reads the previous
  turn's end value), then lands on the scale, dissipation subtracts, and
  the result is the new `unit.heat`. Shutdown/restart and ammo-explosion
  checks read the post-dissipation end heat (`endHeat`) only.
  Heat-caused shutdown auto-fires at 30+ and no restart is possible while
  heat stays at 30+ (TW p.159-160; `shutdownAvoid(30)` is the unreachable
  `D2D6_IMPOSSIBLE`, and a blocked restart rolls no dice). A pilot who is
  unconscious cannot override a shutdown (automatic, +3 PSR as usual) and
  cannot attempt a restart at 14+; below 14 the restart is automatic. 2D6 avoidance runs at 14, 18, 22, 26 with
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
  Standing in water adds dissipation (TW p.159): each submerged sink removes
  1 more heat (2 for a double), capped at 6 — all sinks count at depth 2+ or
  prone in depth 1+, only leg sinks when standing in depth 1.
- **Voluntary shutdown / startup** — `mode shutdown` + `done` sends an
  online unit off-line (`manual`); it persists (no end-phase auto-restart)
  until a voluntary startup succeeds. `mode startup` + `done` rolls 2D6
  against the shutdown avoidance: success → `starting` (still off-line,
  online just before the next initiative roll), failure → stays off-line.
  Startup at 30+ heat is blocked (no roll), and so is startup at 14+ for an
  unconscious pilot.
  Shut-down units act first in the movement phase regardless of initiative.
- **Pilot ejection / wrecks** — `mode eject` + `done` marks the unit
  removed (`removed = "pilotEjected"`; destroyed stays `"not"`; counts toward
  victory; skipped by the actor queue and by occupancy checks) and spawns a
  wreck in its hex (level 2; level 1 for light or prone 'Mechs, see below). A
  wreck is permanent and blocks the hex entirely: no ground or jump
  movement may enter or land on it, LOS is blocked when the wreck lies
  strictly between the endpoints (independent of elevation), and a target
  adjacent to a wreck gains +2 partial cover when the attacker is below the
  wreck's top. The hex is rendered with an `X` mark.
- **Piloting skill rolls, falling, prone** — every unit carries a piloting
  skill (`add`/`set` argument, default 5). End-of-phase PSRs fire for 20+ damage
  (+1), each destroyed leg/foot actuator (+1), each destroyed hip (+2), and
  a first gyro hit (+3); a destroyed gyro or leg drops the 'Mech
  automatically, as does any required PSR on a shut-down or unconscious
  unit. An involuntary (heat) reactor shutdown forces an immediate +3 PSR; a voluntary one forces none (TW p.160);
  running with a damaged hip/gyro or jumping with damaged gyro/leg/foot/hip
  actuators (or a destroyed leg) forces a PSR with preexisting-damage
  modifiers at the end of the move. Preexisting damage modifies every PSR (+1 per destroyed leg/foot
  actuator, +2 per destroyed hip replacing that leg's other mods, +3 for a
  hit gyro, +5 per destroyed leg replacing that leg's other mods). Pilot
  wounds never modify PSRs or to-hit numbers (TW tracks wounds through
  consciousness rolls only). A fall
   rotates facing per the Facing After Fall table (1 same/front, 2 +1/right,
   3 +2/right, 4 opposite/rear, 5 −2/left, 6 −1/left) and lands
   `ceil(tonnage / 10) × (levels fallen + 1)` damage in 5-point clusters
   on the fall column (halved rounding down underwater at depth 2+ per TW
   errata), with normal crit rolls; levels fallen measure underlying
   terrain (hex fell into minus hex the fall began from — a fall across
   levels drops into the lower hex; jump-phase falls count 0 levels; a 'Mech
   walking into water from above the surface takes two packets, TW p.57:
   surface impact `ceil(t/10) × (levels+1) / 2` plus bottom impact
   `ceil(t/10) × (depth+1) / 2`, each rounded down), and
   the pilot then
  makes a seatbelt PSR (+5 off a destroyed leg, +6 off a destroyed gyro, or
  the failed roll's modifiers, plus +1 per level above 1 fallen) or takes
  1 hit — automatic when the 'Mech is
  immobile or the target exceeds 12. Prone units stand up with `mode
  standup <walk|run>` (stand costs 2 plus the declared mode's heat, +1 heat for the stand; a failed stand
  with a full attempt of MP left may be retried, MP shared across attempts; failure crashes back down for fresh fall damage and
   discards any queued `place`), drop and optionally turn in place with `mode prone
   [turn|pronestill]` (drop costs 1 MP, no heat, no damage; turns cost 1 MP per hexside
  within the remaining walk budget + 1 turn heat); prone units turn with
  `mode turn` or hold with `mode pronestill`. Facing changes go through `place`
  at the current or a new hex — a destroyed gyro or two destroyed legs forbid
  standing. Prone attackers fire at +2 without leg weapons and cannot mix
  left-arm and right-arm weapons in one volley (each volley props the
  opposite arm; the fire suggestion shows both prop sides); prone targets take
  −2 from an adjacent hex and +1 from every other hex.
- **Sensor crits** — the first destroyed sensor slot adds +2 to the unit's weapon
  to-hit numbers; a second destroyed sensor blinds the 'Mech (no weapon
  attacks at all).
- **Pilot damage / consciousness** — head hits (1 point per damaging
  grouping, even armor-only), ammo explosions (2 points), falls (failed
  seatbelt), shut-down falls, and heat-soaked life support (destroyed slot +
  end-of-heat-phase heat 15+ → 1 point, 26+ → 2 points) injure the pilot;
  every point forces a consciousness roll (default pilot: 1→3+, 2→5+, 3→7+, 4→10+, 5→11+; the table scales to `pilotHitMax`)
  taken before any simultaneous PSR. A failed roll knocks the pilot out:
  the unit cannot act and counts as immobile until it wakes in a later end
  phase; `pilotHitMax` (default 6) total hits kills the pilot and removes the unit
   (`removed = "pilotKilled"`, destroyed stays `"not"`), leaving a level-2
   wreck like an eject. A cockpit-slot crit kills the pilot outright
   (TW p.128); head destruction / blow-off instead auto-ejects (see below); any other destruction (engine, center torso) leaves the pilot
   alive inside while hits < `pilotHitMax`.
   The `sheet` shows a pilot block (status, HP boxes, consciousness targets).
   **Ejection / auto-eject are Tactical Operations extensions, not TW:** manual
   eject (`mode eject`) and auto-eject (always on: an ammo / Gauss explosion that
   destroys the center torso, directly or by transfer; or destruction / blow-off of the
   head, which first raises pilot hits to `pilotHitMax - 1`, TO p.165) roll a PSR; failure deals
   floor(margin of failure / 2) pilot hits (`pilotDamaged`, reason `ejection`).
   The pilot keeps `pilotHits`; status stays `ejected` even if those hits reach the max.
   The PSR carries the Ejection Modifiers Table (TO p.165): landing hex behind the 'Mech
   (clear/pavement -2, water -1, rough/rubble 0, light woods +2, heavy woods +3, +1 per
   building level), prone +5, unconscious +3, +1 per head IS point lost, +1 for auto-eject.
   Planetary conditions and the submerged-cockpit ban are not modeled.
- **Movement-entry PSRs** — entering rubble (+0) or water (depth 1: −1,
  depth 2: +0, depth 3+: +1) and entering a building hex (light +0 /
  medium +1 / heavy +2 / hardened +5) forces a PSR (plus preexisting
  damage); a failed water/rubble roll falls the 'Mech in the entered hex
  (jump checks the landing only), while a failed building roll crashes it
  for `ceil(CF / 10)` front-column damage without falling — unless the crash
  wrecks a leg/gyro or knocks the pilot out, which drops the 'Mech on the
  spot. Exiting a building hex requires no PSR.

- **Multiple targets** (TW p.108, engine only; the CLI still fires at one target) —
  weapons may be split among targets; secondary targets take +1 (forward arc)
  or +2 (side/rear), physical attacks exempt.
- **Torso twist** — `torso <front|left|right>` twists the acting unit one
  hexside for the attack phase (TW pp.105-106): arm and front-torso weapons
  fire as if the 'Mech faced the twisted direction. Physical attacks respect
  it (punch/club/strike follow the twist; kick and push are feet-based).
- **Water** — water hexes have a surface at the hex level and a bed `depth`
  levels below. Depth-change MP is charged per level of bed difference, 'Mechs
  cannot run into water (Minimum Movement excepted, TW p.53), jump limits
  apply (no jumping from depth 2+, only non-leg jets at depth 1, a jump
  landing in water rolls the entry PSR and tumbles `depth` levels on
  failure), and prone 'Mechs in depth 1+ water are out of LOS. Hull breach,
  underwater weapons and the underwater LOS table are not implemented.

### Implemented subset: physical attacks (punch, kick, push, club, strike)

- **Declaration** — in the weapon attack phase alongside `fire`: `punch
  <target> [left|right]` (default right; queue twice for both arms, one
  roll each), `kick <target> [left|right]` (default right), `push
  <target>`, `club <target>`, `strike <target> [left|right]` (default: the
  arm mounting the unit's physical weapon; required when both arms mount
  one). One type per turn
  (two-arm punch excepted; at most one strike even with two mounted).
  A punching / striking arm or kicking leg cannot fire its mounted weapons, and
  push / club bars all arm-mounted weapons. `candidate` lists legal
  physical options for adjacent enemies; `status` shows the queued
  physical declarations.
- **Resolution** — weapons resolve first in `resolveAllAttacks`,
  then a weapon PSR sweep (falls, consciousness, kills) lands before any
  melee (TW pp. 37-38, 59, 61: a weapon-phase fall starts the melee prone),
  then physical attacks resolve against post-weapon state with re-validation
  (destroyed/unconscious/shut-down attackers skip; displaced targets redirect
  at +1 onto an enemy holding the declared hex or auto-miss with no valid
  target, TW p.144 — both reported in the CLI), then a physical sweep rolls
  the 20-point trigger per sub-pass (weapon and physical damage never pool)
  plus deferred kick PSRs: punch damage 1/10 t on the Punch table, kick 1/5 t
  on the Kick table, club 1/5 t on the standard table, strike per weapon
  (hatchet 1/5 t, sword 1/10 t +1, blade 1/10 t) on the standard table
  (every table read on the attack-direction column — Left Side, Front/Rear
  or Right Side, TW pp.145, 147; any attack on a prone 'Mech rolls 2D6 on
  the standard table, TW p.151; a through-armor critical only on a 2 rolled
  on the 2D6 standard table, TW p.121),
  push no damage with target displacement + attacker advance (immediate
  defender PSR, TW pp.147, 151; mutual pushes resolve simultaneously —
  both fail = nothing, both succeed = neither moves and both roll,
  one succeeds = resolve normally). Kick PSRs defer to the sweep (kicked
  target on a hit, attacker on a miss).
  Head hits injure the pilot as usual. A crit on any slot of a mounted
  physical weapon destroys it (the HCT-5S Hatchetman now ships its hatchet).
  Triple-Strength Myomer (TW p.143, e.g. the CN9-YLW2 Centurion): active the
  turn after a turn ending at heat 9+ — +2 Walking MP (running recomputed,
  jump unaffected) and doubled punch/kick/club/hatchet/sword/blade damage.
  Declarations stay merged (weapons + physicals in one attack activation) for
  playability — TW declares physicals in their own phase.
- **Club acquisition** — `pickup [limb|tree|girder] [n]` takes a severed
  limb, dropped club, uprooted tree (woods) or girder (rubble 2D6 7+/6+/5+)
  and is exclusive with every attack that turn (TW p.146); no PSR, MP or heat.
  A lone token in the hex is taken automatically; with several, pick one by
  number or the command errors. `drop` leaves the club intact in the hex
  (any kind), where any 'Mech may re-take it with no roll. A fall, a drop to
  prone, or leaving play also drops the club in the hex (TW silent; house
  ruling). A severed limb that is ever picked up loses its `salvageable`
  flag (`blownOffLimbs`; house rule, `salvageableSeveredLimbs`).
  The `board` map marks hexes holding a ground club token with `!`.
- **Deferred** — charge / DFA (movement-phase declarations), the remaining nine
  physical-weapon types (industrial tools), the optional
  Punch/Kick-table election (+4), domino effect / accidental falls from
  above. (The level-difference table auto-swap and through-armor / structure
  critical hits from physical damage are implemented.)

### Not yet implemented

- **Charge / DFA physical attacks**.
- **Building structural damage beyond CF** — basements / multi-floor
  interiors, structural-factor transfer between levels.
- **Wreck destruction** — wrecks are permanent obstacles; clearing,
  damaging, or merging wrecks with building collapse is deferred. Movement
  entry is still rejected (`executeMove` throw; `reachableLandings` ignores
  wreck hexes via the `wreckAt` option), so the Tactical Operations rough
  (+1 MP) and severe-rough (+2 MP) entry surcharge and the PSR/PSC triggers
  that come with it remain unimplemented pending an open-entry policy.
- **Tactical Operations wreck levels** (engine-side, baked in):
  light 'Mechs (<40 t) and prone units with a killed/ejected pilot leave a
  level-1 wreck; everything else leaves a level-2 wreck
  (`wreckLevelFor` in `src/rules/game.ts`). L1 wrecks do **not** block LOS
  between two standing standard 'Mechs but grant +1 partial cover to
  standing ground 'Mechs behind them; L2 wrecks block LOS entirely, give
  +2 partial cover to adjacent targets, and +1 (per TO) to elevated or
  Level 3+ targets when the attacker is at/above the wreck top
  (`losBlockedByWreck`, `partialCoverMod`).
- **Quadripedal 'Mechs**, vehicles, infantry, battle armor.
- **Called shots**, aimed shots, spotter / indirect fire, ECM.
- **Pilot abilities** (edge, etc.), quirks, experience beyond the gunnery
  skill band.

### Not viable in this subset (blocked by explicit limits)

These piloting-adjacent rules cannot be implemented without breaking limits
stated elsewhere in this document or the codebase:

- **Pavement skidding with displacement** (TW p.62) — a failed running skid
  slides the 'Mech extra hexes before it falls. The engine's only
  displacement mechanic is the push attack (cf. the atomic commit boundary
  in AGENTS.md), so only the fall itself could land, never the slide.
- **Falls from displacement / above** (TW pp.151-152) — charges, DFAs and
  accidental falls from above displace a unit across hexes or levels
  before it falls. All falls here from combat PSRs, shutdowns, stand-up
  attempts and building crashes happen in place (0 levels fallen); only
  ground-movement falls across levels use the `levelsFallen` term
  (lower-hex rule), since push is the only displacing rule in the subset.
  DFA's 2-level rear-column fall waits on the charge/DFA phase.
- **Minimum movement** (TW p.49) — a standing unit with at least 1 MP may
  always enter the single hex directly ahead, whatever the terrain/climb
  cost, as its only expenditure (no facing change). Declared as `mode run`
  (it counts as running: run heat, running PSRs); the charge is capped at
  the unit's run budget (at least 1). Only that one forward hex is offered
  when the normal run budget cannot afford it. A one-leg 'Mech may `run` for
  this single hex only. It is also the one run that may enter water (TW p.53
  otherwise forbids running into depth 1+ water, which the engine enforces).
- **One-legged hopping movement** (TW p.122: walk 1 MP, no run except minimum movement, jump with PSR
  each landing) — `effectiveMovement` caps a standing one-leg 'Mech at
  `walking: 1, running: 0`; jump MP unchanged. A prone one-leg 'Mech may
  turn 1 hexside/turn. Standing attempt at +5 PSR (consumes the 1-MP walk
  budget). The +5 seatbelt PSR after a leg-destroying hit is rolled
  normally; only the truly immobile case (both legs AND both arms) takes
  the auto-pilot-damage shortcut.
- **Four-legged / vehicle PSR rows** (quads, skidding vehicles,
  sideslipping VTOLs) — bipedal 'Mechs only (top of this section).
- **Hull breach / underwater combat** — TW has no drowning rule; submerged
  'Mechs risk hull breach instead (TW p.121). Water blocks targeting at depth
  2+ and halves falls, but breaches, underwater weapons and ranges, and the
  underwater LOS table (TW pp.108-109) are not implemented (see `docs/VISION.md`).

### Verify-later

- LOS edge-graze tie-break uses deterministic cube rounding.

## Architecture

    web/index.html      terminal chrome: scrollback <pre>, prompt line, key capture, inline CSS
    web/main.ts         bootstrap; wires DOM ↔ session/cli; reprints prompt after each command
    web/cli.ts          tokenizer + per-state command registry + help generator
    web/session.ts      core session state machine: setup/battle/over, RNG, atomic commit (commitAtomic),
                         drive() phase-advance wrapper around engine gameLoop()
    web/session.common.ts  shared formatters: heat, board, info, sheet, crit chart, log events
    web/session.move.ts    movement phase: mode parsing, reachable map, place/cancel/done commit
    web/session.attack.ts  attack phase: fire/physical queues, validation, torso twist, ammo policy, resolve
    web/session.setup.ts   setup phase: map, add/set/rm units, status, start
    web/session.over.ts    over state: rematch, status
    web/rollback.ts        prompt snapshots + the `rollback` command's undo
    web/chunk.ts       structured output chunks: lines, board, columns, collapsible
    web/rng.ts          mulberry32-seeded Rng
    web/autoplay.ts    hidden `autoplay` demo driver
    web/doctrine*.ts   doctrine player (GDD §9): doctrine table, move/attack scoring,
                         context + decide(), `dp` command + synchronous driver
    web/lookup.ts      tolerant (case-insensitive) catalog lookups
    web/table.ts       reference-table renderers (`table` command)
    web/misc.ts        shared label helpers (facing, posture, weapon category)
    web/i18n/          string catalogs (`en` canonical, `kr`)
    web/render.ts       structured BoardModel / Span model + boardToText / boardToSpans
    scripts/build-web.mjs  esbuild bundles: src/index.ts → web/btlib10x.js (engine),
                         web/main.ts → web/bt10x.js (app; engine kept external),
                         and copies data/btlib10x.jsonl → web/btlib10x.jsonl (catalog,
                         fetched once at boot)

Import wrinkle: tsc-emitted `.json` imports are not loadable by browsers, so the
app ships as an esbuild single-file bundle instead of consuming `dist/` directly.
Library sources stay untouched.

## Build, run, and ship

    npm install            # picks up esbuild devDependency
    npm run build:web      # one-shot esbuild bundle → web/btlib10x.js + web/bt10x.js (+ web/btlib10x.jsonl and web/VISION.md copies)
    npm run dev:web        # watch + serve: rebuilds on change, serves at http://127.0.0.1:8012/index.html
    # custom port:  node scripts/build-web.mjs --watch --serve --port=3000
    # open http://localhost:8012

To publish the app's static output (not the npm package), run:

    npm run dist:web       # copies web/{index.html,btlib10x.js,btlib10x.jsonl,bt10x.js,VISION.md,favicon.ico} → dist/web/
    npm run dist:standalone  # dist/standalone/bt10x.html (self-contained: engine + app + catalog embedded; works from file://)
    # (multi-file dist/web/ must still be served over HTTP: the app fetches btlib10x.jsonl at boot)
