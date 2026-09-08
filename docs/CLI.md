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
  `checkVictory()` decides: more teams alive → next turn (auto initiative roll),
  otherwise → `over`.

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
| `add <id> <model> <team> <gunnery> <col> <row> [facing]` | place unit (facing default `n`) |
| `rm <id>` | remove placed unit |
| `status` | setup summary: 'Mechs grouped by team, selected map name |
| `start` | ≥2 units on ≥2 teams required; creates battle, rolls initiative → `turn` |

### turn(N):move(team T, mech <id>)

The prompt names the acting unit; commands act on that 'Mech.

| command | effect |
|---|---|
| `mode standstill\|walk\|run\|jump` | declare movement mode (required first); for walk/run/jump, renders a clipped ASCII hex map of the reachable hexes — exactly the smallest bounding box around every reachable hex, clamped to the board (no padding). Reachable hexes draw a team-colored `<>` in the belly; every reachable (hex, facing) edge is tinted with the acting unit's team color, and no facing arrows are drawn. Other units inside the crop keep their ids (team-colored) but no facing arrow. Movement paths (the `F`/`B`/`R`/`L` fragment sequence per landing) remain available programmatically via `reachableLandings`/`RevealedLanding.path` for later use, but are not rendered on the map |
| `mode shutdown` | declare a voluntary shutdown (online unit only). `move`/`face` stay unavailable; `done` commits it — the unit goes off-line (`manual`) and can no longer move, fire, or act normally this turn. `cancel` resets the declaration |
| `mode startup` | declare a voluntary startup attempt (shut-down unit only). `done` rolls 2D6 against the heat shutdown avoidance number: success turns the unit `starting` (still off-line now, online just before the next initiative roll); failure keeps it shut down. `done` alone (without `mode startup`) passes — the unit stays off-line |
| `move <col> <row>` | queue step into adjacent hex (forward/backward vs facing; jump = any adjacent) |
| `face <facing>` or `face <±1..5>` | queue facing change (`face ne`, `face -2`) |
| `sheet [id]` | with id: armor diagram + weapons for a unit (plus the critical slot chart, which on `sheet <id>` marks per-slot live state with [J](jam) / [-](destroyed) / per-bin ammo `(n left)` markers); without id: brief unit list (id, model, position+facing) grouped by team |
| `status` | queued move steps with running MP cost per step |
| `cancel` | clear mode + steps |
| `done` | commit via `executeMove`; prints path + MP spent and total budget |

Shut-down units (including `starting`) act **first** in the movement phase,
regardless of initiative: the log prints
`{id} has movement priority — shut down, must attempt startup or pass`, and the
only move-phase commands available to them are `mode startup` (or `done` to
pass), plus `cancel`, `sheet`, `status`, `heat` and the globals.

### turn(N):attack(team T, mech <id>)

| command | effect |
|---|---|
| `ammo [policy]` | show (no argument) or set the acting unit's ammo depletion policy: `exposed` (default), `core`, `spread`, `least-first` (case-insensitive, hyphens optional). The policy picks which bin of a weapon takes the next shot; ties are broken at random |
| `fire <targetId> <weapon> [<weapon> ...]` | queue weapon declarations using 1-based weapon numbers (target first; declare several weapons at once, all against the one shared target; rapid-fire SRM/LRM fire a full volley — no `shots` argument) |
| `sheet [id]` | with id: armor diagram + weapons for a unit (plus the critical slot chart, which on `sheet <id>` marks per-slot live state with [J](jam) / [-](destroyed) / per-bin ammo `(n left)` markers); without id: brief unit list (id, model, position+facing) grouped by team |
| `status` | queued attack declarations |
| `cancel` | clear declarations |
| `done` | `declareAttacks` + `resolveDeclaredAttacks`; prints per-weapon GATOR to-hit line, dice, cluster hits, damage by location |

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
  level of elevation climbed (descent is free), and 1 MP per
  hexside of facing change. Ground moves step straight ahead or back; run
  cannot move backward; ground moves cannot climb more than one level per
  step. Jump steps into any adjacent hex at 1 MP per step, with the
  landing facing chosen freely; jump ignores elevation. Water depth-change
  movement cost is deferred (see below).
