# CLI.md — btlib10x Terminal Web App

Single-page web application exposing the btlib10x core through a stripped-down
terminal emulator UI. Vanilla TypeScript + DOM only; zero runtime dependencies
(honors AGENTS.md). Bundled with esbuild (dev-only).

## Prompt

    {game_state}[:sub_state] >

- `game_state`: `setup` | `turn` | `over`
- `sub_state` (only during `turn`): `(N):move(team T, mech ID)` during engine
  phase `movement`, `(N):attack(team T, mech ID)` during `weaponAttack` —
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
  `seed <n>` changes it at any time. Same seed ⇒ identical battle replay.
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
| `board` | ASCII grid (styled spans from `createBoardModel(BoardRenderInfo)`), sized from loaded map's width×height; with no map loaded, explains how to load one. Rendered as styled spans in a `.board` block: terrain glyphs on the grid rows and team-colored unit ids (id characters only, via `idStyles`); font family, size and line spacing come from the `--font-board` / `--board-fs` / `--board-lh` CSS variables and each terrain's scheme from the `--t-*` variables in `web/index.html` |
| `clear` | clear the scrollback screen |
| `log [n]` | last n events (default 10) |
| `info mech` | list available 'Mechs |
| `info mech <model>` | sheet summary: walk/run/jump ratings, weapons, and the 3-row critical slot chart (right arm / head / left arm, right / center / left torso, right / left leg); web CLI renders the chart as a mouse-click-collapsible block |
| `info map` | list available maps |
| `info map <name>` | map info: width×height, terrain types and counts, elevation counts, ASCII map with terrain glyphs |
| `reset` | wipe everything back to empty setup |
| `ver` | show the built library version (`YYMMDD-<git hash>` stamp of the bundled commit) |
| `autoplay` | hidden demo driver (not listed by `help`): resets nothing itself but expects a blank slate — run `reset` first. Prints a notice, then on a short timer (`AUTOPLAY_INTERVAL_MS` in `web/autoplay.ts`) types the next command a demonstrator would: loads `quickstart`, places HBK-4G vs CDA-3MA adjacent, starts, then walks in place and fires every working weapon each turn until victory. Any manually typed command cancels it; it prints `autoplay finished.` when the battle ends |

### setup

| command | effect |
|---|---|
| `map <name>` | load a bundled map as terrain (`beginner`, `quickstart`, `test`) |
| `add <id> <model> <col> <row> [facing]` | place unit (team auto-assigned to smallest team; default gunnery `4`, piloting `5`, facing `n`) |
| `set <id> <prop> <value>` | edit a property on a unit already on the roster (`model`, `team`, `col`, `row`, `facing`, `gunnery`, `piloting`; cannot modify `id`) |
| `rm <id>` | remove placed unit |
| `status` | setup summary: 'Mechs grouped by team, selected map name |
| `start` | ≥2 units on ≥2 teams required; creates battle, rolls initiative → `turn` |

### turn(N):move(team T, mech <id>)

The prompt names the acting unit; commands act on that 'Mech.

