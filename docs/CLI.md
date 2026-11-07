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
  `drive()` in `web/terminal/session.ts` feeds `checkSessionVictory` as stopper into
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
| `lang [<locale>]` | show or switch output language (`en`, `ko`; `kr` aliases `ko`); session-scoped, survives reset/rematch, defaults to `en` |
| `board` | ASCII grid (styled spans from `createBoardModel(BoardRenderInfo)`), sized from loaded map's width×height; with no map loaded, explains how to load one. Rendered as styled spans in a `.board` block: terrain glyphs on the grid rows and team-colored unit ids (id characters only, via `idStyles`); a bold `!` (`t-club`, `--club`) at the bottom-left interior slot (`\!w0 /`) marks a hex holding a ground club token (`state.clubs`; terrain-derived trees/girders are not marked) and adds a legend entry; font family, size and line spacing come from the `--board-ff` / `--board-fs` / `--board-lh` CSS variables and each terrain's scheme from the `--t-*` variables in `web/terminal.css` |
| `clear` | clear the scrollback screen |
| `log [n]` | last n events (default 10) |
| `info mech [text] [key:value ...] [!]` | search the 'Mech catalogs (base pack + SW season pack; the roster table shows each entry's `pack`): plain words are a case-insensitive substring match on model, chassis and Clan name; filters AND together: `class:l\|m\|h\|a` (comma list, unambiguous prefix of light/medium/heavy/assault), `ton:70` / `ton:60-75` / `ton:>=80` (also `<`, `<=`, `>`), `tech:is\|clan`, `intro:3025` / `intro:3000-3060` / `intro:>=3050` (same numeric forms as `ton:`), `pack:base\|sw`, `sort:[-]ton\|name\|model\|intro` (default tonnage, then name). Filters read the catalog manifest only (model, chassis, Clan name, tech base, tonnage, intro year, pack). Up to 20 matches print the model table (model, name, tonnage, class, tech base, intro, pack); more print one row per chassis (tonnage, name, variant count, models; collapsible in the web CLI, expanding to the variant table) while there are at most 20 chassis; beyond that, counts by class (or by tonnage when all matches share a class). A trailing `!` prints the full table. A single match opens its sheet; when it came from a search or filter rather than an exact model key, a line above the sheet names the one matching model. No match on plain text suggests up to 5 closest model keys (also for `add`). A model present in both packs resolves to the SW sheet (`base` always loses); `pack:base` lists the surviving base-only sheets |
| `info mech <model>` | sheet summary: walk/run/jump ratings, weapons, and the 3-row critical slot chart (right arm / head / left arm, right / center / left torso, right / left leg); web CLI renders the chart as a mouse-click-collapsible block |
| `info map` | list available maps |
| `info weapon [name \| text] [key:value ...] [!]` | an exact name (or a single match, with a line naming it when it was not an exact case-insensitive name) shows that weapon's stats; otherwise search the weapon catalog by name substring with filters `cat:ballistic\|energy\|missile\|equipment` (unambiguous prefix, comma list), `tech:is\|clan` (Clan = `CL ` name prefix), `heat:`, `range:` (long range), `dmg:` (best-case damage: best variable bracket or full missile salvo), same numeric forms as `ton:`, and `sort:[-]cat\|name\|heat\|range\|dmg` (default catalog order). Up to 20 matches print stat lines (grouped by category in catalog order); more print names only, one line per category. A trailing `!` prints every stat line. No match on plain text suggests up to 5 closest names |
| `table [cluster\|hitloc\|crit\|heat]` | print a reference table (no argument lists them) |
| `info map <name>` | map info: width×height, terrain types and counts, elevation counts, ASCII map with terrain glyphs |
| `reset` | wipe everything back to empty setup |
| `ver` | show the terminal and engine versions (each a `YYMMDD-<git hash>` stamp of the last commit touching its own files; see "Versioning" in `AGENTS.md`) |
| `pp` | persona player (see below): no argument lists assignments, personas and the trace level; `pp <id> <persona\|off>` assigns in setup only; `pp setup 2\|4` builds a random persona-vs-persona setup (empty setup only); `pp go` lets it act at the current prompt; `pp phase <persona>` lets a persona play a hand-played unit's current phase only; `pp why [id]` reprints a unit's last decision; `pp trace off\|brief\|full` sets how much reasoning is shown |
| `autoplay` | hidden demo driver (not listed by `help`): resets nothing itself but expects a blank slate — run `reset` first. Prints a notice, then on a short timer (`AUTOPLAY_INTERVAL_MS` in `web/terminal/autoplay.ts`) types the next command a demonstrator would: loads `quickstart`, places HBK-4G vs CDA-3MA adjacent, starts, then walks in place and fires every working weapon each turn until victory. Any manually typed command cancels it; it prints `autoplay finished.` when the battle ends |