- **Line of sight** — intervening-hex line trace; light/heavy woods points
  (1/2) accumulate along the line and ≥ 3 points block. A real-valued
  "ray height" is drawn between attacker and target LOS levels (hex
  level + 1 for a bipedal 'Mech); an intervening hex blocks when its own
  LOS level meets or exceeds the ray's height at the hex's center. Water
  depth 2+ (water2/water3) blocks firing into and out of the hex
  (`blocksTargeting`).
- **To-hit (GATOR)** — gunnery + attacker movement + target movement + range
  bracket + intervening terrain + pulse + height difference; auto-hit ≤
  2, auto-miss > 12. Target-terrain modifier is data-driven
  (`terrainTargetMod`): lightWoods/heavyWoods +1/+2. Height difference:
  `−(attackerLevel − targetLevel)` (attacker higher = easier, lower =
  harder). A shut-down 'Mech (or one with both legs destroyed) is immobile
  and applies a flat −4 target modifier instead of a movement band.
  **Partial cover (TW)** — a target standing in a water1 or building hex is
  in partial cover while the attacker's ground level is not higher than the
  target's: +1 to-hit (folded into `terrainMod`) and a hit-location roll
  that lands on a leg strikes the cover instead (no damage to the target).
  A downhill attacker (higher ground level) negates the target's cover.
- **Terrain catalog** — 13 core-rulebook terrain types (`clear`, lightWoods,
  heavyWoods, rough, rubble, pavement, water1, water2, water3, and four
  building classes) defined in `src/data/terrain.json` and validated by
  `terrain.schema.ts`. Move surcharge, screening value, target modifier,
  partial-cover flag, and targeting-restriction flag all live in the catalog.
- **Buildings** — building hexes carry a structural factor (CF) initialized
  from the sub-type (light 15 / medium 40 / heavy 90 / hardened 150).
  Weapon damage that lands on a unit standing in a building hex is also
  applied to that building's CF (`damageBuildingAt`); when CF reaches 0 the
  hex collapses to rubble and a `buildingCollapsed` event fires. Unit damage
  from a collapse is deferred with piloting.
- **Hit location** — bipedal front / left side / right side / rear tables.
- **Cluster hits** — missile 2/4/5/6/10/15/20 + shot columns 2/3/4.
- **Damage** — front/rear armor transfer inward on depletion; side-torso
  internal-structure loss blows off the arm; head/CT IS death kills; leg IS
  death immobilizes. Hits on already-destroyed locations transfer.
- **Firing arc** — targets classified into front / rear / left side / right
  side arcs from the attacker's facing; each arc uses its own hit-location
  table and rear arc depletes the rear armor pool. The web fire-suggestion
  header shows the target's arc, and the attack-resolution hit line names the
  arc it resolved against.
- **Weapons** — ballistic / energy / missile with short/medium/long range
  brackets, rapid-fire, pulse (−2 to-hit), per-bin ammo tracking, jam on
  natural 2 (multi-shot), LRM lots-of-5 grouping. Ammo is depleted per
  crit slot ("bin") under a per-unit policy set with `ammo <policy>`:
  `exposed` arms → legs → side torsos → head → center torso (default),
  `core` the reverse priority, `spread` fullest-bin-first, `leastFirst`
  emptiest-first; equal-priority bins are chosen at random. Declared
  `shots` pool across all mounts and bins of a weapon name (remainder one
  per bin); `shotsLeft` is the derived per-weapon sum.
- **Battle flow** — initiative roll, sequential movement phase, weapon
  attack phase, end-phase kill sweep, victory check, rematch.
- **Critical hit table** — the official TW determining table
  (2D6: 2-7 no crit, 8-9 one, 10-11 two, 12 blow-off or three on torso) plus
  the 1D6 / 2D6 half+slot roll per location. Slot selection re-rolls on
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
  jets −1 jump each). Engine / gyro / sensor / life-support / heat-sink
  slots take and absorb crits in the slot table; destroyed engine slots
  feed the heat system below.
- **Heat** — heat scale 0-30 with movement heat, weapon heat, engine-crit
  heat, end-phase dissipation; to-hit and MP penalties; shutdown checks at
  peak heat (auto at 30+, 2D6 avoidance at 14-29) and automatic restart of
  *heat-caused* shutdowns once heat drops below the threshold; heat ammo
  explosion checks at 19+. Inert ammunition (e.g. gauss rifle rounds)
  is excluded from the heat-triggered selection and from crit-slot
  detonation; a crit on such a bin still empties it. End-phase dissipation comes from the design's
  heat sinks: the engine mounts `floor(walking × tonnage / 25)` sinks free,
  the rest occupy crit slots; double heat sinks dissipate 2 heat each and
  take 3 crits (Inner Sphere) or 2 crits (Clan) per device. Destroyed
  sink crits reduce dissipation (a DHS retires per whole device); destroyed
  engine slots add +5 heat but never retire internal sinks (strict
  Total Warfare).
- **Voluntary shutdown / startup** — `mode shutdown` + `done` sends an
  online unit off-line (`manual`); it persists (no end-phase auto-restart)
  until a voluntary startup succeeds. `mode startup` + `done` rolls 2D6
  against the shutdown avoidance: success → `starting` (still off-line,
  online just before the next initiative roll), failure → stays off-line.
  Shut-down units act first in the movement phase regardless of initiative.

### Not yet implemented

- **Physical attacks** — punch, kick, charge, DFA.
- **Piloting rolls** — falling, standing up, leg/gyro damage effects, and
  partial-cover building-CF damage on leg strikes (cover itself is
  implemented; only the building structural damage on a covered hit is
  deferred).
- **Water depth movement** — level-change MP surcharge when entering water,
  and the piloting roll to avoid falling on the way in.
- **Collapse damage** — units inside a building hex take damage when it
  collapses (only the collapse-to-rubble terrain change is implemented).
- **Torso twist** — per-weapon facing override that shifts a unit's firing
  arcs during the attack phase (currently only the positional facing is
  used).
- **Building structural damage beyond CF** — basements / multi-floor
  interiors, structural-factor transfer between levels.
- **Quadripedal 'Mechs**, vehicles, infantry, battle armor.
- **Called shots**, aimed shots, spotter / indirect fire, ECM.
- **Pilot abilities** (edge, etc.), quirks, experience beyond the gunnery
  skill band.

### Verify-later

- LOS edge-graze tie-break uses deterministic cube rounding.

## Architecture

    web/index.html      terminal chrome: scrollback <pre>, prompt line, key capture, inline CSS
    web/main.ts         bootstrap; wires DOM ↔ session/cli; reprints prompt after each command
    web/cli.ts          tokenizer + per-state command registry + help generator
    web/session.ts      app-level state machine over the in-place BattleState:
                        setup roster, move-step & attack-decl buffers,
                        derived {setup|turn|over} + sub-state,
                        auto advancePhase / initiative roll / victory check
    web/rng.ts          mulberry32-seeded Rng
    web/format.ts       board, event-log, info/status, record-sheet/resolution formatters, crit slot chart
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