| command | effect |
|---|---|
| `mode standstill\|walk\|run\|jump` | declare movement mode (required first); for walk/run/jump, renders a clipped ASCII hex map of the reachable hexes — exactly the smallest bounding box around every reachable hex, clamped to the board (no padding). Reachable hexes draw a team-colored `<>` in the belly; every reachable (hex, facing) edge is tinted with the acting unit's team color, and no facing arrows are drawn. Other units inside the crop keep their ids (team-colored) but no facing arrow. Movement paths (the `F`/`B`/`R`/`L` fragment sequence per landing) remain available programmatically via `reachableLandings`/`RevealedLanding.path` for later use, but are not rendered on the map |
| `mode standup [walk\|run\|jump\|standstill]` | declare a stand-up attempt for a prone unit plus optional movement sharing one MP pool (stand costs 2; default `standstill` stands in place with no map; PSR with preexisting-damage modifiers, +1 heat; failure crashes back down for fresh falling damage and discards any queued `place`). Renders the reachable map for the named mode minus the stand cost, assuming the stand succeeds. `done` evaluates the stand first, then moves only on success — the activation ends either way; without a queued `place`, `done` just stands in place |
| `mode prone [turn\|pronestill]` | declare a voluntary drop to prone (no roll, no heat, no damage, costs 1 MP) plus an optional in-place turn sharing the walk budget (default `turn`: 1 MP per hexside, multiple turns allowed, +1 turn heat; `pronestill` drops in place with no map). Renders the turn map minus the drop cost. `done` drops first, then turns to the queued `place` (same hex) — without a `place`, `done` just drops in place |
| `mode turn` | turn in place while prone (prone unit only; 1 MP per hexside, multiple turns within the walk budget, +1 heat). `place` takes the same hex with a new facing; `done` commits |
| `mode pronestill` | stay prone (prone unit only; 0 MP, 0 heat). `place` stays unavailable; `done` ends the activation |
| `mode shutdown` | declare a voluntary shutdown (online unit only). `place` stays unavailable; `done` commits it — the unit goes off-line (`manual`) and can no longer move, fire, or act normally this turn. `cancel` resets the declaration |
| `mode startup` | declare a voluntary startup attempt (shut-down unit only). `done` rolls 2D6 against the heat shutdown avoidance number: success turns the unit `starting` (still off-line now, online just before the next initiative roll); failure keeps it shut down. `done` alone (without `mode startup`) passes — the unit stays off-line |
| `mode eject` | declare a pilot ejection (any non-removed unit, including a shut-down one). `place` stays unavailable; `done` commits it — the unit is marked removed (`pilotEjected`) and its hex becomes a permanent level-2 wreck. `cancel` resets the declaration |
| `place <col> <row> <facing>` | place the 'Mech at a final hex + facing in one step; `col row` are 1-based, `facing` is an absolute word (`n\|ne\|se\|s\|sw\|nw`). The (hex, facing) must be a reachable landing shown by `mode` (validated against the movement candidate); replaces any previously queued steps. Jump landing facing is chosen freely, so any facing at a reachable hex is legal for `jump` |
| `sheet [id]` | with id: armor diagram + weapons for a unit (plus the critical slot chart, which on `sheet <id>` marks per-slot live state with [J](jam) / [-](destroyed) / per-bin ammo `(n left)` markers); without id: brief unit list (id, model, position+facing) grouped by team |
| `status` | queued move steps with running MP cost per step |
| `cancel` | clear mode + steps |
| `done` | commit posture-change first, then move only on success (`attemptStandUp`/`dropProne` then `executeMove` in one atomic commit; failed stand discards queued `place`); prints path + MP spent (posture cost folded in) and full budget |

Shut-down units (including `starting`) act **first** in the movement phase,
regardless of initiative: the log prints
`{id} has movement priority — shut down, must attempt startup or pass`, and the
only move-phase commands available to them are `mode startup` (or `done` to
pass), plus `cancel`, `sheet`, `status`, `heat` and the globals.

### turn(N):attack(team T, mech <id>)