### setup

| command | effect |
|---|---|
| `map <name>` | load a bundled map as terrain (`beginner`, `quickstart`, `test`, `testground`) |
| `add <id> <model> <col> <row> [facing]` | place unit (team (1 or 2) auto-assigned to the smaller team; default gunnery `4`, piloting `5`, facing `n`) |
| `set <id> <prop> <value>` | edit a property on a unit already on the roster (`model`, `team` (1 or 2), `col`, `row`, `facing`, `gunnery`, `piloting`, `pilotHitMax` (integer >= 1, default 6), `ammoPolicy` (`exposed` default, `core`, `spread`, `least-first`; case-insensitive, hyphens optional), `autoEject` (`on` default / `off`: TO:AR p. 165 auto-eject; off means losing the head, or the center torso to an ammo/weapon blast, kills the pilot, TW p. 128), `heatFlamer` (`on` default / `off`: on, the unit's flamers apply their Damage Value as heat instead of damage, TW p. 303; `status` shows `flamer-heat off` only when off), `amsPolicy` (`expected` default / `first-hit` / `priority` / `off`, case-insensitive, hyphen optional: which hitting missile attack the unit's AMS engage, TW p.129; `status` shows `AMS <policy>` only when not `expected`); property names are case-insensitive; cannot modify `id`; in battle the acting unit changes these four with `policy`) |
| `seed <n>` | set the dice seed (setup only; a battle in progress keeps its generator) |
| `rm <id>` | remove placed unit |
| `status` | setup summary: 'Mechs grouped by team, selected map name |
| `start` | ≥2 units covering teams 1 and 2 required; creates battle, rolls initiative → `turn` |

### turn(N):move(team T, mech <id>)

The prompt names the acting unit; commands act on that 'Mech.

