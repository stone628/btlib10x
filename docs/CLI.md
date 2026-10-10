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
    turn(1):move(team 2, mech cicada) >
    turn(1):attack(team 1, mech hunchy) >
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
| `dp` | doctrine player (see below): no argument lists assignments, doctrines and the trace level; `dp <id> <doctrine\|off>` assigns in setup only; `dp setup 2\|4` builds a random doctrine-vs-doctrine setup (empty setup only); `dp go` lets it act at the current prompt; `dp why [id]` reprints a unit's last decision; `dp trace off\|brief\|full` sets how much reasoning is shown |
| `autoplay` | hidden demo driver (not listed by `help`): resets nothing itself but expects a blank slate — run `reset` first. Prints a notice, then on a short timer (`AUTOPLAY_INTERVAL_MS` in `web/autoplay.ts`) types the next command a demonstrator would: loads `quickstart`, places HBK-4G vs CDA-3MA adjacent, starts, then walks in place and fires every working weapon each turn until victory. Any manually typed command cancels it; it prints `autoplay finished.` when the battle ends |

### setup

| command | effect |
|---|---|
| `map <name>` | load a bundled map as terrain (`beginner`, `quickstart`, `test`, `testground`) |
| `add <id> <model> <col> <row> [facing]` | place unit (team auto-assigned to smallest team; default gunnery `4`, piloting `5`, facing `n`) |
| `set <id> <prop> <value>` | edit a property on a unit already on the roster (`model`, `team`, `col`, `row`, `facing`, `gunnery`, `piloting`, `pilotHitMax` (integer >= 1, default 6), `ammoPolicy` (`exposed` default, `core`, `spread`, `least-first`; case-insensitive, hyphens optional), `autoEject` (`on` default / `off`: TO:AR p. 165 auto-eject; off means losing the head, or the center torso to an ammo/weapon blast, kills the pilot, TW p. 128); property names are case-insensitive; cannot modify `id`) |
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
| `mode startup` | declare a voluntary startup attempt (shut-down unit only). `done` rolls 2D6 against the heat shutdown avoidance number: success brings the unit online at once (the startup is its movement for the turn, it keeps the attack phase); failure keeps it shut down. `done` alone (without `mode startup`) passes — the unit stays off-line |
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
| `punch` / `kick` / `club` / `strike` / `pickup` / `drop` | physical attacks and club handling, see "Implemented subset: physical attacks" below |
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

**Random setup.** `dp setup 2|4` fills an empty setup (no map, no units; otherwise it
says which is already set and asks for `reset`) through the setup API directly
(`setupSetMap` / `setupAddUnit`): a random catalog map, then per player a random catalog
'Mech on a random dry, non-building hex with a random facing, and a random doctrine. It
prints one line for the map and one per player (`A1: HBK-4G at (14,2) facing s, team 1,
doctrine Jump Jockey`). Ids are `A1 B1 A2 B2`; teams alternate, so players split evenly
into teams 1 and 2. Draws come from a stream salted off the setup seed
(`web/doctrine.setup.ts`): the same `seed` gives the same setup, and the battle dice are
untouched. Then `start` plays the whole bout.

Doctrines (`web/doctrine.data.ts`): `alpha` (Alpha Striker), `longtom` (Long Tom),
`jumpjockey` (Jump Jockey), `hulldown` (Hull-Down), `pitfighter` (Pit Fighter),
`gladiator` (Gladiator), `dispossessed` (Dispossessed). Heat ceilings Cold 4 /
Warm 7 / Hot 9 / Redline 13 / Overdrive 30 sit one point under a Heat Scale step
(TW pp. 159–160). Ammo discipline: Free (any TN) / Measured (TN ≤ 10) /
Conservative (TN ≤ 8, 25% reserve) / Miser (TN ≤ 7, 50% reserve, energy first).

- **Movement**: every reachable landing for standstill / walk / run / jump (jump
  only if the doctrine uses jump jets) is scored with the GDD §9.1 terms: range
  (expected damage at that hex, best torso twist, minus drift from the preferred
  distance), cover, tmm (TW p. 107), flank, melee,
  exposed (enemy expected damage), heat (over the ceiling) and crowd (Gladiator).
- **Attack**: per torso twist, a greedy weapon set by expected damage per heat,
  stopping at the heat ceiling and honouring the ammo discipline; adjacent
  punch / kick options are weighed against the weapons those limbs give
  up (opportunistic doctrines skip kicks above TN 8).
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

Behavior follows TW unless noted; only commands, engine names and deviations
are listed here. Rule text lives in the rulebook.