| command | effect |
|---|---|
| `ammo [policy]` | show (no argument) or set the acting unit's ammo depletion policy: `exposed` (default), `core`, `spread`, `least-first` (case-insensitive, hyphens optional). The policy picks which bin of a weapon takes the next shot; ties are broken at random |
| `fire <targetId> <weapon> [<weapon> ...]` | queue weapon declarations using 1-based weapon numbers (target first; declare several weapons at once, all against the one shared target; rapid-fire SRM/LRM fire a full volley — no `shots` argument). A prone attacker fires at +2, cannot fire leg-mounted weapons, and must draw the whole volley from one prop side (left-arm and right-arm weapons cannot mix — the suggestion shows both prop-left and prop-right sets; firing an arm set props the other arm) |
| `sheet [id]` | with id: armor diagram + weapons for a unit (plus the critical slot chart, which on `sheet <id>` marks per-slot live state with [J](jam) / [-](destroyed) / per-bin ammo `(n left)` markers); without id: brief unit list (id, model, position+facing) grouped by team |
| `status` | queued attack declarations |
| `cancel` | clear declarations |
| `done` | `declareAttacks` + `resolveAllAttacks` (simultaneous — every unit's declared shots resolve, even units killed that phase); prints per-weapon GATOR to-hit line, dice, cluster hits, damage by location |

### over

| command | effect |
|---|---|
| `sheet [id]` | with id: armor diagram + weapons for a unit (plus the critical slot chart, which on `sheet <id>` marks per-slot live state with [J](jam) / [-](destroyed) / per-bin ammo `(n left)` markers); without id: brief unit list (id, model, position+facing) grouped by team |
| `rematch` | new battle, same roster + terrain + seed |
| globals | `board`, `log` remain available; `reset` returns to empty setup |

## Status — BattleTech Total Warfare rule coverage

The engine implements a **subset of BattleTech Total Warfare rules** for
**bipedal 'Mechs only**. The terminal app exposes everything the engine can
simulate. See `docs/TODO.md` for the roadmap toward a fuller ruleset.

### Implemented

- **Units** — bipedal 'Mechs only (ten record-sheet 'Mechs in `data/mechs/`:
  AS7-D, CDA-3MA, ENF-4R, GRF-1N, HBK-4G, HER-5SA, MC-MKII-2, TW-Prime,
  WHK-Prime, WVR-6R; see `docs/MTF.md` to add more).
  Front and rear armor are separate pools; internal structure is derived from
  tonnage on the standard TW table.
- **Movement** — walk, run, jump, standstill. MP costs include the base 1 MP
  to enter a hex plus a terrain surcharge (data-driven from
  `src/data/terrain.json`; e.g. lightWoods +1, heavyWoods +2, rough/rubble +1,
  water2/3 +3, buildings +1/+2/+3/+4, pavement +0), +1 MP per
  level of elevation changed (up or down), and 1 MP per
  hexside of facing change. Ground moves step straight ahead or back; run
  cannot move backward; forward steps may change level by at most 2 per hex
  and backward steps cannot change level at all. Jump steps into any adjacent
  hex at 1 MP per step, with the landing facing chosen freely; jump ignores
  elevation. Water depth-change movement cost is deferred (see below).
- **Line of sight** — intervening-hex line trace; light/heavy woods points
  (1/2) accumulate along the line and ≥ 3 points block. A real-valued
  "ray height" is drawn between attacker and target LOS levels (hex
  level + 1 for a bipedal 'Mech); an intervening hex blocks when its own
  LOS level meets or exceeds the ray's height at the hex's center. Water
  depth 2+ (water2/water3) blocks firing into and out of the hex
  (`blocksTargeting`).
- **To-hit (GATOR)** — gunnery + attacker movement + target movement + range
  bracket + intervening terrain + weapon mod + minimum range penalty; auto-hit ≤
  2, auto-miss > 12. Target-terrain modifier is data-driven
  (`terrainTargetMod`): lightWoods/heavyWoods +1/+2. A shut-down 'Mech (or
  one with both legs destroyed) is immobile and applies a flat −4 target
  modifier instead of a movement band.
  **Partial cover (TW)** — a target standing in a water1 or building hex is
  in partial cover while the attacker's ground level is not higher than the
  target's: +1 to-hit (folded into `terrainMod`) and a hit-location roll
  that lands on a leg strikes the cover instead (no damage to the target).
  A target adjacent to a level-2 'Mech wreck is in partial cover for
  +2 to-hit while the attacker's ground level is below the wreck's top
  (hex level + 2); the larger of the terrain and wreck values applies, and
  the leg-strike miss rule holds under either.
  A downhill attacker (higher ground level) negates the target's cover.
- **Terrain catalog** — 13 core-rulebook terrain types (`clear`, lightWoods,
  heavyWoods, rough, rubble, pavement, water1, water2, water3, and four
  building classes) defined in `src/data/terrain.json` and validated by
  `terrain.schema.ts`. Move surcharge, screening value, target modifier,
  partial-cover flag, and targeting-restriction flag all live in the catalog.