| command | effect |
|---|---|
| `mode standstill\|walk\|run\|jump` | declare movement mode (required first); for walk/run/jump, renders a clipped ASCII hex map of the reachable hexes — exactly the smallest bounding box around every reachable hex, clamped to the board (no padding). Reachable hexes draw a team-colored `<>` in the belly; every reachable (hex, facing) edge is tinted with the acting unit's team color, and no facing arrows are drawn. Other units inside the crop keep their ids (team-colored) but no facing arrow. Movement paths (the `F`/`B`/`R`/`L` fragment sequence per landing) remain available programmatically via `reachableLandings`/`RevealedLanding.path` for later use, but are not rendered on the map |
| `mode standup [walk\|run\|standstill]` | declare a stand-up attempt for a prone unit plus optional movement sharing one MP pool (stand costs 2; default `standstill` stands in place with no map; PSR with preexisting-damage modifiers, +1 heat; failure crashes back down for fresh falling damage and discards any queued `place`). Renders the reachable map for the named mode minus the stand cost, assuming the stand succeeds; the 'Mech may leave in any facing, and that turn shows as 0 MP (TW p.50). `done` evaluates the stand first, then moves only on success — the activation ends either way; without a queued `place`, `done` just stands in place |
| `mode prone [turn\|pronestill]` | declare a voluntary drop to prone (no roll, no heat, no damage, costs 1 MP) plus an optional in-place turn sharing the walk budget (default `turn`: 1 MP per hexside, multiple turns allowed, +1 turn heat; `pronestill` drops in place with no map). Renders the turn map minus the drop cost. `done` drops first, then turns to the queued `place` (same hex) — without a `place`, `done` just drops in place |
| `mode turn` | turn in place while prone (prone unit only; 1 MP per hexside, multiple turns within the walk budget, +1 heat). `place` takes the same hex with a new facing; `done` commits |
| `mode pronestill` | stay prone (prone unit only; 0 MP, 0 heat). `place` stays unavailable; `done` ends the activation |
| `mode shutdown` | declare a voluntary shutdown (online unit only). `place` stays unavailable; `done` commits it — the unit goes off-line (`manual`) and can no longer move, fire, or act normally this turn. `cancel` resets the declaration |
| `mode startup` | declare a voluntary startup attempt (shut-down unit only). `done` rolls 2D6 against the heat shutdown avoidance number: success brings the unit online at once (the startup is its movement for the turn, it keeps the attack phase); failure keeps it shut down. `done` alone (without `mode startup`) passes — the unit stays off-line |
| `mode eject` | declare a pilot ejection (any non-removed unit, including a shut-down one; the emergency exit, with the ejection roll). `place` stays unavailable; `done` commits it — the unit is marked removed (`pilotEjected`) and its 'Mech stays on the board as a hull (see below). `cancel` resets the declaration |
| `mode abandon` | declare a voluntary abandonment (house rule adapted from TO:AR p.165; a unit shut down since an earlier turn — `mode shutdown` first, abandon next turn — or a heat shutdown). No roll, no pilot hits: `done` marks the unit removed (`pilotAbandoned`) and its 'Mech stays as a hull in the posture it stood in. `cancel` resets the declaration |
| `place <col> <row> <facing>` | place the 'Mech at a final hex + facing in one step; `col row` are 1-based, `facing` is an absolute word (`n\|ne\|se\|s\|sw\|nw`). The (hex, facing) must be a reachable landing shown by `mode` (validated against the movement candidate); replaces any previously queued steps. Jump landing facing is chosen freely, so any facing at a reachable hex is legal for `jump` |
| `sheet [id]` | with id: armor diagram + weapons for a unit (plus the critical slot chart, which on `sheet <id>` marks per-slot live state with [J](jam) / [-](destroyed) / per-bin ammo `(n left)` markers); without id: brief unit list (id, model, position+facing) grouped by team |
| `heat [id]` | heat scale status of a unit (default: the acting unit); also available in the attack phase |
| `policy [<prop> <value>]` | show (no argument) or change one policy of the acting unit: `ammoPolicy`, `autoEject`, `heatFlamer` or `amsPolicy`, same names, values and errors as `set` (other properties are rejected). Takes effect at once (ammo is drawn at this unit's `done`, flamer heat mode and the AMS choice apply at this attack phase's resolution, auto-eject at the next head / center torso loss); `cancel` keeps it, `rollback` undoes it. Only the acting unit, so other units' declared shots never change. Recorded in the replay as a `P` record. Movement and attack phases only |
| `candidate` | list attack candidates, also printed when a unit becomes the attacker. `weapon attacks` has one group per torso twist (`twist right, by "torso right"`; only the current twist once prone or locked), one block per target, and one line per fireable weapon with TN, 2D6 hit chance, damage, heat and its `fire` command. Weapons that cannot fire are not shown, nor is equipment (TAG, AMS, physical weapons: not fireable); once a fire is queued only that target remains. `physical attacks` (only when an enemy is adjacent) lists each legal punch, both punches, kick, club and strike per target with TN, hit chance, damage and the commands, a needed twist first |
| `status` | queued move steps with running MP cost per step |
| `cancel` | clear mode + steps |
| `rollback` | undo the last completed `done`: back to the previous actor's prompt (half-declared input is discarded; dice state and replay log are restored too). At most `MAX_SNAPSHOT_COUNT` (10) prompt snapshots are kept (`web/terminal/rollback.ts`); no redo |
| `done` | commit posture-change first, then move only on success (one `executePostureMove` call in one atomic commit; the engine holds the shared MP pool; failed stand discards queued `place`); prints path + MP spent (posture cost folded in) and full budget |