- **Units** — bipedal 'Mechs only (record-sheet 'Mechs in `data/mechs/`,
  see `docs/MTF.md` to add more). Front and rear armor are separate pools.
- **Movement** — walk, run, jump, standstill; terrain MP surcharges are
  data-driven (`src/data/terrain.data.ts`). Water hexes have a surface and a
  bed `depth` levels below; Minimum Movement (TW p.49) is `mode run`; one-leg
  'Mechs hop (`effectiveMovement`).
- **Line of sight / to-hit** — woods points, elevation ray and partial cover
  (including wrecks, TO) per TW; GATOR breakdown printed by `fire`. Water
  depth 2+ blocks targeting (`blocksTargeting`).
- **Firing arcs** — per-weapon mounting arcs and target-side attack
  direction; a boundary attack direction resolves to the defender's choice
  (front over side, never rear). `torso <front|left|right>` twists one hexside.
- **Weapons and ammo** — ballistic / energy / missile with cluster tables;
  streak weapons fire full tubes on a hit. Ammo depletes per bin under a
  per-unit policy set at setup (`set <id> ammoPolicy exposed|core|spread|leastFirst`).
  Multiple targets (TW p.108) are engine-only; the CLI fires at one target.
- **Damage and criticals** — hit location tables, transfer inward, arm
  blow-off, through-armor criticals, ammo and Gauss explosions, actuator /
  engine / gyro / sensor / cockpit effects. Buildings carry a CF and collapse
  to rubble.
- **Heat** — scale 0-30 plus overflow; the scale updates once in the heat
  phase (`unit.heatPending`). Shutdown, restart and ammo-explosion rolls read
  post-dissipation heat. `mode shutdown` / `mode startup` are voluntary;
  standing in water adds dissipation.
- **Piloting and falls** — PSR triggers, falls with Facing After Fall, seatbelt
  rolls, prone / stand-up (`mode standup|prone|turn|pronestill`), movement-entry
  PSRs for rubble, water and buildings.
- **Pilot** — damage, consciousness rolls (`pilotHitMax`, default 6), cockpit
  kills. Ejection and auto-eject are Tactical Operations (TO p.165), not TW:
  `mode eject`; the wreck blocks its hex and gives partial cover.
- **Battle flow** — initiative, sequential movement, attack phase (weapons
  and physical attacks in one activation, a playability merge), heat phase,
  victory check, rematch.

### Implemented subset: physical attacks (punch, kick, club, strike)

- **Commands** — in the attack phase: `punch|kick|club|strike <target>
  [left|right]`, `pickup [limb|tree|girder] [n]`, `drop`. `candidate` lists
  legal options; `status` shows queued declarations.
- **Resolution** — weapons first, then a PSR sweep, then physical attacks
  against post-weapon state, then a physical sweep (the 20-point trigger
  never pools weapon and physical damage). Triple-Strength Myomer (TW p.143)
  is supported (e.g. CN9-YLW2). No physical attack displaces a unit.
- **Club hands** — picking up, holding and swinging need both arms standing
  with intact hand actuators (`clubHandsFunctional`). Losing either drops the
  club in place (checked after attacks, heat and falls); a destroyed shoulder
  only bars the swing. A fall, drop to prone or leaving play also drops it.
- **Club sources** — severed limb (including limbs sheared by damage), dropped
  club, tree (woods) or girder (rubble 2D6 7+/6+/5+). A picked-up limb is no
  longer `salvageable`. The `board` marks hexes holding a club token with `!`.
- **Charge / DFA** — declared by movement: `place` on an enemy hex in
  `walk`/`run` (charge) or `jump` (DFA). The unit stops in the hex before the
  target and the attack resolves in the physical phase. House rules: charge
  damage counts the target hex as one more hex moved; if the target moved away
  the attacker advances into the vacated hex. Not modeled: charging buildings,
  displacement.
- **Deferred** — industrial-tool physical weapons and the optional Punch/Kick
  table election (+4).

### Not yet implemented

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

- **Displacement** (push, domino effect, pavement skidding, charge / DFA
  displacement; TW pp.62, 147, 151-153) — intentionally not implemented, for
  simpler play (`docs/VISION.md` §2.5). A failed running skid falls in place.
  All falls (combat PSRs, shutdowns, stand-up attempts, building crashes,
  accidental falls from above) happen in place; only ground-movement falls
  across levels use the `levelsFallen` term (lower-hex rule). A faller
  landing on an occupied hex stays in the hex it came from. Charge / DFA
  are implemented without displacement (see above).
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
                         context + decide(), `dp` command + synchronous driver,
                         `dp setup` random setup
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