- **Buildings** — building hexes carry a structural factor (CF) initialized
  from the sub-type (light 15 / medium 40 / heavy 90 / hardened 120).
  Each weapon grouping that hits a unit inside costs the hex ceil(CF at
  phase start / 10), applied after all weapons fire (`damageBuildingAt`);
  when CF reaches 0 the hex collapses to rubble and a `buildingCollapsed`
  event fires. Collapse damage is ceil(CF/10 x (1 + levels above)) in
  5-point punch-table groups, plus standard falling damage above Level 0.
  Unit damage from a collapse is deferred with piloting.
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
  `rearFacing` torso mounts rear-only); the target-side attack direction
  (TW p.119) picks the hit-location column (front/left/right share one
  per-arc table, rear shares the front column) and the armor pool (rear
  torso pool for rear-direction torso hits). Exact arc-boundary lines admit
  both arcs for firing; attack direction resolves to the defender's dominant
  choice (front over side, never rear). The web fire-suggestion header shows
  the target's firing arc, and the attack-resolution hit line names the
  attack direction it resolved against.
- **Weapons** — ballistic / energy / missile with short/medium/long range
  brackets, rapid-fire, weapon to-hit mods (−2 pulse, +1 MRM / Clan heavy
  lasers), per-bin ammo tracking, jam on
  natural 2 (multi-shot), LRM lots-of-5 grouping. Ammo is depleted per
  crit slot ("bin") under a per-unit policy set with `ammo <policy>`:
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
  are terminal).   Effects implemented: weapon destroyed, ammo explosion
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
- **Heat** — heat scale 0-30 with movement heat, weapon heat, posture heat
  (stand-up, prone-turn), and engine-crit heat. Per TW p.159 the scale
  updates once at the heat phase: own heat generated during the movement
  and weapon attack phases accumulates into `unit.heatPending` (does not
  touch the scale mid-turn — weapon to-hit this turn reads the previous
  turn's end value), then lands on the scale, dissipation subtracts, and
  the result is the new `unit.heat`. Shutdown/restart and ammo-explosion
  checks read `max(startHeat, endHeat)` — the worst the scale reached at
  any discrete read; peak within the heat phase has no separate meaning.
  Heat-caused shutdown auto-fires at 30+ (initial only; restart at 30+ is
  a roll — roll 12 succeeds). 2D6 avoidance runs at 14, 18, 22, 26 with
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
- **Voluntary shutdown / startup** — `mode shutdown` + `done` sends an
  online unit off-line (`manual`); it persists (no end-phase auto-restart)
  until a voluntary startup succeeds. `mode startup` + `done` rolls 2D6
  against the shutdown avoidance: success → `starting` (still off-line,
  online just before the next initiative roll), failure → stays off-line.
  Shut-down units act first in the movement phase regardless of initiative.
- **Pilot ejection / wrecks** — `mode eject` + `done` marks the unit
  removed (`removed = "pilotEjected"`; destroyed stays `"not"`; counts toward
  victory; skipped by the actor queue and by occupancy checks) and spawns a
  **level-2 wreck** in its hex. A
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
  unit. A reactor shutdown (heat or voluntary) forces an immediate +3 PSR;
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
   levels drops into the lower hex; jump-phase falls count 0 levels), and
   the pilot then
  makes a seatbelt PSR (+5 off a destroyed leg, +6 off a destroyed gyro, or
  the failed roll's modifiers, plus +1 per level above 1 fallen) or takes
  1 hit — automatic when the 'Mech is
  immobile or the target exceeds 12. Prone units stand up with `mode
  standup <walk|run|jump>` (one attempt per activation sharing one MP pool,
  stand costs 2, +1 heat; failure crashes back down for fresh fall damage and
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
  every point forces a consciousness roll (1→3+, 2→5+, 3→7+, 4→10+, 5→11+)
  taken before any simultaneous PSR. A failed roll knocks the pilot out:
  the unit cannot act and counts as immobile until it wakes in a later end
  phase; six total hits kills the pilot and removes the unit
   (`removed = "pilotKilled"`, destroyed stays `"not"`), leaving a level-2
   wreck like an eject. Cockpit
   destruction still kills outright.
- **Movement-entry PSRs** — entering rubble (+0) or water (depth 1: −1,
  depth 2: +0, depth 3+: +1) and entering a building hex (light +0 /
  medium +1 / heavy +2 / hardened +5) forces a PSR (plus preexisting
  damage); a failed water/rubble roll falls the 'Mech in the entered hex
  (jump checks the landing only), while a failed building roll crashes it
  for `ceil(CF / 10)` front-column damage without falling — unless the crash
  wrecks a leg/gyro or knocks the pilot out, which drops the 'Mech on the
  spot. Exiting a building hex requires no PSR.

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
- **Resolution** — after all weapon attacks in `resolveAllAttacks`
  (TW p. 37 order): punch damage 1/10 t on the Punch table, kick 1/5 t
  on the Kick table, club 1/5 t on the standard table, strike per weapon
  (hatchet 1/5 t, sword 1/10 t +1, blade 1/10 t) on the standard table,
  push no damage with target displacement + attacker advance. Kick forces a
  target PSR (plus an attacker PSR on a miss); push forces both sides' PSRs.
  Head hits injure the pilot as usual. A crit on any slot of a mounted
  physical weapon destroys it (the HCT-5S Hatchetman now ships its hatchet).
- **Deferred** — charge / DFA (movement-phase declarations), club
  acquisition (blown-off limbs, trees, girders), the remaining nine
  physical-weapon types (industrial tools), TSM doubling, the optional
  Punch/Kick-table election (+4) and level-difference auto-swap,
  critical hits from physical damage, domino effect /
  accidental falls from above.

### Not yet implemented

- **Charge / DFA physical attacks**.
- **Physical-attack critical hits** — physical damage transfers armor /
  structure and can destroy locations, but rolls no determining crits yet
  (weapon-attack crits are fully implemented).
- **Water depth movement** — level-change MP surcharge when entering water
  (the water-entry PSR itself is implemented above).
- **Torso twist** — per-weapon facing override that shifts a unit's firing
  arcs during the attack phase (currently only the positional facing is
  used).
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
- **One-legged hopping movement** (TW p.122: walk 1 MP, no run, jump with PSR
  each landing) — `effectiveMovement` caps a standing one-leg 'Mech at
  `walking: 1, running: 0`; jump MP unchanged. A prone one-leg 'Mech may
  turn 1 hexside/turn. Standing attempt at +5 PSR (consumes the 1-MP walk
  budget). The +5 seatbelt PSR after a leg-destroying hit is rolled
  normally; only the truly immobile case (both legs AND both arms) takes
  the auto-pilot-damage shortcut.
- **Four-legged / vehicle PSR rows** (quads, skidding vehicles,
  sideslipping VTOLs) — bipedal 'Mechs only (top of this section).
- **Drowning / underwater life-support pressure** — water blocks targeting
  at depth 2+ and halves falls, but breath-holding and hull-breach pressure
  belong to the deferred water-depth movement rules.

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
    web/session.weapon.ts  weapon-attack phase: fire queue, validation, torso twist, ammo policy, resolve
    web/session.setup.ts   setup phase: map, add/set/rm units, status, start
    web/session.over.ts    over state: rematch, status
    web/chunk.ts       structured output chunks: lines, board, columns, collapsible
    web/rng.ts          mulberry32-seeded Rng
    web/render.ts       structured BoardModel / Span model + boardToText / boardToSpans
    scripts/build-web.mjs  esbuild bundles: src/index.ts → web/btlib10x.js (core),
                         web/main.ts → web/app.js (app; btlib10x.js kept external)

Import wrinkle: tsc-emitted `.json` imports are not loadable by browsers, so the
app ships as an esbuild single-file bundle instead of consuming `dist/` directly.
Library sources stay untouched.

## Build, run, and ship

    npm install            # picks up esbuild devDependency
    npm run build:web      # one-shot esbuild bundle → web/btlib10x.js + web/app.js
    npm run dev:web        # watch + serve: rebuilds on change, serves at http://127.0.0.1:8012/index.html
    # custom port:  node scripts/build-web.mjs --watch --serve --port=3000
    # open http://localhost:8012

To publish the app's static output (not the npm package), run:

    npm run dist:web       # copies web/{index.html,btlib10x.js,app.js,favicon.ico} → dist/web/
    npm run dist:standalone  # one fully self-contained dist/standalone/bt10x.html
    # (bundles core + app into the HTML; copy that single file anywhere and open it in a browser)