Shut-down units (including `starting`) act **first** in the movement phase,
regardless of initiative: the log prints
`{id} has movement priority — shut down, must attempt startup or pass`, and the
only move-phase commands available to them are `mode startup` (or `done` to
pass), plus `cancel`, `sheet`, `status`, `heat`, `policy` and the globals.

### turn(N):attack(team T, mech <id>)

| command | effect |
|---|---|
| `torso <front\|left\|right>` | twist the acting unit's torso one hexside (TW pp.105-106): arm and front-torso weapons fire into the twisted arc; locked once a `fire` is queued |
| `candidate` | show possible targets with available weapons (also printed when a unit becomes the attacker). A target no weapon can reach collapses to one line with the reason (`no weapon in arc`, `out of range`, …); blockers that do not depend on the target (jammed, destroyed, out of ammo, sensors, prone) print once as `unavailable:`; the twist line shows only when twisted, and `torso <dir> opens: …` names weapons another twist would add; the physical section appears only when an enemy is adjacent |
| `fire <targetId> <weapon> [<weapon> ...]` | queue weapon declarations using 1-based weapon numbers (target first; declare several weapons at once, all against the one shared target; rapid-fire SRM/LRM fire a full volley — no `shots` argument). A prone attacker fires at +2, cannot fire leg-mounted weapons, and must draw the whole volley from one prop side (left-arm and right-arm weapons cannot mix — the suggestion shows both prop-left and prop-right sets; firing an arm set props the other arm) |
| `sheet [id]` | with id: armor diagram + weapons for a unit (plus the critical slot chart, which on `sheet <id>` marks per-slot live state with [J](jam) / [-](destroyed) / per-bin ammo `(n left)` markers); without id: brief unit list (id, model, position+facing) grouped by team |
| `punch` / `kick` / `club` / `strike` / `pickup` / `drop` | physical attacks and club handling, see "Implemented subset: physical attacks" below |
| `heat [id]` | heat scale status |
| `policy [<prop> <value>]` | show (no argument) or change one policy of the acting unit: `ammoPolicy`, `autoEject`, `heatFlamer` or `amsPolicy`, same names, values and errors as `set` (other properties are rejected). Takes effect at once (ammo is drawn at this unit's `done`, flamer heat mode and the AMS choice apply at this attack phase's resolution, auto-eject at the next head / center torso loss); `cancel` keeps it, `rollback` undoes it. Only the acting unit, so other units' declared shots never change. Recorded in the replay as a `P` record. Movement and attack phases only |
| `status` | queued attack declarations |
| `cancel` | clear declarations |
| `rollback` | undo the last completed `done`: back to the previous actor's prompt (half-declared input is discarded; dice state and replay log are restored too). At most `MAX_SNAPSHOT_COUNT` (10) prompt snapshots are kept (`web/terminal/rollback.ts`); no redo |
| `done` | `declareAttacks` + `resolveAllAttacks` (simultaneous — every unit's declared shots resolve, even units killed that phase); prints per-weapon GATOR to-hit line, dice, cluster hits, damage by location |

### over

| command | effect |
|---|---|
| `sheet [id]` | with id: armor diagram + weapons for a unit (plus the critical slot chart, which on `sheet <id>` marks per-slot live state with [J](jam) / [-](destroyed) / per-bin ammo `(n left)` markers); without id: brief unit list (id, model, position+facing) grouped by team |
| `salvage [id]` | the engine's `salvageReport`. Without id: a roster table of every hull and destroyed frame (kind, removal reason, hex, posture, wreckage left). With id: a unit line, then a `salvageables` column (intact weapons and equipment — heat sinks, jump jets, targeting computer — and stranded ammo, by location, unclaimed severed limbs marked `(severed)`) beside a `salvaged hull` column holding the `sheet` armor/structure diagram; wreckage shows the salvageables column only. Over phase only |
| `rollback` | return to the last battle prompt (the one before the game-ending `done`) |
| `rematch` | new battle, same roster + terrain + seed |
| globals | `board`, `log` remain available; `reset` returns to empty setup |

**Replay data.** While a battle is played the session records it in the compact
format of `docs/REPLAY.md` (`web/terminal/replay.ts`: header on `start`/`rematch`, one `M`/`A`
line per committed activation, rejected commands leave no trace). When the battle
ends, the victory banner is followed by a collapsed block *"you can replay this
match with this data"* holding the records laid out by `replayPrettifier`: version,
the setup line (`B…;S…`), one line per unit, then per turn one movement line and one
attack line (activations joined by `;`), the `W` line and one `E` line per unit. `rematch` starts a new
log; `reset` clears it and re-creates the dice generator from the seed. `replayPlayer(text)`
(`web/terminal/replay.ts`) replays such text and checks the winner, the final dice state and every
unit's end state; it throws a single error naming turn, phase and actor on the first problem. A match
that cannot be reproduced (more than 36 units, a unit id with
`:` `;` `,` or whitespace, a replaced dice generator) shows no block.

## Persona player (GDD §9)

A one-ply scoring player for units assigned a MechWarrior persona in setup
(`pp <id> <persona>`). The persona is a game-layer setting: it is not part of
`UnitInit` or the engine. Whenever `start`, `rematch` or `done` leaves the prompt
with a persona unit, the CLI plays it at once (no timer): it prints the
reasoning, then types the commands, each echoed as `<prompt> > <command>` and run
through the normal dispatch, so atomic commits, replay recording and rollback
snapshots all apply. A failed command stops it and hands the prompt to the human.
How each persona scores its options is described in [PERSONA.md](PERSONA.md).

**Random setup.** `pp setup 2|4` fills an empty setup (no map, no units; otherwise it
says which is already set and asks for `reset`) through the setup API directly
(`setupSetMap` / `setupAddUnit`): a random catalog map, then per player a random catalog
'Mech on a random dry, non-building hex with a random facing, and a random persona. It
prints one line for the map and one per player (`A1: HBK-4G at (14,2) facing s, team 1,
persona Jump Jockey`). Ids are `A1 B1 A2 B2`; teams alternate, so players split evenly
into teams 1 and 2. Draws come from a stream salted off the setup seed
(`web/terminal/persona.setup.ts`): the same `seed` gives the same setup, and the battle dice are
untouched. Then `start` plays the whole bout.

Personas (`web/terminal/persona.data.ts`): `alpha` (Alpha Striker), `longtom` (Long Tom),
`jumpjockey` (Jump Jockey), `hulldown` (Hull-Down), `pitfighter` (Pit Fighter),
`gladiator` (Gladiator), `dispossessed` (Dispossessed). Heat ceilings Cold 4 /
Warm 7 / Hot 9 / Redline 13 / Overdrive 30 sit one point under a Heat Scale step
(TW pp. 159–160). Ammo discipline: Free (any TN) / Measured (TN ≤ 10) /
Conservative (TN ≤ 8, 25% reserve) / Miser (TN ≤ 7, 50% reserve, energy first).

- **Movement**: every reachable landing for standstill / walk / run / jump (jump
  only if the persona uses jump jets) is scored with the GDD §9.1 terms: range
  (expected damage at that hex, best torso twist, minus drift from the preferred
  distance), cover, tmm (TW p. 107), flank, melee,
  exposed (enemy expected damage), heat (over the ceiling) and crowd (Gladiator).
- **Attack**: per torso twist, a greedy weapon set by expected damage per heat,
  stopping at the heat ceiling and honouring the ammo discipline; adjacent
  punch / kick options are weighed against the weapons those limbs give
  up (opportunistic personas skip kicks above TN 8).
- **Strategy memory** (per unit, across turns): committed target (switched only
  for a 1.5× better one), posture (approach / engage / hold / recover / yield),
  turns in contact, losses per turn, and a tally of enemy move modes.
- **Yield**: at the persona's armor + structure threshold (or with no weapons
  left for a Never-melee persona) it declares `mode eject`, standing in for the
  missing yield helper (GDD R6).
- **Hulls**: personas only target active units; abandoned enemy 'Mechs
  (hulls) and wreckage are never targeted, moved on or fired on.
  Autoplay retires a unit with nothing left to fight with (or stuck prone) by
  `mode shutdown`, then `mode abandon` the next turn.
- **Own RNG**: a separate stream seeded from the battle seed, used only for
  tie-breaks; deciding never moves the battle dice.
- **One phase**: `pp phase <persona>` at a battle prompt hands the acting
  unit to that persona for the current phase only (its movement or its
  attack): it decides and types the commands at once, then the persona
  prompts that follow are played as after `done`, and the unit's next prompt
  is the human's again. Persona-assigned units are refused. Instant Action
  offers the same through the Control dropdown of its command panels.
- **Rollback**: the persona context (memory, its RNG, last traces) is part of
  each prompt snapshot. A rolled-back persona prompt waits; `pp go` replays the
  identical decision, or the human can play the prompt by hand.

The reasoning prints in the attack-resolution box:

    [foe -> me]
         ┌ persona Jump Jockey · posture engage · target me (held 1)
         │ movement: 871 options scored · heat 0, ceiling 9
         │ #1 standstill (4,3) se  +8.0 = range +8.5 cover +2.0 exposed -2.5
         │ #2 run (4,10) s  +6.5 = range +7.0 tmm +3.6 flank +0.9 exposed -5.0
         │ #3 jump (1,7) s  +5.6 = range +2.0 tmm +3.6 flank +0.9 exposed -0.8
         │ chose #1 standstill (4,3) se; for range +8.5 cover +2.0; against exposed -2.5; lead +1.5 over #2
         └ commands: mode standstill; done

`brief` (default) lists the top three options, `full` adds the rest in a
collapsible block, `off` shows only the typed commands. The reachable-hex board
that `mode` prints is left out of persona output.

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
  per TW (units, hulls and wreckage never affect LOS or cover); GATOR
  breakdown printed by `fire`. Water depth 2+ blocks targeting
  (`blocksTargeting`).
- **Firing arcs** — per-weapon mounting arcs and target-side attack
  direction; on a hexside line woods, cover and the attack direction come
  from one chain picked for the defender (`docs/VISION.md` §2.2). `torso <front|left|right>` twists one hexside.
  A weapon split between an arm and a side torso (King Crab AC/20s) uses
  the torso arc (TW pp.105-106), ignores arm actuator to-hit damage, is
  destroyed by a critical in either location and stops firing when either
  location is lost; punching, clubs and prone propping still treat it as
  an arm weapon. The sheet shows it as `[RA/RT]`.
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
- **Heat-causing weapons (TW pp.113, 139, 159, 303)** — the flamer family
  (Flamer, ER Flamer, Heavy Flamer, IS and Clan) follows the firing unit's
  `heatFlamer` policy (`set <id> heatFlamer on|off`, default on): on, a hit
  deals its Damage Value as heat instead of damage; off, normal damage. The
  Plasma Rifle adds 1D6 heat to its 10 damage (the die is thrown after the
  damage and its crits), the Clan Plasma Cannon deals 2D6 heat and no damage.
  A heat-only hit rolls no hit location, so no critical and no damage PSR,
  and a building hex absorbs none of it. Heat lands as outside heat in the
  target's heat phase, capped at 15 per turn (excess wasted), shut down or
  not; it does not change this turn's to-hit or MP. `fire` is unchanged.
  ER and Heavy Flamer stats come from TechManual (not in TW). Not modeled:
  fire and smoke (TO:AR pp.41–46), infernos, plasma double damage against
  woods and buildings.
- **Anti-missile systems (TW pp.129-130)** — an AMS (or Laser AMS) engages
  one missile attack per turn that hits through an arc it covers: −4 on the
  Cluster roll (floor 2), a Streak counts as a roll of 11 first. AMS spends
  1 shot and 1 heat, Laser AMS 0 shots and 5 (Clan) / 7 (IS) heat. The
  defender's `amsPolicy` (`set <id> amsPolicy expected|first-hit|priority|off`,
  default `expected`) picks the attack; the engaged attack shows
  `Anti-Missile System −4 on cluster roll: 12 → 9 missiles` and the defender
  logs its heat and shots left. Torso twist turns torso AMS with it; a
  shut-down unit's AMS does nothing.
- **Piloting and falls** — PSR triggers, falls with Facing After Fall, seatbelt
  rolls, prone / stand-up (`mode standup|prone|turn|pronestill`), movement-entry
  PSRs for rubble, water and buildings. A building entry adds the building type
  and the hexes moved this turn (TW p.167); a failed roll crashes on the front,
  or the rear when backing in. Entering or falling in a building hex costs it
  tonnage / 10 CF, and a hex emptied that way collapses at once. A 'Mech
  cannot jump into a building hex (TW p.168; roofs are not modeled); it may
  jump out of or over one.
- **Pilot** — damage, consciousness rolls (`pilotHitMax`, default 6), cockpit
  kills. Ejection and auto-eject are Tactical Operations (TO p.165), not TW:
  `mode eject`. `mode abandon` (house rule) lets the pilot step out of a 'Mech
  shut down since an earlier turn.
- **Hulls (TO:AR pp.184–185)** — a 'Mech whose pilot ejected, died or
  abandoned it, frame intact, stays on the board as a neutral, permanently
  shut-down hull, drawn `-id`. Either side may target it (−4 immobile); any
  unit may pass or jump through its hex but none may stop there; walking or
  jumping onto it declares a charge or DFA. It never rolls a PSR: anything
  that would force one (20+ damage, leg or gyro loss, a kick or charge) drops
  it. It has no LOS or cover effect and counts as lost for its team.
- **Wreckage (TO:AR p.155)** — a destroyed 'Mech of 40 t or more (a destroyed
  hull included) turns its hex into Rough on top of the terrain: +1 MP, no
  PSR, no to-hit or LOS effect; an already-rough hex or one already holding
  wreckage stays as it is, and a standing building charges nothing until it
  collapses. The board marks it `%`. A 'Mech destroyed while standing first
  takes the salvage fall (TW p.128) on its record; a living MechWarrior still
  in the cockpit takes the fall's pilot hit and a consciousness roll, and an
  ejected pilot (auto-eject
  or a hull) takes none. `salvageReport` lists every hull and destroyed frame
  at battle end.
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
  target and the attack resolves in the physical phase. Charge damage is
  `ceil(tonnage / 10 × hexes moved)`, not counting the target's hex (TW p.148).
  Charging an adjacent unit therefore deals no damage, but on a hit both sides
  still roll their +2 PSRs — a strategic choice to try to knock the target down
  at the cost of your own recoil (target tonnage / 10) and fall risk. Deviation:
  TW allows charges/DFAs only against units that finished moving (pp.148–149);
  the engine lets you declare against any enemy for simplicity. House rule:
  if the target moved away the attacker advances into the vacated hex. Not
  modeled: charging buildings, displacement.
- **Deferred** — industrial-tool physical weapons and the optional Punch/Kick
  table election (+4).

### Not yet implemented

- **Building structural damage beyond CF** — basements / multi-floor
  interiors, structural-factor transfer between levels.
- **Quadripedal 'Mechs**, vehicles, infantry, battle armor.
- **Called shots**, aimed shots, spotter / indirect fire, ECM.
- **Pilot abilities** (edge, etc.), quirks, experience beyond the gunnery
  skill band.

### Not viable in this subset (blocked by explicit limits)

These piloting-adjacent rules cannot be implemented without breaking limits
stated elsewhere in this document or the codebase:

- **Displacement** (push, domino effect, skidding, charge / DFA
  displacement; TW pp.62, 147, 151-153) — intentionally not implemented, for
  simpler play (`docs/VISION.md` §2.5). There is no pavement terrain, so no
  skid roll exists.
  All falls (combat PSRs, shutdowns, stand-up attempts, building crashes,
  accidental falls from above) happen in place; only ground-movement falls
  across levels use the `levelsFallen` term (lower-hex rule). A faller
  landing on an occupied hex stays in the hex it came from, or, when another
  unit holds that hex too, in the nearest free hex it passed through.
  Charge / DFA are implemented without displacement (see above).
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

## Architecture

    web/index.html               landing page at /: links to the terminal and the avatar creator (EN/KO inline)
    web/terminal.html            terminal chrome: scrollback <pre>, prompt line, key capture
    web/avatar.html              'Mech avatar creator page (sources in web/avatar/)
    web/terminal/terminal.ts     bootstrap; wires DOM ↔ session/cli; reprints prompt after each command
    web/terminal/cli.ts          tokenizer + per-state command registry + help generator
    web/terminal/session.ts      core session state machine: setup/battle/over, RNG, atomic commit (commitAtomic),
                                 drive() phase-advance wrapper around engine gameLoop()
    web/terminal/session.common.ts  shared formatters: heat, board, info, sheet, crit chart, log events
    web/terminal/session.move.ts    movement phase: mode parsing, reachable map, place/cancel/done commit
    web/terminal/session.attack.ts  attack phase: fire/physical queues, validation, torso twist, ammo policy, resolve
    web/terminal/session.setup.ts   setup phase: map, add/set/rm units, status, start
    web/terminal/session.over.ts    over state: rematch, status, salvage
    web/terminal/rollback.ts     prompt snapshots + the `rollback` command's undo
    web/terminal/chunk.ts        structured output chunks: lines, board, columns, collapsible
    web/terminal/rng.ts          mulberry32-seeded Rng
    web/terminal/autoplay.ts     hidden `autoplay` demo driver
    web/terminal/persona*.ts     persona player (GDD §9): persona table, move/attack scoring,
                                 context + decide(), `pp` command + synchronous driver,
                                 `pp setup` random setup
    web/terminal/lookup.ts       tolerant (case-insensitive) catalog lookups
    web/terminal/query.ts        `info mech` / `info weapon` query grammar: filters, sorting, closest-name suggestions
    web/terminal/table.ts        reference-table renderers (`table` command) and the `info` listing tiers
    web/terminal/misc.ts         shared label helpers (facing, posture, weapon category)
    web/terminal/i18n/           string catalogs (`en` canonical, `ko`; `kr` aliases `ko`)
    web/terminal/render.ts       structured BoardModel / Span model + boardToText / boardToSpans
    scripts/build-web.mjs        esbuild bundles: src/index.ts → web/btlib10x.js (engine),
                                 web/terminal/terminal.ts → web/terminal.js (app; engine kept external),
                                 web/avatar/avatar.ts → web/avatar.js (avatar creator),
                                 and copies data/btlib10x.jsonl → web/btlib10x.jsonl (base catalog)
                                 plus docs/mtf/sw/sw.jsonl → web/btlib10x.sw.jsonl (SW season
                                 pack; each pack keeps its own string table), both fetched
                                 once at boot (SW failure degrades to a warning line)

Import wrinkle: tsc-emitted `.json` imports are not loadable by browsers, so the
app ships as an esbuild single-file bundle instead of consuming `dist/` directly.
Library sources stay untouched.

## Build, run, and ship

    npm install            # picks up esbuild devDependency
    npm run pack:sw        # SW season pack: docs/mtf/sw/json/*.json → docs/mtf/sw/sw.jsonl
    npm run build:web      # one-shot esbuild bundle → web/btlib10x.js + web/terminal.js + web/avatar.js (+ web/btlib10x.jsonl, web/btlib10x.sw.jsonl and web/VISION.md copies)
    npm run dev:web        # watch + serve: rebuilds on change, serves at http://127.0.0.1:8012/index.html (landing; terminal at /terminal.html)
    # custom port:  node scripts/build-web.mjs --watch --serve --port=3000
    # open http://localhost:8012

To publish the app's static output (not the npm package), run:

    npm run dist:web       # copies web/{index.html,landing.css,terminal.html,terminal.js,bt10x.css,terminal.css,btlib10x.js,btlib10x.jsonl,btlib10x.sw.jsonl,avatar.*,VISION.md,favicon.ico,fonts/} → dist/web/
    npm run dist:standalone  # dist/standalone/bt10x.html (self-contained: engine + app + both catalog packs embedded; works from file://)
    # (multi-file dist/web/ must still be served over HTTP: the app fetches btlib10x.jsonl + btlib10x.sw.jsonl at boot)
